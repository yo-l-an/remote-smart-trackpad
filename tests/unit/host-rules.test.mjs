// The PC bridge's pure rules (host/windows/mirror-rules.psm1, Select-InsertStrategy in host/windows/input.psm1), run
// in PowerShell through tests/unit/host-rules.ps1 (docs/adr/0002). Facts recorded from real browsers (npm run test:placeholders --
// --record) are replayed from tests/fixtures/field-facts.json.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import readline from 'node:readline';

const windows = process.platform === 'win32';
let rules, waiting;
before(() => {
    if (!windows) return;
    rules = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'tests/unit/host-rules.ps1'],
        {
            stdio: ['pipe', 'pipe', 'inherit'],
            windowsHide: true,
        }
    );
    waiting = [];
    readline.createInterface({ input: rules.stdout }).on('line', (line) => waiting.shift()(JSON.parse(line)));
});
after(() => rules?.stdin.end());
/** The rule's answer for these facts. */
async function ask(rule, facts) {
    const answer = await new Promise((resolve) => {
        waiting.push(resolve);
        rules.stdin.write(JSON.stringify({ rule, facts }) + '\n');
    });
    if (!answer.ok) throw new Error(answer.error);
    return answer.result;
}
const verdict = async (facts) => {
    const {
        unreadable,
        empty,
        singleLine = false,
    } = await ask('Get-FieldVerdict', { caret: 0, boxWidth: 300, boxHeight: 30, ...facts });
    return { unreadable, empty, singleLine };
};
const web = (content) => ({
    dom: true,
    native: false,
    valueLength: 0,
    editableText: false,
    editableObject: false,
    leafless: false,
    singleLine: false,
    ...content,
});

test('field verdict: readable, placeholder only, or typed blind', { skip: !windows }, async () => {
    // A Win32 field hiding its content behind its name.
    assert.deepEqual(await verdict({ framework: 'Win32', name: 'Password', text: 'Password', content: null }), {
        unreadable: true,
        empty: false,
        singleLine: false,
    });
    // A classic one-line edit box.
    assert.deepEqual(
        await verdict({ framework: 'WinForm', name: 'textbox', text: 'hi', win32SingleLine: true, content: null }),
        { unreadable: false, empty: false, singleLine: true }
    );
    // Chrome's address bar reads its name when empty.
    const omnibox = { framework: 'Chrome', name: 'Address and search bar', content: { dom: false, singleLine: true } };
    assert.deepEqual(await verdict({ ...omnibox, text: 'Address and search bar' }), {
        unreadable: false,
        empty: true,
        singleLine: true,
    });
    assert.deepEqual(await verdict({ ...omnibox, text: 'hello' }), {
        unreadable: false,
        empty: false,
        singleLine: true,
    });
    // A code editor's hidden input (VS Code): too small to show text.
    assert.deepEqual(
        await verdict({
            framework: 'Chrome',
            name: '',
            text: 'x',
            boxWidth: 1,
            boxHeight: 1,
            content: web({ native: true, valueLength: 1 }),
        }),
        { unreadable: true, empty: true, singleLine: false }
    );
    // VS Code's editor (EditContext): its element reads its accessible name, or a few characters around the caret.
    const editContext = {
        framework: 'Chrome',
        className: 'native-edit-context',
        name: 'The editor is not accessible at this time. To enable screen reader optimized mode, use Shift+Alt+F1',
        content: web({ leafless: true }),
    };
    for (const text of [editContext.name, 'ello world', ''])
        assert.deepEqual(await verdict({ ...editContext, text }), { unreadable: true, empty: true, singleLine: false });
    // A terminal (the console) reads its whole screen: typed blind.
    assert.deepEqual(
        await verdict({
            framework: '',
            className: '',
            windowClass: 'ConsoleWindowClass',
            name: '',
            text: 'C:\\>dir',
            content: null,
        }),
        { unreadable: true, empty: true, singleLine: false }
    );
    // An empty <input> reads its placeholder as an embedded object.
    assert.deepEqual(
        await verdict({
            framework: 'Chrome',
            name: 'Search',
            text: '￼',
            content: web({ native: true, singleLine: true }),
        }),
        { unreadable: false, empty: true, singleLine: true }
    );
    // A contenteditable showing only generated text, then with typed text.
    assert.deepEqual(
        await verdict({ framework: 'Chrome', name: '', text: 'Type a message', content: web({ otherText: true }) }),
        { unreadable: false, empty: true, singleLine: false }
    );
    assert.deepEqual(
        await verdict({
            framework: 'Chrome',
            name: '',
            text: 'hello',
            content: web({ editableText: true, singleLine: true }),
        }),
        { unreadable: false, empty: false, singleLine: false }
    );
    // Firefox's role=textbox hides its text nodes: a caret past the start stands after real text.
    const firefox = { framework: 'Gecko', name: '', text: 'hello', content: web({ leafless: true }) };
    assert.deepEqual(await verdict({ ...firefox, caret: 5 }), { unreadable: false, empty: false, singleLine: false });
    assert.deepEqual(await verdict({ ...firefox, caret: 0 }), { unreadable: false, empty: true, singleLine: false });
});

