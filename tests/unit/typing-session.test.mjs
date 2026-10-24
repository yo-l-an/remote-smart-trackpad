import test from 'node:test';
import assert from 'node:assert/strict';
import { createTypingSession, typingMovesFocus } from '../../web/logic/typing-session.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const unreadable = (field) => ({ readable: false, text: '', field });
const readable = (text, field = 'field-a', session = `${field}-session`, revision = 0) => ({
    readable: true,
    field,
    session,
    revision,
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
});
/**
 * A session whose PC answers reads with `pc` (a PC field state), edits by applying them unless the focus moved (or,
 * holding edits, when the test answers them), and every other command with success.
 */
function harness() {
    const sent = [],
        views = [];
    let clock = 0,
        pc = unreadable('zone-a');
    const held = [];
    let holding = false;
    const send = (action, data) => {
        sent.push({ action, data });
        if (action === 'mirror-read') return Promise.resolve(pc);
        if (action === 'mirror-edit') {
            if (holding) return new Promise((resolve) => held.push(resolve));
            if (data.session !== pc.session) return Promise.resolve({ accepted: false, snapshot: pc });
            const text = pc.text.slice(0, data.start) + data.text + pc.text.slice(data.end);
            pc = {
                ...pc,
                text,
                revision: pc.revision + 1,
                selectionStart: data.selectionStart,
                selectionEnd: data.selectionEnd,
            };
            return Promise.resolve({ accepted: true, snapshot: pc });
        }
        return Promise.resolve({});
    };
    const session = createTypingSession({ send, show: (view) => views.push(view), now: () => clock });
    return {
        session,
        sent,
        views,
        hold: () => (holding = true),
        /** Answers the oldest held edit. */
        async answer(reply) {
            holding = false;
            held.shift()(reply);
            await flush();
        },
        get view() {
            return views.at(-1);
        },
        get pc() {
            return pc;
        },
        set pc(value) {
            pc = value;
        },
        tick: (ms) => (clock += ms),
        /** The PC commands sent, but reads. */
        typed: () => sent.filter(({ action }) => action !== 'mirror-read' && action !== 'mirror-close'),
        async open() {
            session.connected();
            session.open();
            await flush();
        },
        async poll() {
            await session.poll();
            await flush();
        },
    };
}

test('typing blind sends the difference as text and keys, and keeps it on the phone', async () => {
    const h = harness();
    await h.open();
    assert.equal(h.view.blind, true);
    h.session.edit('hel', 3, 3);
    h.session.edit('hello', 5, 5);
    h.session.edit('hell', 4, 4);
    assert.deepEqual(
        h.typed().map(({ data }) => data),
        [
            { backspace: 0, delete: 0, text: 'hel' },
            { backspace: 0, delete: 0, text: 'lo' },
            { backspace: 1, delete: 0, text: '' },
        ]
    );
    // Gboard's double-space period turns the space into ". ": the space erased, ". " typed, the PC's caret after it.
    h.session.edit('hell ', 5, 5);
    h.session.edit('hell. ', 6, 6);
    assert.deepEqual(h.typed().at(-1).data, { backspace: 1, delete: 0, text: '. ' });
    assert.ok(!h.typed().some(({ action }) => action === 'shortcut'));
    // The PC field reads the same: nothing is shown anew, the echo stays as the phone shows it.
    const shown = h.views.length;
    await h.poll();
    assert.equal(h.views.length, shown);
});

test('the echo stays when typing moves the focus, and clears when the user moves on', async () => {
    const h = harness();
    await h.open();
    h.session.edit('h', 1, 1);
    // The typing opened a suggestion list: another field, right after typing.
    h.pc = unreadable('zone-a-suggestions');
    await h.poll();
    assert.equal(h.view.text, 'h');
    // Long after, the focus moves elsewhere.
    h.tick(typingMovesFocus + 1);
    h.pc = unreadable('zone-b');
    await h.poll();
    assert.equal(h.view.text, '');
    assert.equal(h.typed().length, 1, 'the typing is sent once');
});

test('a field typed into blind stays blind when it reads as text for a moment', async () => {
    const h = harness();
    await h.open();
    h.session.edit('h', 1, 1);
    h.pc = readable('h', 'zone-a');
    await h.poll();
    assert.equal(h.view.blind, true);
    assert.equal(h.view.text, 'h');
});

test('the keyboard moving its cursor moves the PC caret, past the echo too', async () => {
    const h = harness();
    await h.open();
    h.session.edit('hello world', 11, 11);
    h.session.caret(5, false);
    const moves = () =>
        h
            .typed()
            .filter(({ action }) => action === 'shortcut')
            .map(({ data }) => data.key);
    assert.deepEqual(moves(), ['Left', 'Left', 'Left', 'Left', 'Left', 'Left']);
    // Typing there inserts at the PC's caret.
    h.session.edit('hello, world', 6, 6);
    assert.deepEqual(h.typed().at(-1).data, { backspace: 0, delete: 0, text: ',' });
    // Past the echo's start: the phone starts afresh, the PC's caret moved on.
    h.session.caret(-2, false);
    assert.equal(moves().length, 6 + 8);
    assert.equal(h.view.text, '');
});

