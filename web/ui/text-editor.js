// The phone's text field, as the typing session (logic/typing-session.js) sees it: text and selection without the
// anchors, keys, the keyboard's cursor moves and IME compositions. It shows what the session's views say and decides
// nothing about typing itself.
//
// Anchors (docs/adr/0001): a zero-width space before the mirrored text keeps a character behind the caret, so mobile
// keyboards report Backspace even when the field is empty; typing blind, a run of them on each side of the echo lets
// the keyboard's cursor (Gboard's space bar drag) move past it. Deleting one is a Backspace or Delete key on the PC,
// moving through them a caret move.
const anchor = String.fromCharCode(0x200b);
const margin = 32;
// Keys that never change the local text; they are always sent to the PC.
const forwardedKeys = { Escape: 'Escape', Tab: 'Tab' };
// Typing blind, the local caret has no meaning, so navigation goes to the PC too.
const blindKeys = {
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Delete: 'Delete',
};
// With a modifier held on the key rows, the keyboard's input is a shortcut: these inputs, or a letter.
const shortcutInputs = {
    deleteContentBackward: 'Backspace',
    deleteContentForward: 'Delete',
    insertLineBreak: 'Enter',
    insertParagraph: 'Enter',
};

const sizesItself = CSS.supports('field-sizing', 'content');
// The phone's keyboard for each kind of PC field (typing-session.js): its layout, what it may fill in (null: nothing in
// particular), and whether it capitalizes and checks spelling.
const keyboards = {
    text: { inputMode: 'text', autocomplete: null, autocapitalize: 'sentences', spellcheck: true },
    email: { inputMode: 'email', autocomplete: 'email', autocapitalize: 'none', spellcheck: false },
    tel: { inputMode: 'tel', autocomplete: 'tel', autocapitalize: 'none', spellcheck: false },
    url: { inputMode: 'url', autocomplete: 'url', autocapitalize: 'none', spellcheck: false },
    search: { inputMode: 'search', autocomplete: null, autocapitalize: 'sentences', spellcheck: true },
    number: { inputMode: 'decimal', autocomplete: null, autocapitalize: 'none', spellcheck: false },
    digits: { inputMode: 'numeric', autocomplete: null, autocapitalize: 'none', spellcheck: false },
    terminal: { inputMode: 'text', autocomplete: null, autocapitalize: 'none', spellcheck: false },
};

