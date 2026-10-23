import test from 'node:test';
import assert from 'node:assert/strict';
import { createDongleCommands, keyUsage, typeCommands } from '../../web/logic/dongle-keys.js';

test('dongle typing: characters as keys of the chosen layout', () => {
    assert.deepEqual(typeCommands('a', 'us'), ['t 4 0']);
    assert.deepEqual(typeCommands('A', 'us'), ['t 4 2']);
    assert.deepEqual(typeCommands('@', 'us'), ['t 31 2']);
    // AZERTY: a sits where QWERTY has q, digits need Shift, @ needs AltGr.
    assert.deepEqual(typeCommands('a', 'fr'), ['t 20 0']);
    assert.deepEqual(typeCommands('1', 'fr'), ['t 30 2']);
    assert.deepEqual(typeCommands('@', 'fr'), ['t 39 64']);
    assert.deepEqual(typeCommands('é', 'fr'), ['t 31 0']);
    assert.deepEqual(typeCommands('m', 'fr'), ['t 51 0']);
    // A dead key, then the letter: ê, Ê, ë. A dead key's own character: the dead key, then Space.
    assert.deepEqual(typeCommands('ê', 'fr'), ['t 47 0', 't 8 0']);
    assert.deepEqual(typeCommands('Ê', 'fr'), ['t 47 0', 't 8 2']);
    assert.deepEqual(typeCommands('ë', 'fr'), ['t 47 2', 't 8 0']);
    assert.deepEqual(typeCommands('~', 'fr'), ['t 31 64', 't 44 0']);
    // Line breaks and tabs are keys; what no key types stays out.
    assert.deepEqual(typeCommands('\n', 'fr'), ['t 40 0']);
    assert.equal(typeCommands('ê', 'us'), null);
    assert.equal(typeCommands('😀', 'fr'), null);
});

test('dongle keys: named keys whatever the layout, letters through it, media keys as consumer usages', () => {
    assert.deepEqual(keyUsage('Left', 'fr'), { usage: 0x50 });
    assert.deepEqual(keyUsage('F1', 'us'), { usage: 0x3a });
    assert.deepEqual(keyUsage('F24', 'us'), { usage: 0x73 });
    assert.deepEqual(keyUsage('Z', 'us'), { usage: 0x1d });
    // Ctrl+Z on AZERTY is the key QWERTY calls W.
    assert.deepEqual(keyUsage('Z', 'fr'), { usage: 0x1a });
    assert.deepEqual(keyUsage('VolumeUp', 'fr'), { consumer: 0xe9 });
    assert.equal(keyUsage('Nothing', 'fr'), null);
});

test('dongle commands: the remote commands, with what the dongle holds', () => {
    const dongle = createDongleCommands();
    const commands = (action, data, layout = 'us') => dongle.translate(action, data, layout).commands;
    assert.deepEqual(commands('move', { dx: 3, dy: -2 }), ['m 3 -2']);
    // The PC's scroll goes down with dy; the dongle's wheel turns up.
    assert.deepEqual(commands('scroll', { dx: 0, dy: 240 }), ['w -240 0']);
    assert.deepEqual(commands('click', { button: 'left', double: true }), ['b 1', 'b 0', 'b 1', 'b 0']);
    assert.deepEqual(commands('button', { button: 'right', down: true }), ['b 2']);
    assert.deepEqual(commands('click', { button: 'left' }), ['b 3', 'b 2']);
    assert.deepEqual(commands('button', { button: 'right', down: true }), []);
    // A shortcut presses the modifiers not already held, taps the key, lets go in reverse.
    assert.deepEqual(commands('key', { key: 'Shift', down: true }), ['k 225 1']);
    assert.deepEqual(commands('shortcut', { key: 'Z', modifiers: ['Control', 'Shift'] }, 'fr'), [
        'k 224 1',
        'k 26 1',
        'k 26 0',
        'k 224 0',
    ]);
    assert.deepEqual(commands('key', { key: 'VolumeMute' }), ['c 226 1', 'c 226 0']);
    assert.deepEqual(commands('text', { backspace: 1, delete: 0, text: 'ok' }), [
        'k 42 1',
        'k 42 0',
        't 18 0',
        't 14 0',
    ]);
    assert.deepEqual(commands('release'), ['r']);
    assert.deepEqual(commands('button', { button: 'right', down: false }), []);
});

test('dongle commands: the answers the remote expects from the PC', () => {
    const dongle = createDongleCommands();
    const { result: field } = dongle.translate('mirror-read', {});
    assert.equal(field.readable, false);
    assert.ok(field.reason);
    assert.deepEqual(dongle.translate('media-state').result, { muted: null, playing: null });
    assert.match(dongle.translate('text', { text: 'a😀😀' }).result.notice, /2 characters/);
    assert.throws(() => dongle.translate('mirror-edit', {}), /USB dongle/);
});