test('field kind: the keyboard a field calls for', { skip: !windows }, async () => {
    // The <input> types the phone has a keyboard for reach it from real browsers (npm run test:typing); these are the
    // fields no browser fixture shows.
    const kind = (facts) => ask('Get-FieldKind', facts);
    // A type the phone has no keyboard for: plain text.
    assert.equal(await kind({ content: web({ native: true, inputType: 'date' }) }), 'text');
    // A classic edit box that takes digits only.
    assert.equal(await kind({ className: 'Edit', content: null, win32Digits: true }), 'digits');
    // VS Code's terminal, as UI Automation reports it.
    assert.equal(
        await kind({
            framework: 'Chrome',
            className: 'xterm-helper-textarea',
            name: 'Terminal 1, powershell',
            boxWidth: 6,
            boxHeight: 13,
            content: web({ native: true }),
        }),
        'terminal'
    );
});

test('text repair: what a field reports but nobody typed is taken away', { skip: !windows }, async () => {
    const repair = (facts) => ask('Repair-MirrorText', { native: false, className: '', phantomBreak: false, ...facts });
    assert.deepEqual(await repair({ framework: 'Chrome', text: '\n', start: 1, end: 1 }), {
        text: '',
        start: 0,
        end: 0,
    });
    assert.deepEqual(await repair({ framework: 'Chrome', text: 'a\n', start: 2, end: 2, phantomBreak: true }), {
        text: 'a',
        start: 1,
        end: 1,
    });
    assert.deepEqual(
        await repair({ framework: 'Chrome', text: 'a\n', start: 2, end: 2, native: true, phantomBreak: true }),
        { text: 'a\n', start: 2, end: 2 }
    );
    assert.deepEqual(
        await repair({
            framework: 'WinForm',
            className: 'WindowsForms10.RichEdit20W.app.0.1',
            text: 'hello\n',
            start: 6,
            end: 6,
        }),
        { text: 'hello', start: 5, end: 5 }
    );
    assert.deepEqual(await repair({ framework: 'Win32', className: 'Edit', text: 'hello\n', start: 6, end: 6 }), {
        text: 'hello\n',
        start: 6,
        end: 6,
    });
});

test(
    'edit outcome: applied, completed by the field, reshaped by a mask, or not there yet',
    { skip: !windows },
    async () => {
        const read = (text, extra = {}) => ({
            readable: true,
            session: 's',
            text,
            selectionStart: text.length,
            selectionEnd: text.length,
            ...extra,
        });
        const outcome = (facts) =>
            ask('Get-EditOutcome', { old: '06', next: '061', landed: 3, session: 's', stableMs: 0, ...facts });
        assert.equal(await outcome({ read: read('061') }), 'applied');
        assert.equal(await outcome({ read: read('06 1', { session: 'other' }) }), 'moved');
        assert.equal(await outcome({ read: read('06 1'), stableMs: 50 }), 'pending');
        assert.equal(await outcome({ read: read('06 1'), stableMs: 150 }), 'reshaped');
        // A field that answers late still holds the old text: never taken for its answer.
        assert.equal(await outcome({ read: read('06'), stableMs: 500 }), 'pending');
        assert.equal(
            await outcome({
                old: '',
                next: 'a',
                landed: 1,
                read: read('apple', { selectionStart: 1, selectionEnd: 5 }),
            }),
            'completed'
        );
    }
);

test('insert strategy: line breaks each field takes', { skip: !windows }, async () => {
    const strategy = (facts) => ask('Select-InsertStrategy', { rich: false, className: '', framework: '', ...facts });
    assert.equal(await strategy({ text: 'hello' }), 'characters');
    assert.equal(await strategy({ text: 'a\nb', framework: 'Chrome', rich: true }), 'shift-enter');
    assert.equal(await strategy({ text: 'a\nb', framework: 'Chrome' }), 'paste');
    assert.equal(
        await strategy({ text: 'a\nb', framework: 'WinForm', className: 'WindowsForms10.RichEdit20W.app.0.1' }),
        'enter'
    );
    assert.equal(
        await strategy({ text: 'a\nb', framework: 'WinForm', className: 'WindowsForms10.EDIT.app.0.1' }),
        'carriage-return'
    );
    assert.equal(await strategy({ text: 'a\nb', framework: 'Win32', className: 'Edit' }), 'carriage-return');
    assert.equal(await strategy({ text: 'a\nb', framework: 'WPF', className: 'TextBox' }), 'paste');
});

