import { createMirror } from './mirror.js';
import { replacementFor } from './text-operations.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const graphemes = (text) => [...segmenter.segment(text)].length;
// A focus change this soon after typing comes from the typing itself (a suggestion list opening, the field rebuilt,
// a code's next box), not from the user moving elsewhere.
export const typingMovesFocus = 1500;
// Keys that move the PC's caret: once one went there blind, the echo no longer borders the caret.
const navigationKeys = new Set(['Left', 'Right', 'Up', 'Down', 'Home', 'End', 'PageUp', 'PageDown']);

/**
 * Where the PC's caret stands in the echo, from the text an unreadable field reports around its caret (a code
 * editor's hidden input holds the line being edited): its offset in the echo, or -1 when the echo is not there or
 * the caret is out of it.
 */
export function caretInEcho(echo, around, caret) {
    if (!echo || typeof around !== 'string' || !Number.isInteger(caret)) return -1;
    for (let at = around.indexOf(echo); at >= 0; at = around.indexOf(echo, at + 1))
        if (caret >= at && caret <= at + echo.length) return caret - at;
    return -1;
}

/**
 * The typing session (CONTEXT.md): one opening of the phone's text editor. It mirrors a readable PC field (the mirror
 * module does the editing) or types blind into one the phone cannot read, and decides what the phone shows.
 *
 * Dependencies: send(action, data) → Promise (one PC command, in order); show(view), called whenever what the phone
 * shows changes; modifiers() → the modifier keys held on the phone; notice(error) for a command that failed; now().
 *
 * The view: { open, reading, readable, blind, singleLine, kind, error, reason, field, text, selectionStart,
 * selectionEnd, keep }. kind: what the PC's field takes (email, tel, url, search, number, digits, terminal or text),
 * for the phone's keyboard. keep: the phone's field already shows this text (an echo kept while blind): leave it as it is,
 * selection included (the keyboard may be selecting in it).
 *
 * Input, from the phone's field (its text never holds anchors): edit(text, selectionStart, selectionEnd) when its text
 * or selection changed; caret(position, selected) when the keyboard moved its cursor while blind (the position counts
 * from the echo's start and can reach past it); key(name) for a key that goes to the PC as is; compositionStart()
 * and compositionEnd(text, selectionStart, selectionEnd) around an IME composition, during which the field must not be
 * written (the keyboard would commit its word again). From the app: open(), close(), poll(), connected(),
 * disconnected(), pressed(name) when a key reached the PC another way (the key rows), and clicked() after a click
 * on the PC, which may have moved its caret.
 */
