/**
 * The remote's commands as the USB dongle's (dongle/src/main.cpp lists them), for the phone driving the dongle over
 * Bluetooth without the PC's server. Nobody reads the PC's keyboard layout then: characters go through the layout
 * the user picked (a BIOS reads US QWERTY), dead keys included (ê is ^ then e on AZERTY).
 */

// HID keyboard usages of the keys the remote names, whatever the layout. Letters come from the layout.
const namedKeys = {
    Escape: 0x29,
    Tab: 0x2b,
    Control: 0xe0,
    Shift: 0xe1,
    Alt: 0xe2,
    AltGr: 0xe6,
    Win: 0xe3,
    Left: 0x50,
    Up: 0x52,
    Right: 0x4f,
    Down: 0x51,
    Delete: 0x4c,
    Backspace: 0x2a,
    Home: 0x4a,
    End: 0x4d,
    PageUp: 0x4b,
    PageDown: 0x4e,
    Insert: 0x49,
    Enter: 0x28,
    Space: 0x2c,
    PrintScreen: 0x46,
    ScrollLock: 0x47,
    Pause: 0x48,
    ContextMenu: 0x65,
};
for (let number = 1; number <= 24; number++) namedKeys[`F${number}`] = number <= 12 ? 0x39 + number : 0x5b + number;
// Consumer usages (volume, media), sent with the "c" command.
const consumerKeys = { VolumeUp: 0xe9, VolumeDown: 0xea, VolumeMute: 0xe2, PlayPause: 0xcd };

const shift = 0x02,
    altGr = 0x40;
// HID usages of the letter keys by their QWERTY letter: a is 0x04, z is 0x1d.
const qwerty = (letter) => 0x04 + letter.charCodeAt(0) - 97;

/**
 * A layout from its keys: [usage, character, with Shift, with AltGr]. A dead key's character is a combining mark
 * (U+0302 for ^): it types nothing, the next key gets the accent.
 */
function buildLayout(keys, letters) {
    const characters = new Map(),
        accents = new Map();
    const add = (character, usage, modifiers) => {
        if (!character) return;
        if (/\p{M}/u.test(character)) accents.set(character, [usage, modifiers]);
        else if (!characters.has(character)) characters.set(character, [usage, modifiers]);
    };
    for (const [letter, usage] of Object.entries(letters)) {
        add(letter, usage, 0);
        add(letter.toUpperCase(), usage, shift);
    }
    for (const [usage, plain, shifted, alternate] of keys) {
        add(plain, usage, 0);
        add(shifted, usage, shift);
        add(alternate, usage, altGr);
    }
    add(' ', 0x2c, 0);
    add('\n', 0x28, 0);
    add('\t', 0x2b, 0);
    return { characters, accents };
}
const usLetters = Object.fromEntries([...'abcdefghijklmnopqrstuvwxyz'].map((letter) => [letter, qwerty(letter)]));
// On AZERTY, A and Q, Z and W swap, and M sits right of L.
const frLetters = { ...usLetters, a: qwerty('q'), q: qwerty('a'), z: qwerty('w'), w: qwerty('z'), m: 0x33 };
export const layouts = {
    us: buildLayout(
        [
            [0x35, '`', '~'],
            [0x1e, '1', '!'],
            [0x1f, '2', '@'],
            [0x20, '3', '#'],
            [0x21, '4', '$'],
            [0x22, '5', '%'],
            [0x23, '6', '^'],
            [0x24, '7', '&'],
            [0x25, '8', '*'],
            [0x26, '9', '('],
            [0x27, '0', ')'],
            [0x2d, '-', '_'],
            [0x2e, '=', '+'],
            [0x2f, '[', '{'],
            [0x30, ']', '}'],
            [0x31, '\\', '|'],
            [0x33, ';', ':'],
            [0x34, "'", '"'],
            [0x36, ',', '<'],
            [0x37, '.', '>'],
            [0x38, '/', '?'],
        ],
        usLetters
    ),
    fr: buildLayout(
        [
            [0x35, '²'],
            [0x1e, '&', '1'],
            [0x1f, 'é', '2', '\u0303'],
            [0x20, '"', '3', '#'],
            [0x21, "'", '4', '{'],
            [0x22, '(', '5', '['],
            [0x23, '-', '6', '|'],
            [0x24, 'è', '7', '\u0300'],
            [0x25, '_', '8', '\\'],
            [0x26, 'ç', '9', '^'],
            [0x27, 'à', '0', '@'],
            [0x2d, ')', '°', ']'],
            [0x2e, '=', '+', '}'],
            [0x08, null, null, '€'],
            [0x2f, '\u0302', '\u0308'],
            [0x30, '$', '£', '¤'],
            [0x34, 'ù', '%'],
            [0x31, '*', 'µ'],
            [0x64, '<', '>'],
            [0x10, ',', '?'],
            [0x36, ';', '.'],
            [0x37, ':', '/'],
            [0x38, '!', '§'],
        ],
        frLetters
    ),
};

/**
 * The "t" commands typing this character on the layout, or null when no key types it. A character missing from the
 * layout may be a letter with an accent its dead keys add (ê: ^ then e); a dead key's own character is the dead key
 * then Space.
 */