test('USB dongle: the HID usage of each key the remote presses', { skip: !windows }, async () => {
    const usage = (virtualKey) => ask('Get-DongleUsage', { virtualKey });
    // Navigation keys, never their number pad twins.
    assert.deepEqual(
        await Promise.all([0x25, 0x26, 0x27, 0x28, 0x24, 0x23, 0x21, 0x22, 0x2d, 0x2e].map(usage)),
        [0x50, 0x52, 0x4f, 0x51, 0x4a, 0x4d, 0x4b, 0x4e, 0x49, 0x4c]
    );
    // Enter, Escape, Backspace, Tab, F1, F24, Windows, AltGr, Control, Shift, Pause, Print Screen.
    assert.deepEqual(
        await Promise.all([0x0d, 0x1b, 0x08, 0x09, 0x70, 0x87, 0x5b, 0xa5, 0x11, 0x10, 0x13, 0x2c].map(usage)),
        [0x28, 0x29, 0x2a, 0x2b, 0x3a, 0x73, 0xe3, 0xe6, 0xe0, 0xe1, 0x48, 0x46]
    );
    // Media keys are consumer usages (+0x10000): volume up, mute, play/pause.
    assert.deepEqual(await Promise.all([0xaf, 0xad, 0xb3].map(usage)), [0x100e9, 0x100e2, 0x100cd]);
});

test('USB dongle: characters typed as keys of the layout', { skip: !windows }, async () => {
    const typing = (text, capsLock = false) => ask('Get-DongleTyping', { character: text.charCodeAt(0), capsLock });
    assert.equal(await typing(' '), 't 44 0');
    // Control characters and characters no key types (an emoji's half) stay with Windows' own typing.
    assert.equal(await typing('\n'), null);
    assert.equal(await typing('\ud83d'), null);
    // Caps Lock flips Shift on a letter, whatever key types it on this layout.
    const [usage, modifiers] = (await typing('a')).split(' ').slice(1).map(Number);
    assert.equal(await typing('a', true), `t ${usage} ${modifiers ^ 2}`);
});

test(
    'ProseMirror blank lines: rebuilt from the paragraphs Chromium leaves out of the text',
    { skip: !windows },
    async () => {
        const view = (text, paragraphs, start, caretParagraph = -1, end = start) =>
            ask('Get-ParagraphView', { text, start, end, paragraphs, caretParagraph });
        // Read from Claude Desktop's prompt box: "a", blank, "b", blank, "zz".
        const claude = await view('a\nb\nzz', ['a', '\n', 'b', '\n', 'zz'], 4, 4);
        assert.equal(claude.text, 'a\n\nb\n\nzz');
        assert.equal(claude.start, 6);
        assert.deepEqual(claude.rawAt, [0, 1, 1, 2, 3, 3, 4, 5, 6]);
        // A caret on a blank line stands on it; without its paragraph, a position goes to the first one at or after it.
        assert.equal((await view('a\nb\nzz', ['a', '\n', 'b', '\n', 'zz'], 2, 1)).start, 2);
        assert.equal((await view('a\nb\nzz', ['a', '\n', 'b', '\n', 'zz'], 2)).start, 3);
        assert.equal((await view('a', ['a', '\n'], 1, 1)).text, 'a\n');
        assert.equal((await view('a', ['\n', 'a'], 0, 1)).start, 1);
        // Nothing missing, or paragraphs that do not make up the text (a list holds lines of its own): left as it is.
        assert.equal((await view('a\nb', ['a', 'b'], 0)).rawAt, null);
        assert.equal((await view('a\nb\nc', ['a', '\n', 'b\nc\nd'], 0)).rawAt, null);
    }
);