export function createTypingSession({
    send,
    show,
    modifiers = () => [],
    notice = () => {},
    now = () => performance.now(),
}) {
    let state = { open: false, reading: false, readable: false, text: '', selectionStart: 0, selectionEnd: 0 };
    let online = false,
        blind = false,
        keep = false;
    // The PC field last typed into blind, while the focus stays on it, and when.
    let blindField = null,
        typedBlindAt = -Infinity;
    // What the phone's field holds (outside a composition, the keyboard's); blind, the PC's caret within the echo.
    let shown = { text: '', selectionStart: 0, selectionEnd: 0 },
        caret = 0;
    let composing = false,
        composedIn = null,
        invalidated = false;
    const mirror = createMirror(
        send,
        (next) => {
            state = next;
            publish();
        },
        { now, typingMovesFocus }
    );
    const view = () => ({
        open: state.open,
        reading: state.reading,
        readable: state.readable === true,
        blind,
        singleLine: state.readable === true && state.singleLine === true,
        kind: state.kind || 'text',
        error: state.error,
        reason: state.reason,
        field: state.field,
        ...shown,
        keep,
    });
    function publish() {
        // Typing blind: a PC field typed into blind stays so until the focus leaves it. Such a field can read as text
        // for a moment (the character just typed), and switching would wipe the phone's text, which its keyboard then
        // types again.
        if (!state.open) blindField = null;
        else if (blindField !== null && state.field !== blindField)
            blindField = now() - typedBlindAt < typingMovesFocus ? state.field : null;
        const typedHere = blindField !== null && state.field === blindField;
        const wasBlind = blind;
        blind = online && state.open && !state.reading && (!state.readable || typedHere);
        // The echo stays while the PC's focus stays where it was typed; another field starts afresh.
        keep = wasBlind && blind && typedHere;
        if (composing) {
            // The field is the keyboard's until the composition ends: only note whether the typing still applies.
            const moved = state.field !== composedIn?.field || state.session !== composedIn?.session;
            if (moved && !keep) invalidated = true;
        } else if (!keep) {
            shown = { text: state.text, selectionStart: state.selectionStart, selectionEnd: state.selectionEnd };
            caret = state.selectionStart;
        }
        show(view());
    }
    /** Moves the PC's caret by `steps` characters, one arrow key each, sent at once so typing that follows goes after. */
    function move(steps) {
        const key = steps < 0 ? 'Left' : 'Right',
            held = modifiers();
        Promise.all(Array.from({ length: Math.abs(steps) }, () => send('shortcut', { key, modifiers: held })))
            .then(() => mirror.poll())
            .catch(notice);
    }
    /**
     * Sends the difference from the echo as key presses and typed text, at the PC's caret: Backspace erases up to
     * it, Delete after it. A change elsewhere (a word the keyboard selected before the cursor and replaced) first
     * moves the PC's caret to its end.
     */
    function forward(text, position) {
        let change = replacementFor(shown.text, text, position);
        // A change that stops short of the caret, the same text between them before and after (Gboard's double-space
        // period, ". " for " ", reads as "." before the space): it reaches the caret, so the PC's caret ends up where
        // the phone's is.
        const typedEnd = change.start + change.text.length;
        if (typedEnd < position && caret - change.end === position - typedEnd)
            change = { start: change.start, end: caret, text: text.slice(change.start, position) };
        const removed = graphemes(shown.text.slice(change.start, change.end));
        // No change (a selection the keyboard made): the PC's caret has not moved.
        if (!removed && !change.text) return;
        const forwardDelete = !change.text && change.start === caret;
        const steps = forwardDelete ? 0 : change.end - caret;
        shown = { text, selectionStart: position, selectionEnd: position };
        caret = position;
        if (steps) move(steps);
        blindField = state.field ?? null;
        typedBlindAt = now();
        const data = { backspace: forwardDelete ? 0 : removed, delete: forwardDelete ? removed : 0, text: change.text };
        send('text', data).catch(notice);
    }
    /** Forgets the echo once it no longer borders the PC's caret. */
    function clearEcho() {
        if (!blind || composing) return;
        shown = { text: '', selectionStart: 0, selectionEnd: 0 };
        caret = 0;
        keep = false;
        show(view());
    }
    function edit(text, selectionStart, selectionEnd) {
        if (blind) {
            // Typed blind, a composed word goes when the keyboard commits it.
            if (!composing) forward(text, selectionStart);
            return;
        }
        // A PC field that changed during the composition does not take it (compositionEnd shows the PC's text).
        if (invalidated) return;
        // previous: the text this typing went over, which the PC's text may have replaced meanwhile (it is not
        // written during a composition).
        const previous = shown.text;
        shown = { text, selectionStart, selectionEnd };
        mirror.input(text, selectionStart, selectionEnd, previous);
    }
    /** After a key went to the PC: moving its caret (or leaving the line) blind leaves the echo behind. */
    function pressed(name) {
        if (navigationKeys.has(name) || name === 'Enter') clearEcho();
    }
    return {
        open: () => mirror.open(),
        close: () => mirror.close(),
        poll: () => mirror.poll(),
        connected() {
            online = true;
            return mirror.poll();
        },
        disconnected() {
            online = false;
            mirror.disconnected();
        },
        edit,
        caret(position, selected) {
            // A selection (the keyboard selecting words to delete) goes once deleted, as the keys erasing it.
            if (!blind || composing || selected) return;
            const steps = position - caret;
            if (!steps) return;
            move(steps);
            // Past the echo, the phone no longer knows what borders the PC's caret: it starts afresh.
            if (position < 0 || position > shown.text.length) return clearEcho();
            caret = position;
            shown = { ...shown, selectionStart: position, selectionEnd: position };
        },
        key(name) {
            send('shortcut', { key: name, modifiers: modifiers() })
                .then(() => mirror.poll())
                .catch(notice);
            pressed(name);
        },
        pressed(name) {
            pressed(name);
            mirror.poll();
        },
        clicked() {
            if (!blind || !shown.text || composing) return mirror.poll();
            // Without anything reported around the caret, nothing tells where the click put it: the echo goes.
            if (typeof state.around !== 'string') {
                clearEcho();
                return mirror.poll();
            }
            // A read of its own, sent after the click: a poll could still be on its way from before it.
            const field = state.field,
                echo = shown.text;
            return send('mirror-read', {})
                .then((read) => {
                    // The focus moved, the field turned readable or typing went on: those follow their own course.
                    if (!blind || composing || read.readable || read.field !== field || shown.text !== echo) return;
                    // Into the echo, the phone's caret follows the PC's; anywhere else, the echo no longer borders it.
                    const at = caretInEcho(echo, read.around, read.caret);
                    if (at < 0) return clearEcho();
                    caret = at;
                    shown = { ...shown, selectionStart: at, selectionEnd: at };
                    keep = false;
                    show(view());
                })
                .catch(notice)
                .finally(() => mirror.poll());
        },
        compositionStart() {
            composing = true;
            invalidated = false;
            composedIn = { field: state.field, session: state.session };
            mirror.compose(true);
        },
        compositionEnd(text, selectionStart, selectionEnd) {
            composing = false;
            if (invalidated) {
                invalidated = false;
                publish();
            } else edit(text, selectionStart, selectionEnd);
            mirror.compose(false);
        },
    };
}
