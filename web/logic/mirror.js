import { nextReplacementStep, replacementFor } from './text-operations.js';

/**
 * The caret or selection around whole inline objects (objects: [start, end] of each, from the PC: an emoji image, shown
 * as its emoji or a custom one by its name): the PC's caret stops only at their edges. A caret never lands inside one:
 * moving (the keyboard's space-bar cursor: moving, or one step from an edge) it goes to the edge it moves toward,
 * otherwise (a tap) to the nearer edge, and `tapped` tells it landed inside. A selection edge inside one takes in all of
 * it, as a selection does a character. previous: the selection before, [start, end]. Answers [start, end, tapped].
 */
export function coverObjects(objects = [], selectionStart, selectionEnd, previous = null, moving = false) {
    for (const [start, end] of objects) {
        const inside = (position) => position > start && position < end;
        if (selectionStart === selectionEnd && inside(selectionStart)) {
            const [from, to] = previous ?? [];
            const stepped = from === to && (from === start || from === end) && Math.abs(selectionStart - from) === 1;
            if ((moving || stepped) && from !== undefined)
                return selectionStart > from ? [end, end, false] : [start, start, false];
            return selectionStart - start <= end - selectionStart ? [start, start, true] : [end, end, true];
        }
        if (inside(selectionStart)) selectionStart = start;
        if (inside(selectionEnd)) selectionEnd = end;
    }
    return [selectionStart, selectionEnd, false];
}

/**
 * The mirror (CONTEXT.md) of a readable PC field: the phone's edits go to the PC, the PC's changes come back.
 * send(action, data) → Promise; render(state) on every change. now() and typingMovesFocus (ms): a focus change this
 * soon after the PC took typing comes from that typing (see the typing session). tappedName(): a tap landed in a
 * custom emoji's name, which the caret left for one of its sides.
 */
