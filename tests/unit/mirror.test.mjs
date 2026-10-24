import test from 'node:test';
import assert from 'node:assert/strict';
import { coverObjects, createMirror } from '../../web/logic/mirror.js';

const snapshot = (text, session = 'field-a', revision = 0) => ({
    readable: true,
    session,
    revision,
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
});
function harness() {
    const requests = [],
        changes = [];
    const mirror = createMirror(
        (action, data) => new Promise((resolve, reject) => requests.push({ action, data, resolve, reject })),
        (state) => changes.push(state)
    );
    return {
        mirror,
        requests,
        changes,
        async reply(value) {
            requests.shift().resolve(value);
            await new Promise((resolve) => setImmediate(resolve));
        },
    };
}
test('opening mirrors the complete field; PC focus changes replace it without closing', async () => {
    const h = harness();
    h.mirror.open();
    await h.reply(snapshot('Existing PC text'));
    assert.equal(h.changes.at(-1).text, 'Existing PC text');
    h.mirror.poll();
    await h.reply(snapshot('Other field', 'field-b'));
    assert.equal(h.changes.at(-1).text, 'Other field');
    assert.equal(h.changes.at(-1).open, true);
});
test('IME holds uncommitted input; a field changed meanwhile rejects it without replaying it', async () => {
    const h = harness();
    h.mirror.open();
    await h.reply(snapshot('Original'));
    h.mirror.compose(true);
    h.mirror.input('Uncommitted', 11, 11);
    assert.equal(h.requests.length, 0);
    // No reading while the composition waits: the PC's state would replace what is being typed.
    h.mirror.poll();
    assert.equal(h.requests.length, 0);
    h.mirror.compose(false);
    assert.equal(h.requests[0].action, 'mirror-edit');
    await h.reply({ accepted: false, snapshot: snapshot('New field', 'field-b') });
    assert.equal(h.changes.at(-1).text, 'New field');
    assert.equal(h.requests.length, 0);
});
test('fast typing survives the PC moving on: no read while typing waits, a stale revision is retried', async () => {
    const h = harness();
    h.mirror.open();
    await h.reply(snapshot('Hi'));
    h.mirror.input('Hi t', 4, 4);
    const first = h.requests.shift();
    // More typing while the first edit is on its way; a poll would read the PC and lose it.
    h.mirror.input('Hi the', 6, 6);
    h.mirror.poll();
    assert.equal(h.requests.length, 0);
    // The PC only moved its caret (new revision, same text): the edit is sent again, nothing typed is dropped.
    first.resolve({
        accepted: false,
        snapshot: { ...snapshot('Hi', 'field-a', 1), selectionStart: 0, selectionEnd: 0 },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.requests[0].data.revision, 1);
    assert.equal(h.requests[0].data.text, ' the');
    await h.reply({ accepted: true, snapshot: snapshot('Hi the', 'field-a', 2) });
    assert.equal(h.changes.at(-1).text, 'Hi the');
});
test('stale rejected edits use the authoritative snapshot and never replay old typing', async () => {
    const h = harness();
    h.mirror.open();
    await h.reply(snapshot('Old'));
    h.mirror.input('Old typing', 10, 10);
    assert.equal(h.requests[0].data.session, 'field-a');
    await h.reply({ accepted: false, snapshot: snapshot('New', 'field-b') });
    assert.equal(h.changes.at(-1).text, 'New');
    assert.equal(h.requests.length, 0);
});
test('close ignores late replies; reconnect rereads PC state without replaying text', async () => {
    const h = harness();
    h.mirror.open();
    await h.reply(snapshot('Before'));
    h.mirror.input('Pending', 7, 7);
    h.mirror.disconnected();
    await h.reply({ accepted: true, snapshot: snapshot('Pending', 'field-a', 1) });
    h.mirror.poll();
    await h.reply(snapshot('After reconnect', 'field-b'));
    assert.equal(h.changes.at(-1).text, 'After reconnect');
    h.mirror.poll();
    h.mirror.close();
    await h.reply(snapshot('Late'));
    assert.equal(h.changes.at(-1).open, false);
});
test('unavailable fields clear the mirror but keep the editor open', async () => {
    const h = harness();
    h.mirror.open();
    await h.reply(snapshot('Private text'));
    h.mirror.poll();
    await h.reply({ readable: false, text: '' });
    assert.equal(h.changes.at(-1).text, '');
    assert.equal(h.changes.at(-1).open, true);
    assert.equal(h.changes.at(-1).readable, false);
});
test('a failed edit rereads the PC so typing resumes without refocusing', async () => {
    const h = harness();
    h.mirror.open();
    await h.reply(snapshot('ab\n\nc'));
    h.mirror.input('ab\n\n', 4, 4);
    h.requests.shift().reject(new Error('PC text range differs'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.changes.at(-1).readable, false);
    h.mirror.poll();
    assert.equal(h.requests[0].data.session, undefined, 'the poll must not ask for "unchanged"');
    await h.reply(snapshot('ab\n\nc'));
    assert.equal(h.changes.at(-1).readable, true);
});
test('typing the PC took is never sent again, even when the field shows something else', async () => {
    const h = harness();
    h.mirror.open();
    await h.reply(snapshot(''));
    h.mirror.input('a', 1, 1);
    // A digits-only field refused the letter: same text, but the key was pressed. Sending it again would type it
    // twice in a field that answers late.
    await h.reply({ accepted: false, typed: true, snapshot: snapshot('', 'field-a', 0) });
    assert.equal(h.requests.length, 0);
    assert.equal(h.changes.at(-1).text, '');
});
test('typing done while a masked field reshapes the previous key follows at its caret', async () => {
    const h = harness();
    h.mirror.open();
    await h.reply(snapshot('06'));
    h.mirror.input('061', 3, 3);
    const edit = h.requests.shift();
    h.mirror.input('0612', 4, 4);
    // The mask spaced the digits: "06 1". The 2 typed meanwhile goes after its caret, not lost with the phone's text.
    edit.resolve({ accepted: false, typed: true, snapshot: snapshot('06 1', 'field-a', 1) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.changes.at(-1).text, '06 12');
    assert.deepEqual(
        { start: h.requests[0].data.start, end: h.requests[0].data.end, text: h.requests[0].data.text },
        { start: 4, end: 4, text: '2' }
    );
    await h.reply({ accepted: true, snapshot: snapshot('06 12', 'field-a', 2) });
    assert.equal(h.changes.at(-1).text, '06 12');
});
test('a field that cannot be read leaves no text from the one before', async () => {
    const h = harness();
    h.mirror.open();
    await h.reply(snapshot('Earlier field'));
    h.mirror.poll();
    h.requests.shift().reject(new Error('Text selection is not supported on this element.'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.changes.at(-1).text, '');
    h.mirror.close();
    h.mirror.open();
    assert.equal(h.changes.at(-1).text, '', 'reopening shows nothing until the PC is read');
});
test('a PC answer arriving during a composition never sends it early nor lets stale text overwrite the PC', async () => {
    const h = harness();
    h.mirror.open();
    await h.reply(snapshot(''));
    h.mirror.input('hello', 5, 5, '');
    const edit = h.requests.shift();
    // The keyboard composes the next word while the edit is on its way.
    h.mirror.compose(true);
    h.mirror.input('hello w', 7, 7, 'hello');
    // The field made it upper case: its text wins, the composition so far follows, nothing is sent mid-word.
    edit.resolve({ accepted: false, typed: true, snapshot: snapshot('HELLO', 'field-a', 1) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.changes.at(-1).text, 'HELLO w');
    assert.equal(h.requests.length, 0);
    // The editor still shows its own text (not rewritten during a composition) and types on top of it.
    h.mirror.input('hello wo', 8, 8, 'hello w');
    assert.equal(h.changes.at(-1).text, 'HELLO wo');
    h.mirror.compose(false);
    assert.deepEqual(
        { start: h.requests[0].data.start, end: h.requests[0].data.end, text: h.requests[0].data.text },
        { start: 5, end: 5, text: ' wo' }
    );
});
test('typing over a completion the PC selected replaces it, as a keyboard types', async () => {
    const h = harness();
    h.mirror.open();
    await h.reply({ ...snapshot('apple'), selectionStart: 1, selectionEnd: 5 });
    h.mirror.input('ap', 2, 2);
    assert.deepEqual(
        { start: h.requests[0].data.start, end: h.requests[0].data.end, text: h.requests[0].data.text },
        { start: 1, end: 5, text: 'p' }
    );
});
test('Backspace typed while the focus moved on to an empty field reaches the PC as a key', async () => {
    const h = harness();
    h.mirror.open();
    await h.reply(snapshot('', 'box-3'));
    h.mirror.input('9', 1, 1);
    const edit = h.requests.shift();
    h.mirror.input('', 0, 0);
    // The code field moved the focus to its next box, empty: the erased 9 is behind, in the previous box.
    edit.resolve({ accepted: false, typed: true, snapshot: snapshot('', 'box-4') });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(h.requests[0].data, { key: 'Backspace', modifiers: [] });
    await h.reply({});
    assert.equal(h.requests[0].action, 'mirror-read');
    await h.reply(snapshot('', 'box-3'));
    assert.equal(h.changes.at(-1).session, 'box-3');
});
test('an erasure the same field cannot hold presses no key', async () => {
    const h = harness();
    h.mirror.open();
    await h.reply({ ...snapshot('apple'), selectionStart: 3, selectionEnd: 5 });
    h.mirror.input('app', 3, 3);
    const edit = h.requests.shift();
    h.mirror.input('ap', 2, 2);
    // The field read empty for a moment: no Backspace may be sent to make up for it.
    edit.resolve({ accepted: false, typed: true, snapshot: snapshot('', 'field-a', 1) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(h.requests.every((request) => request.action !== 'shortcut'));
});
test('typing that reaches a field after it moved the focus on (a code box) follows the focus', async () => {
    const h = harness();
    h.mirror.open();
    await h.reply(snapshot('', 'box-1'));
    h.mirror.input('1', 1, 1);
    await h.reply({ accepted: false, typed: true, snapshot: snapshot('', 'box-2') });
    h.mirror.input('2', 1, 1);
    // The field moved the focus on again before the 2 got there: it goes to the box that has it now.
    await h.reply({ accepted: false, snapshot: snapshot('', 'box-3') });
    assert.equal(h.requests[0].data.session, 'box-3');
    assert.equal(h.requests[0].data.text, '2');
});
test('an inline object (an emoji name) is crossed in one step or selected whole, as on the PC', async () => {
    const objects = [[5, 18]];
    assert.deepEqual(coverObjects(objects, 9, 9), [5, 18]);
    assert.deepEqual(coverObjects(objects, 2, 9), [2, 18]);
    assert.deepEqual(coverObjects(objects, 9, 19), [5, 19]);
    // At its edges the caret stays.
    assert.deepEqual(coverObjects(objects, 5, 5), [5, 5]);
    assert.deepEqual(coverObjects(objects, 18, 18), [18, 18]);
    // The space-bar cursor steps in from an edge: it crosses the name, to the right or to the left.
    assert.deepEqual(coverObjects(objects, 6, 6, [5, 5]), [18, 18]);
    assert.deepEqual(coverObjects(objects, 17, 17, [18, 18]), [5, 5]);
    // From the name selected, the cursor goes to the edge it moved toward.
    assert.deepEqual(coverObjects(objects, 16, 16, [5, 18]), [18, 18]);
    assert.deepEqual(coverObjects(objects, 6, 6, [5, 18]), [5, 5]);
    // Sliding fast, the cursor lands anywhere inside: it still crosses, in the direction it goes.
    assert.deepEqual(coverObjects(objects, 12, 12, [3, 3], true), [18, 18]);
    assert.deepEqual(coverObjects(objects, 8, 8, [20, 20], true), [5, 5]);
    // A tap from elsewhere selects it.
    assert.deepEqual(coverObjects(objects, 9, 9, [2, 2]), [5, 18]);

    // A tap in the name selects it on the phone and on the PC.
    const h = harness();
    h.mirror.open();
    await h.reply({ ...snapshot('Test :sweat_smile:'), objects });
    h.mirror.input('Test :sweat_smile:', 9, 9);
    assert.deepEqual([h.changes.at(-1).selectionStart, h.changes.at(-1).selectionEnd], [5, 18]);
    const edit = h.requests.at(-1);
    assert.equal(edit.action, 'mirror-edit');
    assert.deepEqual([edit.data.selectionStart, edit.data.selectionEnd], [5, 18]);
    // A field without objects forgets earlier ones.
    await h.reply({ accepted: true, snapshot: snapshot('plain') });
    assert.deepEqual(h.changes.at(-1).objects, []);
});
test('a caret moved while a read is on its way is not undone by that read', async () => {
    const h = harness();
    h.mirror.open();
    await h.reply(snapshot('hello world'));
    h.mirror.poll();
    // The space-bar cursor steps back once while the read is out.
    h.mirror.input('hello world', 10, 10);
    const shown = h.changes.length;
    // The read answers with the PC's caret from before that step, at a newer revision: the phone shows nothing of it.
    await h.reply({ ...snapshot('hello world', 'field-a', 1), selectionStart: 11, selectionEnd: 11 });
    assert.equal(h.changes.length, shown);
    const edit = h.requests.at(-1);
    assert.equal(edit.action, 'mirror-edit');
    assert.deepEqual([edit.data.selectionStart, edit.data.selectionEnd], [10, 10]);
});