export function typeCommands(character, layoutName) {
    const { characters, accents } = layouts[layoutName] ?? layouts.us;
    const type = ([usage, modifiers]) => `t ${usage} ${modifiers}`;
    if (characters.has(character)) return [type(characters.get(character))];
    const [base, accent, ...rest] = [...character.normalize('NFD')];
    if (accent && !rest.length && accents.has(accent) && characters.has(base))
        return [type(accents.get(accent)), type(characters.get(base))];
    const spacing = { '^': '\u0302', '¨': '\u0308', '~': '\u0303', '`': '\u0300' }[character];
    if (spacing && accents.has(spacing)) return [type(accents.get(spacing)), type(characters.get(' '))];
    return null;
}

/** The HID usage of a key the remote names on this layout ({ consumer } for a media key), or null. */
export function keyUsage(name, layoutName) {
    if (name in consumerKeys) return { consumer: consumerKeys[name] };
    if (name in namedKeys) return { usage: namedKeys[name] };
    if (/^[A-Z]$/.test(name)) {
        const found = (layouts[layoutName] ?? layouts.us).characters.get(name.toLowerCase());
        return found ? { usage: found[0] } : null;
    }
    return null;
}

const buttonBits = { left: 1, right: 2, middle: 4 };
const modifierNames = new Set(['Control', 'Shift', 'Alt', 'AltGr', 'Win']);

/**
 * Translates the remote's commands (what it sends the PC's server) into the dongle's, keeping what the dongle holds:
 * mouse buttons and keys. translate(action, data, layoutName) → { commands, result }; it throws for a command the
 * dongle cannot carry out (a mirror edit: no one reads the PC's fields). The PC's answers the remote expects come
 * back as result: an unreadable field for a mirror read, an unknown media state.
 */
export function createDongleCommands() {
    let buttons = 0;
    const held = new Set();
    function key(name, down, layoutName) {
        const found = keyUsage(name, layoutName);
        if (!found) throw new Error(`Unsupported key: ${name}`);
        const [letter, usage] = found.consumer ? ['c', found.consumer] : ['k', found.usage];
        const press = (value) => `${letter} ${usage} ${value ? 1 : 0}`;
        if (down === undefined) return [press(true), press(false)];
        if (down === held.has(name)) return [];
        if (down) held.add(name);
        else held.delete(name);
        return [press(down)];
    }
    function translate(action, data = {}, layoutName = 'us') {
        const commands = [];
        let result = null;
        switch (action) {
            case 'move':
                commands.push(`m ${Math.trunc(data.dx) || 0} ${Math.trunc(data.dy) || 0}`);
                break;
            // The remote's scroll is the PC's: dy down, dx right; the dongle's wheel turns up.
            case 'scroll':
                commands.push(`w ${-Math.trunc(data.dy) || 0} ${Math.trunc(data.dx) || 0}`);
                break;
            case 'button': {
                const bit = buttonBits[data.button];
                if (!bit) throw new Error('Unsupported mouse button');
                const next = data.down ? buttons | bit : buttons & ~bit;
                if (next !== buttons) commands.push(`b ${(buttons = next)}`);
                break;
            }
            case 'click': {
                const bit = buttonBits[data.button];
                if (!bit) throw new Error('Unsupported mouse button');
                for (let time = 0; time < (data.double ? 2 : 1); time++)
                    commands.push(`b ${buttons | bit}`, `b ${buttons}`);
                break;
            }
            case 'key':
                commands.push(...key(data.key, data.down, layoutName));
                break;
            case 'shortcut': {
                const modifiers = (data.modifiers ?? []).filter((name) => modifierNames.has(name) && !held.has(name));
                for (const name of modifiers) commands.push(...key(name, true, layoutName));
                commands.push(...key(data.key, undefined, layoutName));
                for (const name of modifiers.reverse()) commands.push(...key(name, false, layoutName));
                break;
            }
            case 'text': {
                const tap = (name, times) => {
                    for (let time = 0; time < times; time++) commands.push(...key(name, undefined, layoutName));
                };
                tap('Backspace', Math.min(data.backspace || 0, 4096));
                tap('Delete', Math.min(data.delete || 0, 4096));
                let missing = 0;
                for (const character of String(data.text ?? '')) {
                    const typed = typeCommands(character, layoutName);
                    if (typed) commands.push(...typed);
                    else missing++;
                }
                if (missing)
                    result = {
                        notice: `${missing} character${missing > 1 ? 's' : ''} not on the dongle's keyboard layout`,
                    };
                break;
            }
            case 'release':
                buttons = 0;
                held.clear();
                commands.push('r');
                break;
            case 'media-state':
                result = { muted: null, playing: null };
                break;
            case 'mirror-read':
                result = { session: 'dongle', revision: 0, field: 'dongle', readable: false, kind: 'text' };
                result.reason = 'USB dongle · typing blind';
                break;
            case 'mirror-close':
                break;
            default:
                throw new Error('Not available through the USB dongle');
        }
        return { commands, result };
    }
    return {
        translate,
        /** Forgets what the dongle held: it lets go of everything when the phone disconnects. */
        reset() {
            buttons = 0;
            held.clear();
        },
    };
}