export function createMirror(
    send,
    render,
    { now = () => performance.now(), typingMovesFocus = 1500, tappedName = () => {} } = {}
) {
    // reading: open, the PC's field not read yet (nothing is known about it, so nothing is reported missing either).
    let state = { open: false, reading: false, readable: false, text: '', selectionStart: 0, selectionEnd: 0 };
    let confirmed = null,
        busy = false,
        composing = false,
        dirty = false,
        retried = false,
        generation = 0,
        // When the PC last took typing: a focus change soon after comes from that typing (a code's next box).
        typedAt = -Infinity,
        // When the phone's caret last moved alone: moves this close together are the space-bar cursor sliding.
        caretMovedAt = -Infinity;
    /** A replay without key presses: the typing only (see replay). */
    const typingOnly = (before, typed, target) => {
        const { backspaces, ...rest } = replay(before, typed, target) || {};
        return 'text' in rest ? rest : null;
    };
    const publish = () => render({ ...state });
    // Nothing is known of the field: no text from an earlier one may show (typing blind would add to it).
    const unknown = { text: '', selectionStart: 0, selectionEnd: 0, objects: [] };
    /** Takes the PC's state; pending: local typing still to send on top of it (see replay). */
    function adopt(snapshot, pending = null) {
        confirmed = snapshot;
        dirty = pending !== null;
        retried = false;
        state = {
            ...state,
            ...snapshot,
            reading: false,
            error: '',
            text: snapshot.text || '',
            kind: snapshot.kind || 'text',
            selectionStart: snapshot.selectionStart || 0,
            selectionEnd: snapshot.selectionEnd || 0,
            objects: snapshot.objects || [],
            ...pending,
        };
        publish();
    }
    /**
     * The typing that turned `before` into `typed` (text and caret), replayed at the caret of `target`, as the keyboard
     * would have typed it there: the characters removed before the caret and those inserted. Null when there is none,
     * or the change is not typing that ends at the caret (an autocorrection of an earlier word). `backspaces`: how many
     * of the removed characters reach past the start of the field (Backspace in an empty field).
     */
    function replay(before, typed, target) {
        if (!target.readable || typed.text === before) return null;
        const change = replacementFor(before, typed.text, typed.selectionStart);
        if (change.start + change.text.length !== typed.selectionStart) return null;
        const removed = change.end - change.start;
        // A selection on the PC (a completion) goes first, like typing over it.
        const selected = target.selectionEnd > target.selectionStart;
        const from = Math.max(0, target.selectionStart - (selected ? Math.max(0, removed - 1) : removed));
        const caret = from + change.text.length;
        return {
            text: target.text.slice(0, from) + change.text + target.text.slice(target.selectionEnd),
            selectionStart: caret,
            selectionEnd: caret,
            backspaces: selected ? 0 : Math.max(0, removed - target.selectionStart),
        };
    }
    /**
     * Typing over the PC's selection (a completion an address bar selected) replaces that selection, typed there as a
     * keyboard would, so the field completes again: not a deletion of what follows the common start.
     */
    function typedOverSelection(pc, local) {
        const { selectionStart: start, selectionEnd: end, text } = pc;
        if (end <= start || local.text === text || local.selectionStart !== local.selectionEnd) return null;
        const head = text.slice(0, start),
            tail = text.slice(end),
            typedEnd = local.text.length - tail.length;
        if (typedEnd < start || local.selectionStart !== typedEnd) return null;
        if (!local.text.startsWith(head) || !local.text.endsWith(tail)) return null;
        const typed = local.text.slice(start, typedEnd);
        if (typed.length > 16_384) return null;
        return { start, end, text: typed, position: typedEnd, resultText: local.text };
    }
    async function flush() {
        if (!state.open || !state.readable || busy || composing || !dirty) return;
        const current = generation;
        const local = { ...state };
        const step =
            typedOverSelection(confirmed, local)
            ?? nextReplacementStep(confirmed.text, local.text, local.selectionStart);
        const final = step.resultText === local.text;
        busy = true;
        dirty = false;
        try {
            const result = await send('mirror-edit', {
                session: confirmed.session,
                revision: confirmed.revision,
                operationId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                start: step.start,
                end: step.end,
                text: step.text,
                selectionStart: final ? local.selectionStart : step.position,
                selectionEnd: final ? local.selectionEnd : step.position,
            });
            if (current !== generation) return;
            const movedOn = result.snapshot.session !== confirmed.session;
            const moved = movedOn || result.snapshot.text !== confirmed.text;
            const followsTyping = now() - typedAt < typingMovesFocus;
            if (result.typed || (result.accepted && step.text !== confirmed.text.slice(step.start, step.end)))
                typedAt = now();
            if (!result.accepted && !result.typed && !moved && !retried) {
                // Rejected for a newer revision only (the PC moved its caret, the text is as it was): the typing
                // still applies, so it is sent again against that revision instead of being dropped.
                retried = true;
                confirmed = result.snapshot;
                dirty = true;
            } else if (!result.accepted || result.snapshot.session !== confirmed.session) {
                // Typed, but the field made something else of it (an input mask, a case change, a completion, the
                // focus moving on): its text wins, and what was typed on the phone meanwhile follows at its caret.
                // Not typed because the focus had already moved on, right after typing (the field moved it): the
                // typing goes where the focus went, as on a keyboard. Moved on otherwise (the user went elsewhere):
                // it is dropped.
                const since =
                    result.typed ? local.text
                    : movedOn && followsTyping ? confirmed.text
                    : null;
                const { backspaces = 0, ...pending } =
                    (since !== null && final && replay(since, state, result.snapshot)) || {};
                // Only in another field: within the same one, an erasure the PC's text cannot hold is no key to press.
                if (!backspaces || result.snapshot.session === confirmed.session)
                    adopt(result.snapshot, 'text' in pending ? pending : null);
                else {
                    // Erased past the start of the field typing reached (a code's next box): Backspace goes to the
                    // PC as a key, which such fields answer themselves (back to the previous box), then it is reread.
                    const before = state.text;
                    for (let count = 0; count < backspaces; count++)
                        await send('shortcut', { key: 'Backspace', modifiers: [] });
                    typedAt = now();
                    const snapshot = await send('mirror-read', {});
                    if (current !== generation) return;
                    // What was typed meanwhile follows in the field the keys led to.
                    adopt(snapshot, typingOnly(before, state, snapshot));
                }
            } else {
                retried = false;
                confirmed = result.snapshot;
                // The phone's caret stays where it is: the PC can report its own late (Chromium), and a caret the
                // keyboard is moving would jump back. Every edit places the PC's caret where the phone's is anyway.
                if (!dirty && final && confirmed.text === local.text)
                    adopt({ ...confirmed, selectionStart: local.selectionStart, selectionEnd: local.selectionEnd });
                else if (!dirty && final) adopt(confirmed);
                else dirty = true;
            }
        } catch (error) {
            if (current !== generation) return;
            state = { ...state, ...unknown, readable: false, error: error.message };
            dirty = false;
            // Forget the confirmed snapshot so the next poll rereads the PC instead of hearing "unchanged".
            confirmed = null;
            publish();
        } finally {
            if (current === generation) {
                busy = false;
                flush();
            }
        }
    }
    // Never while local typing waits to be sent (an IME composition included): the PC's state would replace it.
    async function poll() {
        if (!state.open || busy || dirty) return;
        const current = generation;
        busy = true;
        try {
            const snapshot = await send('mirror-read', { session: confirmed?.session, revision: confirmed?.revision });
            if (current !== generation) return;
            if (snapshot.unchanged) return;
            // The phone moved or typed while the read was on its way (a caret stepping along the space bar): the
            // read is older than that, so it overwrites nothing; the change goes out next (flush), against the PC's
            // newer revision if it moved meanwhile.
            if (dirty) return;
            if (
                !confirmed
                || snapshot.session !== confirmed.session
                || snapshot.revision !== confirmed.revision
                || snapshot.readable !== confirmed.readable
                || snapshot.field !== confirmed.field
                // An unreadable field's caret, in what it reports around it (the typing session follows clicks).
                || snapshot.caret !== confirmed.caret
                || snapshot.around !== confirmed.around
            )
                adopt(snapshot);
        } catch (error) {
            if (current === generation) {
                state = { ...state, ...unknown, readable: false, reading: false, error: error.message };
                confirmed = null;
                publish();
            }
        } finally {
            if (current === generation) {
                busy = false;
                flush();
            }
        }
    }
    return {
        open() {
            generation++;
            busy = false;
            dirty = false;
            confirmed = null;
            // A fresh start: an error from before (a disconnection) no longer applies.
            state = { ...state, ...unknown, open: true, reading: true, error: '' };
            publish();
            return poll();
        },
        close() {
            generation++;
            busy = false;
            dirty = false;
            composing = false;
            state.open = false;
            state.reading = false;
            state.readable = false;
            publish();
            send('mirror-close').catch(() => {});
        },
        /**
         * The phone's text and caret after typing. `previous`: the text it typed over. When the PC's text replaced
         * it meanwhile (it arrived during an IME composition, which the editor does not interrupt), only the typing
         * applies, at the PC's caret: the phone's stale text never overwrites the PC's.
         */
        input(text, selectionStart, selectionEnd, previous = state.text) {
            if (!state.readable) return;
            // Nothing new (the caret reported where it already is): nothing to send.
            const same =
                previous === state.text
                && text === state.text
                && selectionStart === state.selectionStart
                && selectionEnd === state.selectionEnd;
            if (same) return;
            // A caret moved into an emoji goes to one of its sides (coverObjects): the phone's field shows it at once. A
            // tap in a custom one's name (":party:") tells why it went there.
            let covered = false;
            if (previous === state.text && text === state.text) {
                const moving = now() - caretMovedAt < 400;
                caretMovedAt = now();
                const [start, end, tapped] = coverObjects(
                    state.objects,
                    selectionStart,
                    selectionEnd,
                    [state.selectionStart, state.selectionEnd],
                    moving
                );
                if (tapped) {
                    const [from, to] = state.objects.find(([from, to]) => from === start || to === start);
                    if (/^:.+:$/.test(state.text.slice(from, to))) tappedName();
                }
                covered = start !== selectionStart || end !== selectionEnd;
                [selectionStart, selectionEnd] = [start, end];
            }
            const { backspaces, ...replayed } =
                (previous !== state.text && replay(previous, { text, selectionStart }, state)) || {};
            state = { ...state, ...('text' in replayed ? replayed : { text, selectionStart, selectionEnd }) };
            dirty = true;
            if ('text' in replayed || covered) publish();
            flush();
        },
        compose(value) {
            composing = value;
            if (!value) flush();
        },
        poll,
        disconnected() {
            generation++;
            busy = false;
            dirty = false;
            confirmed = null;
            state = { ...state, ...unknown, readable: false, reading: false, error: 'PC disconnected' };
            publish();
        },
    };
}