test("a selection the keyboard made is erased with Backspaces from the PC's caret", async () => {
    const h = harness();
    await h.open();
    h.session.edit('hello big world', 15, 15);
    // Gboard's Backspace swipe: the selection moves nothing on the PC.
    h.session.caret(10, true);
    h.session.edit('hello big world', 10, 15);
    h.session.edit('hello big ', 10, 10);
    assert.deepEqual(h.typed().at(-1).data, { backspace: 5, delete: 0, text: '' });
    assert.equal(h.typed().filter(({ action }) => action === 'shortcut').length, 0);
});

test('Enter or an arrow key typed blind clears the echo', async () => {
    const h = harness();
    await h.open();
    h.session.edit('one', 3, 3);
    h.session.key('Enter');
    assert.equal(h.view.text, '');
    h.session.edit('two', 3, 3);
    h.session.pressed('Left');
    assert.equal(h.view.text, '');
    assert.deepEqual(
        h
            .typed()
            .filter(({ action }) => action === 'shortcut')
            .map(({ data }) => data.key),
        ['Enter']
    );
});

test('a composed word goes blind when committed, not while composing', async () => {
    const h = harness();
    await h.open();
    h.session.compositionStart();
    h.session.edit('hel', 3, 3);
    h.session.edit('hello', 5, 5);
    assert.equal(h.typed().length, 0);
    h.session.compositionEnd('hello', 5, 5);
    assert.deepEqual(h.typed().at(-1).data, { backspace: 0, delete: 0, text: 'hello' });
});

test('a PC answer arriving during a composition is not shown; the typing follows on top of it', async () => {
    const h = harness();
    h.pc = readable('');
    await h.open();
    h.hold();
    h.session.edit('hello', 5, 5);
    h.session.compositionStart();
    h.session.edit('hello wor', 9, 9);
    // The field made the first word upper case; the keyboard is still composing.
    h.pc = readable('HELLO', 'field-a', 'field-a-session', 1);
    await h.answer({ accepted: false, typed: true, snapshot: h.pc });
    assert.equal(h.view.text, 'hello wor', "the keyboard's field is left alone");
    h.session.compositionEnd('hello world', 11, 11);
    await flush();
    assert.equal(h.view.text, 'HELLO world');
});

test('a composition whose PC field changed meanwhile is dropped', async () => {
    const h = harness();
    h.pc = readable('hi');
    await h.open();
    h.session.compositionStart();
    h.session.edit('hi wor', 6, 6);
    h.pc = readable('other', 'field-b');
    h.session.compositionEnd('hi world', 8, 8);
    await flush();
    await flush();
    assert.equal(h.view.text, 'other');
    assert.equal(h.pc.text, 'other', 'nothing typed into the other field');
});

test('a readable field is mirrored: the edit goes to the PC once the composition ends', async () => {
    const h = harness();
    h.pc = readable('hi');
    await h.open();
    assert.equal(h.view.blind, false);
    h.session.compositionStart();
    h.session.edit('hi wor', 6, 6);
    assert.equal(h.typed().length, 0);
    h.session.compositionEnd('hi world', 8, 8);
    await flush();
    const edit = h.typed().find(({ action }) => action === 'mirror-edit');
    assert.deepEqual(
        { start: edit.data.start, end: edit.data.end, text: edit.data.text },
        { start: 2, end: 2, text: ' world' }
    );
});

test('disconnected, the phone never types blind', async () => {
    const h = harness();
    await h.open();
    h.session.disconnected();
    assert.equal(h.view.blind, false);
});

test('a click into the text typed blind moves the phone caret there; typing goes on there', async () => {
    const h = harness();
    h.pc = { ...unreadable('editor'), around: '', caret: 0 };
    await h.open();
    h.session.edit('hello world', 11, 11);
    h.pc = { ...unreadable('editor'), around: 'hello world', caret: 11 };
    await h.poll();
    // The user clicks after "hello" on the PC: its hidden input reports the line and the new caret.
    h.pc = { ...unreadable('editor'), around: 'hello world', caret: 5 };
    h.session.clicked();
    await flush();
    // The phone's field is told to move its caret (a view that does not keep it as it is).
    assert.ok(h.views.some((view) => view.text === 'hello world' && view.selectionStart === 5 && !view.keep));
    h.session.edit('hello, world', 6, 6);
    assert.deepEqual(h.typed().at(-1).data, { backspace: 0, delete: 0, text: ',' });
    assert.equal(
        h.typed().filter(({ action }) => action === 'shortcut').length,
        0,
        'no arrow keys: the caret is there'
    );
});

test('a click out of the text typed blind clears it, as does one in a field that reports nothing', async () => {
    const h = harness();
    h.pc = { ...unreadable('editor'), around: '', caret: 0 };
    await h.open();
    h.session.edit('hello', 5, 5);
    h.pc = { ...unreadable('editor'), around: 'older line', caret: 2 };
    h.session.clicked();
    await flush();
    assert.equal(h.view.text, '');
    const terminal = harness();
    await terminal.open();
    terminal.session.edit('ls', 2, 2);
    terminal.session.clicked();
    assert.equal(terminal.view.text, '');
});

test("the view says what the PC's field takes, plain text when a read does not", async () => {
    const h = harness();
    h.pc = { ...readable('', 'mail'), kind: 'email' };
    await h.open();
    assert.equal(h.view.kind, 'email');
    // Another field, read without a kind: not the email field's keyboard any more.
    h.pc = unreadable('zone-b');
    await h.poll();
    assert.equal(h.view.kind, 'text');
});