test('inline objects: shown by their names, one caret step each', { skip: !windows }, async () => {
    // The embedded-object marker, the editor's zero-width anchor, the dotted square shown without a name.
    const [marker, anchor, square] = [0xfffc, 0xfeff, 0x2b1a].map((code) => String.fromCodePoint(code));
    const view = (text, start = text.length, end = start) => ask('Get-InlineObjectView', { text, start, end });
    // Read from Discord's message box: the emoji image's alt text sits on a line of its own.
    const discord = await view(`Test \n${marker}\n:sweat_smile:\n${anchor}\n${anchor}`);
    assert.equal(discord.text, `Test :sweat_smile:${anchor}`);
    assert.deepEqual(discord.objects, [[5, 18]]);
    assert.deepEqual([discord.start, discord.end], [19, 19]);
    assert.deepEqual(discord.rawAt.slice(4, 8), [4, 5, 5, 5]);
    assert.deepEqual(discord.rawAt.slice(-3), [5, 24, 25]);
    // Read from Chrome (tests/fixtures/placeholders.html, slate-emoji-*): no alt text, in the middle of a line and
    // at a line start.
    assert.equal((await view(`a \n${marker}\n${anchor}\n b`)).text, `a ${square} b`);
    assert.equal((await view(`a\n${anchor}\n${marker}\n${anchor}\n b`)).text, `a\n${anchor}${square} b`);
    // Two emojis with a space between (Slate keeps it, pre-wrap): the anchor's line goes on with the space. Without
    // it, the second object shares the first one's line break.
    assert.equal(
        (
            await view(`a 
${marker}
${anchor} 
${marker}
${anchor}
 b`)
        ).text,
        `a ${square} ${square} b`
    );
    assert.equal(
        (
            await view(`a 
${marker}
${anchor}
${marker}
${anchor}
 b`)
        ).text,
        `a ${square}${square} b`
    );
    const pair = await view(`
${marker}
:a:
${anchor} 
${marker}
:b:
${anchor}
${anchor}`);
    assert.deepEqual(
        [pair.text, pair.objects],
        [
            `:a: :b:${anchor}`,
            [
                [0, 3],
                [4, 7],
            ],
        ]
    );
    // A caret inside an object's lines stands after it; one before it stays before.
    const middle = `a \n${marker}\n${anchor}\n b`;
    assert.deepEqual([(await view(middle, 4)).start, (await view(middle, 2)).start], [3, 2]);
    // Text without such an object is left as it is.
    const plain = await view(`a\n${marker}\nb`, 1);
    assert.deepEqual([plain.text, plain.start, plain.rawAt], [`a\n${marker}\nb`, 1, null]);

    // Backspace on the end of a name takes the whole object, in one key press on the PC.
    const objects = discord.objects;
    assert.deepEqual(await ask('Expand-ObjectEdit', { start: 17, end: 18, objects }), { start: 5, end: 18 });
    assert.deepEqual(await ask('Expand-ObjectEdit', { start: 2, end: 4, objects }), { start: 2, end: 4 });
    const text = discord.text;
    assert.equal(await ask('Get-CaretSteps', { text, start: 5, end: 18, objects }), 1);
    assert.equal(await ask('Get-CaretSteps', { text, start: 2, end: 18, objects }), 4);
    // A field without objects (most of them) has no list at all: every edit goes through as is.
    assert.deepEqual(await ask('Expand-ObjectEdit', { start: 1, end: 2, objects: null }), { start: 1, end: 2 });
    assert.equal(await ask('Get-CaretSteps', { text: 'abc', start: 0, end: 2, objects: null }), 2);
});

test('field verdicts recorded from real browsers stay the same', { skip: !windows }, async () => {
    let recorded;
    try {
        recorded = JSON.parse(await readFile('tests/fixtures/field-facts.json', 'utf8'));
    } catch {
        return;
    }
    for (const { browser, id, facts, verdict: expected } of recorded) {
        const { unreadable, empty, singleLine = false } = await ask('Get-FieldVerdict', facts);
        assert.deepEqual({ unreadable, empty, singleLine }, expected, `${browser} ${id}`);
    }
});

test('PowerShell sources are plain ASCII', async () => {
    // Windows PowerShell reads a file without a byte order mark as ANSI: any other character turns to mojibake (a
    // regex of zero-width characters breaks). Write them as \uXXXX escapes.
    const { readdir } = await import('node:fs/promises');
    for (const directory of ['host', 'scripts', 'tests'])
        for (const name of await readdir(directory, { recursive: true }))
            if (/\.(ps1|psm1)$/.test(name)) {
                const lines = (await readFile(`${directory}/${name}`, 'utf8')).split('\n');
                const line = lines.findIndex((text) => /[^\x00-\x7F]/.test(text));
                assert.equal(line, -1, `${directory}/${name}:${line + 1} holds a non-ASCII character`);
            }
});