class TextEditor extends HTMLElement {
    /** The session's latest view. */
    view = { readable: false, blind: false, singleLine: false, text: '', selectionStart: 0, selectionEnd: 0 };
    /** The modifier keys held on the key rows (set by the app): with one held, typing makes shortcuts. */
    heldModifiers = () => [];
    /**
     * The Keyboard options (set by the app): capitalize, the keyboard starting sentences with a capital where the field
     * allows it; matchField, the keyboard following the PC's field (an email field's, a number pad), or the plain one.
     */
    keyboardOptions = { capitalize: true, matchField: true };
    connectedCallback() {
        if (this.firstChild) return;
        this.innerHTML =
            '<textarea id="editor-text" rows="1" aria-label="PC text field" spellcheck="true" autocapitalize="sentences"></textarea><span class="editor-hint" aria-hidden="true">Cannot retrieve text here. Start typing to edit</span>';
        const textarea = this.firstElementChild;
        textarea.value = this.written = anchor;
        this.writtenLead = 1;
        this.writtenPads = 1;
        this.composing = false;
        const emit = (name, detail) => this.dispatchEvent(new CustomEvent(name, { bubbles: true, detail }));
        // The text and selection without the anchors, read as they were written: one anchor before the PC's text
        // (which may hold zero-width spaces of its own), anchors only around the echo.
        const read = () => {
            const raw = textarea.value;
            if (this.writtenLead > 1) {
                const strip = (part) => part.replaceAll(anchor, '');
                return {
                    at: 0,
                    pads: raw.length - strip(raw).length,
                    lead: raw.length - raw.replace(/^​+/, '').length,
                    text: strip(raw),
                    start: strip(raw.slice(0, textarea.selectionStart)).length,
                    end: strip(raw.slice(0, textarea.selectionEnd)).length,
                };
            }
            const at = raw.indexOf(anchor);
            const shift = (position) => (at >= 0 && position > at ? position - 1 : position);
            return {
                at,
                text: at < 0 ? raw : raw.slice(0, at) + raw.slice(at + 1),
                start: shift(textarea.selectionStart),
                end: shift(textarea.selectionEnd),
            };
        };
        const input = () => {
            const { at, pads, lead, text, start, end } = read();
            // An anchor deleted, the text as it was: the key went past the text the phone has. One at a time (a key
            // press): a keyboard deleting a selection that reaches into them only deletes the text in it.
            const erased = pads === undefined ? Number(at < 0) : this.writtenPads - pads;
            const unchanged = text === this.written.replaceAll(anchor, '');
            if (!this.composing && textarea.value !== this.layout(text)) this.write(text, start, end);
            else {
                // What the field holds now is the layout the caret is followed in (see followCaret).
                this.written = textarea.value;
                this.writtenPads = textarea.value.length - text.length;
            }
            if (unchanged && erased > 0) {
                const forward = pads !== undefined && lead === this.writtenLead;
                if (erased === 1) emit('text-key', { key: forward ? 'Delete' : 'Backspace' });
            } else emit('text-edit', { text, start, end });
            this.resize();
            this.updateHint();
        };
        textarea.addEventListener('beforeinput', (event) => {
            // With a modifier held on the key rows, the input is a shortcut (Ctrl+Backspace, Ctrl+A).
            if (!event.isComposing && this.heldModifiers().some((key) => ['Control', 'Alt', 'Win'].includes(key))) {
                const key =
                    shortcutInputs[event.inputType]
                    || (event.data === ' ' ? 'Space'
                    : /^[a-z]$/i.test(event.data || '') ? event.data.toUpperCase()
                    : null);
                if (key) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    return emit('text-key', { key });
                }
            }
            // Phone keyboards often skip the Enter keydown: the line break they insert is the Enter key, too.
            if (!['insertLineBreak', 'insertParagraph'].includes(event.inputType) || !this.submits()) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            emit('text-key', { key: 'Enter' });
        });
        textarea.addEventListener('input', input);
        textarea.addEventListener('select', () => {
            // A selection placed by render() is the PC's own caret, not an edit to send back.
            if (textarea.selectionStart === this.writtenStart && textarea.selectionEnd === this.writtenEnd) return;
            input();
        });
        // The keyboard moving its cursor (Gboard: dragging on the space bar): blind, the session moves the PC's
        // caret; in a readable field, a new selection to mirror.
        const followCaret = () => {
            if (textarea.value !== this.written) return;
            const { selectionStart: from, selectionEnd: to } = textarea;
            if (this.view.blind)
                return emit('text-caret', { position: from - this.writtenLead, selected: from !== to });
            if (from === this.writtenStart && to === this.writtenEnd) return;
            input();
        };
        textarea.addEventListener('keydown', (event) => {
            if (event.isComposing || event.keyCode === 229) return;
            const { start, end, text } = read();
            const key =
                forwardedKeys[event.key]
                || (this.view.blind && blindKeys[event.key])
                || (event.key === 'Backspace' && textarea.selectionStart === 0 && textarea.selectionEnd === 0 ?
                    'Backspace'
                :   null)
                || (event.key === 'Delete' && start === end && end === text.length ? 'Delete' : null)
                || (event.key === 'Enter' && this.submits() ? 'Enter' : null);
            if (!key) return;
            event.preventDefault();
            emit('text-key', { key });
        });
        document.addEventListener('selectionchange', () => {
            if (document.activeElement !== textarea || this.composing) return;
            // Keep the caret after the anchor so Backspace always has something to delete. Only a caret: a selection
            // reaching it (select all) stays as it is, or the phone would close its copy menu.
            const atAnchor = textarea.selectionStart === 0 && textarea.selectionEnd === 0;
            if (!this.view.blind && atAnchor && textarea.value.startsWith(anchor)) textarea.setSelectionRange(1, 1);
            else followCaret();
        });
        // Copying or cutting never takes the anchors along (a select all reaches the one before the text).
        for (const type of ['copy', 'cut'])
            textarea.addEventListener(type, (event) => {
                const { text, start, end } = read();
                const selected = text.slice(start, end);
                if (selected === textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)) return;
                event.preventDefault();
                event.clipboardData.setData('text/plain', selected);
                // Removed as a deletion of the selection would be (an input event the session follows).
                if (type === 'cut') document.execCommand('delete');
            });
        textarea.addEventListener('compositionstart', () => {
            this.composing = true;
            this.updateHint();
            emit('text-composition', { composing: true });
        });
        // The views that arrived during the composition were not written: the session shows what applies now (the
        // field as the keyboard left it, unless the PC's text or focus changed meanwhile).
        textarea.addEventListener('compositionend', () => {
            this.composing = false;
            const { text, start, end } = read();
            emit('text-composition', { composing: false, text, start, end });
        });
    }
    /**
     * The keyboard's Enter key presses Enter (search, submit, run) where a new line cannot be mirrored: a PC field
     * that holds one line (a search box, an <input>), or one the phone cannot read (typing blind). Only in a
     * readable multi-line field does it add a line, never sending a message by mistake.
     */
    submits() {
        return this.view.blind || this.view.singleLine;
    }
    /** The field's own placeholder cannot show behind the anchor, so blind typing gets an overlay hint. */
    updateHint() {
        const empty = this.firstElementChild.value.replaceAll(anchor, '') === '';
        this.classList.toggle('show-hint', this.view.blind && empty && !this.composing);
    }
    /** The field's value for `text`: the anchor before the PC's text, or the anchors around the echo. */
    layout(text) {
        return this.view.blind ? anchor.repeat(margin) + text + anchor.repeat(margin) : anchor + text;
    }
    write(text, start, end) {
        const field = this.firstElementChild;
        const value = this.layout(text),
            lead = this.view.blind ? margin : 1;
        // A selection that differs only by the anchor before the text (select all) is the same: placing it again
        // would close the phone's copy menu.
        const shown = (position) => Math.min(Math.max(position - lead, 0), text.length);
        const same =
            field.value === value
            && !this.view.blind
            && shown(field.selectionStart) === start
            && shown(field.selectionEnd) === end;
        // Writing the value or the selection scrolls the field to show the caret, its last line flush with the bottom
        // edge: a field scrolled to its end, caret at the end, stays at its end, its bottom padding included.
        const atEnd = field.scrollTop + field.clientHeight >= field.scrollHeight - 1;
        if (field.value !== value) field.value = value;
        if (!same && (field.selectionStart !== start + lead || field.selectionEnd !== end + lead))
            field.setSelectionRange(start + lead, end + lead);
        if (atEnd && end === text.length) field.scrollTop = field.scrollHeight;
        this.written = value;
        this.writtenLead = lead;
        this.writtenPads = value.length - text.length;
        this.writtenStart = field.selectionStart;
        this.writtenEnd = field.selectionEnd;
    }
    /** The field grows with its text through CSS field-sizing; this measures it where that is unsupported (Firefox). */
    resize() {
        if (sizesItself) return;
        const field = this.firstElementChild;
        field.style.height = 'auto';
        const borders = field.offsetHeight - field.clientHeight;
        field.style.height = `${(field.scrollHeight + borders) / parseFloat(getComputedStyle(document.documentElement).fontSize)}rem`;
    }
    /**
     * Shows a session view. During an IME composition the field is the keyboard's (writing into it makes the
     * keyboard commit its word again): only the state applies, the text waits for the composition's end. A view that
     * keeps the echo leaves the field as it is, the keyboard's selection included.
     */
    render(view) {
        this.view = view;
        const field = this.firstElementChild,
            kind = this.keyboardOptions.matchField ? view.kind : 'text',
            keyboard = keyboards[kind] ?? keyboards.text,
            capitalize = this.keyboardOptions.capitalize ? keyboard.autocapitalize : 'none';
        // The keyboard's Enter key shows what it does: an action where it presses Enter (a search), a new line
        // elsewhere.
        const enter =
            !this.submits() ? 'enter'
            : kind === 'search' ? 'search'
            : 'go';
        if (field.enterKeyHint !== enter) field.enterKeyHint = enter;
        // The keyboard the PC's field calls for; written only when it changes (the keyboard restarts each time).
        if (field.inputMode !== keyboard.inputMode) field.inputMode = keyboard.inputMode;
        if (field.getAttribute('autocomplete') !== keyboard.autocomplete)
            if (keyboard.autocomplete) field.setAttribute('autocomplete', keyboard.autocomplete);
            else field.removeAttribute('autocomplete');
        if (field.getAttribute('autocapitalize') !== capitalize) field.setAttribute('autocapitalize', capitalize);
        if (field.spellcheck !== keyboard.spellcheck) field.spellcheck = keyboard.spellcheck;
        if (!this.composing && !view.keep) this.write(view.text, view.selectionStart, view.selectionEnd);
        this.resize();
        this.updateHint();
    }
    focus() {
        this.firstElementChild.focus({ preventScroll: true });
    }
    blur() {
        this.firstElementChild.blur();
    }
}
customElements.define('text-editor', TextEditor);
