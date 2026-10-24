// Typing check: the phone app types for real into test fields on this PC, through a test host and its Windows
// bridge, and each field must end up holding exactly what was typed (or what its mask makes of it): no letter
// doubled, none lost, whether the phone reads the field or types blind. The phone must show the PC's text, or what
// it typed blind.
// - Phone: the app in headless Chrome, emulating a phone, typed into by an emulated Gboard (tests/checks/gboard.mjs:
//   composition, suggestions, the space bar's cursor, the Backspace swipe, dictation) or a hardware keyboard.
// - PC: tests/fixtures/typing.html in Chrome and Firefox windows (plain fields, masks, code editors, and the real
//   tiptap and Slate editors), then their address bars, native WinForms and WPF windows
//   (tests/checks/typing-windows.ps1), Windows' Notepad and VS Code, each field in turn brought to the foreground and
//   focused.
// Two tiers. Smoke: every field, a short text typed with Gboard: can it be typed into, and does it hold what it
// should. Edge: the fields where the mirror works hardest (data-edge in the fixture, edge in the cases here) get the
// scenario catalogue below (special characters, replacements, selections, line breaks, the PC changing the text,
// typing racing the reads), each in the fields that have what it needs; a field can name the scenarios it takes. A
// case ends as soon as the PC holds the expected text and the phone shows it, not after a fixed wait.
// Every test window carries a random marker in its title, and the test host's bridge refuses input unless the
// foreground window has it (REMOTE_SMART_TRACKPAD_INPUT_GUARD): nothing typed can reach another app. Windows come
// to the foreground one after the other, so leave the PC alone while it runs.
//   node tests/checks/typing-check.mjs [--quick] [--tier=smoke|edge] [--target=chrome,firefox,winforms,wpf,notepad,vscode]
//                                  [--case=id,id] [--mode=smoke,drag,...: scenarios] [--verbose: what the phone sent]
//                                  [--trace: what the phone was shown]
// --quick: smoke in Chrome and WinForms, edge in Chrome's hardest fields only (quickEdge): after changes that do not
// touch typing itself. Run the full one after changes to the typing session, the mirror or the bridge. --tier,
// --target, --case and --mode still narrow it.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createGboard } from './gboard.mjs';
import { cleanupBrowsers, installed, openBrowser } from './test-browsers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const option = (name) =>
    process.argv
        .find((argument) => argument.startsWith(`--${name}=`))
        ?.split('=')[1]
        .split(',');
const quick = process.argv.includes('--quick');
// The quick run's edge tier: Chrome's fields that broke the most, each a kind of its own.
// The emoji each inline emoji image's name stands for, as the host shows it.
const emojiNames = JSON.parse(await readFile(path.join(root, 'host/windows/emoji-names.json'), 'utf8'));
const quickEdge = ['textarea', 'tiptap', 'quill', 'slate', 'code-line', 'delayed', 'complete'];
const targets =
    option('target')
    ?? (quick ? ['chrome', 'winforms'] : ['chrome', 'firefox', 'winforms', 'wpf', 'notepad', 'vscode']);
const onlyCases = option('case');
const onlyModes = option('mode');
const tiers = option('tier') ?? ['smoke', 'edge'];
const marker = `rst${Math.random().toString(36).slice(2, 8)}`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = (promise, ms, what) => {
    let timer;
    const expired = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`Timed out: ${what}`)), ms)));
    return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
};
const temp = (name) => mkdtemp(path.join(tmpdir(), `remote-smart-trackpad-${name}-`));

// Native fixtures: what is typed into each field and what it must hold then (tests/checks/typing-windows.ps1), and
// their edge tier (true: every scenario they can take; a list: those only).
const nativeCases = {
    winforms: [
        { id: 'textbox', typed: 'hello world', expected: 'hello world', caret: true },
        { id: 'multiline', typed: 'hello world', expected: 'hello world', caret: true, lines: true, edge: true },
        { id: 'upper', typed: 'hello', expected: 'HELLO', edge: ['typo'] },
        { id: 'maxlength', typed: 'hello world', expected: 'hello', edge: ['typo'] },
        { id: 'masked', typed: '02102026', expected: '02/10/2026', edge: ['typo', 'slow'] },
        { id: 'rich', typed: 'hello world', expected: 'hello world', caret: true, lines: true, edge: true },
        { id: 'combo', typed: 'apple pie', expected: 'apple pie' },
    ],
    wpf: [
        { id: 'textbox', typed: 'hello world', expected: 'hello world', caret: true },
        { id: 'multiline', typed: 'hello world', expected: 'hello world', caret: true, lines: true, edge: true },
        { id: 'upper', typed: 'hello', expected: 'HELLO', edge: ['typo'] },
        { id: 'maxlength', typed: 'hello world', expected: 'hello', edge: ['typo'] },
        { id: 'rich', typed: 'hello world', expected: 'hello world', caret: true, lines: true, edge: true },
        { id: 'combo', typed: 'apple pie', expected: 'apple pie' },
    ],
};

// The browser's own address bar: a search, and an address it completes inline from its history (the fixture page's),
// which must start with exactly what was typed.
const addressCases = [
    { id: 'address', typed: 'hello world', expected: 'hello world', caret: true },
    {
        id: 'address-completion',
        typed: '127.0',
        expected: '127.0…',
        check: (value) => /^127\.0(\.0\.1|$)/.test(value),
        edge: ['typo', 'slow'],
    },
];

/** A JSON-lines child process: one request per line, answered in order. */
function lineProcess(command, args) {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    const waiting = [];
    let exited = null;
    readline.createInterface({ input: child.stdout }).on('line', (line) => waiting.shift()?.resolve(JSON.parse(line)));
    child.on('exit', (code) => {
        exited = new Error(`${path.basename(args.at(-1))} stopped (${code})`);
        for (const request of waiting.splice(0)) request.reject(exited);
    });
    return {
        async ask(request, ms = 30000) {
            const answer = await timeout(
                new Promise((resolve, reject) => {
                    if (exited) return reject(exited);
                    waiting.push({ resolve, reject });
                    child.stdin.write(JSON.stringify(request) + '\n');
                }),
                ms,
                JSON.stringify(request)
            );
            if (!answer.ok) throw new Error(answer.error);
            return answer.result;
        },
        stop: () => child.stdin.end(),
    };
}

/** Serves the fixture page, which asks for its next command each time it has run the previous one. */
async function startFixturePage() {
    const html = await readFile(path.join(root, 'tests/fixtures/typing.html'), 'utf8');
    // The real editors (tiptap, Quill, Slate), bundled once for the page.
    const { build } = await import('esbuild');
    const editors = (
        await build({
            entryPoints: [path.join(root, 'tests/fixtures/editors.js')],
            bundle: true,
            format: 'esm',
            write: false,
            minify: true,
            define: { 'process.env.NODE_ENV': '"production"' },
            logLevel: 'error',
        })
    ).outputFiles[0].text;
    let waiter = null,
        pending = null;
    const replies = [];
    const server = createServer(async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname === '/')
            return response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
        if (url.pathname === '/editors.js')
            return response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(editors);
        if (url.pathname !== '/next') return response.writeHead(404).end();
        let body = '';
        for await (const chunk of request) body += chunk;
        pending = response;
        replies.push(JSON.parse(body));
        waiter?.();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const next = () =>
        timeout(
            new Promise((resolve) => {
                const check = () => (replies.length ? resolve(replies.shift()) : (waiter = check));
                check();
            }),
            20000,
            'fixture page'
        );
    return {
        url: `http://127.0.0.1:${server.address().port}/?harness=${marker}`,
        cases: () => next().then((reply) => reply.cases),
        /** Sends a command once the page waits for one, and resolves with the page's answer. */
        async command(command) {
            while (!pending) await wait(20);
            const response = pending;
            pending = null;
            response.end(JSON.stringify(command));
            return command.do === 'end' ? null : next();
        },
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

/** The test host, its bridge typing only into windows titled with the marker. */
async function startHost() {
    const reservation = createNetServer();
    await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const data = await temp('typing-host');
    const host = spawn(process.execPath, ['host/server.js'], {
        cwd: root,
        windowsHide: true,
        stdio: 'ignore',
        env: {
            ...process.env,
            REMOTE_SMART_TRACKPAD_PORT: String(port),
            REMOTE_SMART_TRACKPAD_DATA_DIRECTORY: data,
            REMOTE_SMART_TRACKPAD_OPEN_SETUP: '0',
            REMOTE_SMART_TRACKPAD_INPUT_GUARD: marker,
        },
    });
    const url = `http://127.0.0.1:${port}`;
    let setup;
    for (let attempt = 0; attempt < 100 && !setup; attempt++) {
        try {
            setup = await (await fetch(url + '/api/setup')).json();
        } catch {
            if (host.exitCode !== null) throw new Error(`Host exited: ${host.exitCode}`);
            await wait(100);
        }
    }
    if (!setup) throw new Error('The test host did not start');
    return {
        url,
        pairingCode: setup.pairingCode,
        async stop() {
            host.kill();
            await rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        },
    };
}

/** The phone: the app in headless Chrome, paired with the test host, every message it exchanges logged. */
async function startPhone(host) {
    const profile = await temp('typing-phone');
    const chrome = spawn(
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        [
            '--headless=new',
            '--disable-gpu',
            '--no-first-run',
            '--no-default-browser-check',
            '--remote-debugging-port=0',
            `--user-data-dir=${profile}`,
            'about:blank',
        ],
        { windowsHide: true, stdio: 'ignore' }
    );
    let endpoint;
    for (let attempt = 0; attempt < 80 && !endpoint; attempt++) {
        try {
            const [port, url] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8'))
                .trim()
                .split(/\r?\n/);
            endpoint = `ws://127.0.0.1:${port}${url}`;
        } catch {
            await wait(100);
        }
    }
    if (!endpoint) throw new Error('Headless Chrome did not start');
    const socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = reject;
    });
    let id = 0;
    const pending = new Map();
    const exceptions = [];
    socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.method === 'Runtime.exceptionThrown')
            exceptions.push(
                message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text
            );
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
    };
    const send = (method, params = {}, sessionId) =>
        timeout(
            new Promise((resolve, reject) => {
                const next = ++id;
                pending.set(next, { resolve, reject });
                socket.send(JSON.stringify({ id: next, method, params, sessionId }));
            }),
            15000,
            method
        );
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const page = (method, params) => send(method, params, sessionId);
    const evaluate = async (expression) => {
        const result = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
    };
    const until = async (expression, ms = 10000) => {
        for (const end = Date.now() + ms; Date.now() < end; await wait(50)) if (await evaluate(expression)) return;
        throw new Error(`Phone condition did not become true: ${expression}`);
    };
    await page('Runtime.enable');
    await page('Page.enable');
    await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 1, mobile: true });
    await page('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    // A focused page, like the phone's browser in front: its text field keeps the focus and gets the keys.
    await page('Emulation.setFocusEmulationEnabled', { enabled: true });
    // Every message to the PC and every answer, timed, for the report.
    await page('Page.addScriptToEvaluateOnNewDocument', {
        source: `(() => {
            const log = (window.__log = []);
            const send = WebSocket.prototype.send;
            WebSocket.prototype.send = function (raw) {
                if (!this.__logged) {
                    this.__logged = true;
                    this.addEventListener('message', (event) => {
                        const message = JSON.parse(event.data);
                        if (message.type === 'ack') log.push({ in: message.id, ok: message.ok, result: message.result, error: message.error, at: performance.now() });
                    });
                }
                const message = JSON.parse(raw);
                log.push({ out: message.id, action: message.action, data: message.data, at: performance.now() });
                // Mouse clicks and buttons never reach the PC: they would land wherever its pointer is, maybe on
                // another app. They are answered as done.
                if (message.action === 'click' || message.action === 'button') {
                    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'ack', id: message.id, ok: true }) })));
                    return;
                }
                return send.call(this, raw);
            };
        })();`,
    });
    await page('Page.navigate', { url: host.url });
    await until("document.querySelector('#pair-form') && !document.querySelector('#pairing').hidden");
    await evaluate(
        `document.querySelector('#pair-name').value = 'Typing check'; document.querySelector('#pair-code').value = ${JSON.stringify(host.pairingCode)}; document.querySelector('#pair-form').requestSubmit();`
    );
    await until("document.querySelector('#connection').dataset.state === 'ready'");
    const editor = "document.querySelector('text-editor')";
    const anchor = String.fromCharCode(0x200b);
    return {
        exceptions,
        async open() {
            await evaluate('window.__log.length = 0; window.__renders = []');
            // Each state the editor is given, to trace what the phone showed.
            await evaluate(`(() => {
                const editor = document.querySelector('text-editor');
                if (editor.__traced) return;
                editor.__traced = true;
                const render = editor.render;
                editor.render = function (state) {
                    const { readable, blind, keep, field, text } = state;
                    window.__renders.push({ at: performance.now(), readable, blind, keep, field, text, composing: this.composing });
                    return render.call(this, state);
                };
            })()`);
            await evaluate("document.querySelector('#editor-open').click()");
            await until(`${editor}.view.open && !${editor}.view.reading`);
        },
        async close() {
            await evaluate(
                `document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); document.querySelector('#editor-text').blur();`
            );
            await until(`!${editor}.view.open`);
        },
        gboard: createGboard({ page, evaluate, wait }),
        /** A hardware keyboard; typo: the same with a wrong key erased with Backspace after the third. */
        async keys(text, style = 'keys', gap = 40) {
            const key = async (name, character) => {
                const code = name === 'Backspace' ? { windowsVirtualKeyCode: 8, code: 'Backspace' } : {};
                const typed = character ? { text: character, unmodifiedText: character } : {};
                await page('Input.dispatchKeyEvent', { type: 'keyDown', key: name, ...code, ...typed });
                await page('Input.dispatchKeyEvent', { type: 'keyUp', key: name, ...code });
                await wait(gap);
            };
            for (const [index, character] of [...text].entries()) {
                await key(character, character);
                if (style === 'typo' && index === 2) {
                    await key(/[0-9]/.test(character) ? '9' : 'x', /[0-9]/.test(character) ? '9' : 'x');
                    await key('Backspace');
                }
            }
        },
        /** A click from the trackpad: the app hears it, the PC never gets it (the check's fake, see startPhone). */
        async click() {
            await evaluate(
                "document.dispatchEvent(new CustomEvent('command', { detail: { action: 'click', data: { button: 'left' } } }))"
            );
            await wait(400);
        },
        /** Resolves once the phone has sent nothing for `quiet` ms and every message has its answer. */
        async quiet(quiet = 250, ms = 15000) {
            for (const end = Date.now() + ms; Date.now() < end; await wait(50)) {
                const state = await evaluate(`(() => {
                    // Reads go on all the time: only what changes the PC (and its answer) counts.
                    const log = window.__log;
                    const typing = new Set(log.filter(entry => 'out' in entry && entry.action !== 'mirror-read').map(entry => entry.out));
                    const answered = new Set(log.filter(entry => 'in' in entry).map(entry => entry.in));
                    const last = Math.max(0, ...log.filter(entry => typing.has(entry.out ?? entry.in)).map(entry => entry.at));
                    return { open: [...typing].some(id => !answered.has(id)), idle: performance.now() - last };
                })()`);
                if (!state.open && state.idle > quiet) return;
            }
            throw new Error('The phone never settled');
        },
        view: () =>
            evaluate(
                `({ text: document.querySelector('#editor-text').value.replaceAll(${JSON.stringify(anchor)}, ''), blind: ${editor}.view.blind })`
            ),
        state: () =>
            evaluate(
                `({ text: document.querySelector('#editor-text').value.replaceAll(${JSON.stringify(anchor)}, ''), blind: ${editor}.view.blind, readable: ${editor}.view.readable, kind: ${editor}.view.kind, log: window.__log, renders: window.__renders, now: performance.now() })`
            ),
        async stop() {
            socket.close();
            chrome.kill();
            await wait(300);
            await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
        },
    };
}

// Scenarios: steps the phone plays (see runCase), what the field must hold then (expected; the field's own typed
// and expected text when absent), and what a field needs for it (caret: one can move in it; text: it takes typed
// text, not only keys; lines: it holds several; pcCaret: the check can move the PC's caret; sync: the app can change
// its text; emoji: it shows emojis as inline images). listed: only in fields that name it (typing styles matter
// only where the field transforms or answers typing late). whole: typed blind, the phone must still show all of it.
// No settle between the steps of a fast scenario: typing races the PC's answers.
const pasted = Array(7).fill('The quick brown fox jumps over the lazy dog.').join(' ');
const scenarios = {
    // Smoke: can the field be typed into with Gboard, and does it hold what it should.
    smoke: { steps: [['typed', 'ime']] },
    // Typing styles: a hardware keyboard, a typo erased, Gboard slowly (late answers show), autocorrected words.
    keys: { listed: true, steps: [['typed', 'keys']] },
    typo: { listed: true, steps: [['typed', 'typo']] },
    slow: { listed: true, steps: [['typed', 'ime', 250]] },
    correct: { listed: true, steps: [['typed', 'correct']] },
    // Special characters: accents composed, a combining accent, a ZWJ family and a skin tone committed whole.
    accents: {
        needs: ['caret', 'text'],
        steps: [
            ['type', 'déjà vu '],
            ['commit', 'é '],
            ['commit', '👨‍👩‍👧 👍🏽'],
        ],
        expected: 'déjà vu é 👨‍👩‍👧 👍🏽',
    },
    // Backspace erases an emoji whole, whatever its length in UTF-16 (a ZWJ family is 8 units).
    'emoji-erase': {
        needs: ['caret', 'text'],
        steps: [
            ['commit', 'ok 👍🏽 👨‍👩‍👧'],
            ['key', 'Backspace'],
            ['key', 'Backspace'],
            ['key', 'Backspace'],
        ],
        expected: 'ok ',
    },
    // Replacements: autocorrection as each word is committed; a suggestion tapped on an earlier word, the caret
    // going after it, typing going on there; typing over a selection.
    autocorrect: { needs: 'text', steps: [['correct', 'quick brown fox']], expected: 'quick brown fox' },
    suggestion: {
        needs: ['caret', 'text'],
        steps: [
            ['type', 'teh cat'],
            ['tap', 1],
            ['replace', 'teh', 'the'],
            ['type', ' big'],
        ],
        expected: 'the big cat',
    },
    'over-selection': {
        needs: ['caret', 'text'],
        steps: [
            ['type', 'hello big world'],
            ['select', 6, 9],
            ['type', 'small'],
        ],
        expected: 'hello small world',
    },
    'double-space': {
        needs: ['caret', 'text'],
        steps: [['type', 'hello'], ['double-space'], ['type', 'next']],
        expected: 'hello. next',
    },
    dictate: { needs: 'text', steps: [['dictate', 'hello there world']], expected: 'hello there world' },
    paste: { needs: ['caret', 'text'], steps: [['commit', pasted]], expected: pasted },
    // Selections: select all then erase and type; the Backspace swipe (whole words selected, deleted on lifting).
    'select-all': {
        needs: 'caret',
        steps: [['type', 'one two'], ['select-all'], ['key', 'Backspace'], ['type', 'fresh']],
        expected: 'fresh',
    },
    swipe: {
        needs: 'caret',
        steps: [
            ['type', 'hello big world'],
            ['swipe', 2],
            ['type', 'there'],
        ],
        expected: 'hello there',
    },
    // The space bar's cursor, fast (three characters a step) to the left, slower to the right.
    drag: {
        needs: 'caret',
        steps: [
            ['type', 'hello wide world'],
            ['drag', -11, { per: 3, gap: 20 }],
            ['type', ','],
            ['drag', 5, { per: 2, gap: 40 }],
            ['type', '!'],
        ],
        expected: 'hello, wide! world',
    },
    // Concurrency: typing with no pause at all; a swipe right after typing, before the PC answered it.
    burst: { needs: 'text', steps: [['type', 'the quick brown fox jumps', 0]], expected: 'the quick brown fox jumps' },
    race: {
        needs: 'caret',
        fast: true,
        steps: [
            ['type', 'hello big world', 10],
            ['swipe', 1, 30],
            ['type', 'there', 10],
        ],
        expected: 'hello big there',
    },
    // Line breaks: a blank line between two; Enter at the start, then two at the end, typing on the last blank line;
    // a selection across lines typed over; select all with a blank line last.
    lines: {
        needs: 'lines',
        steps: [
            ['type', 'one'],
            ['key', 'Enter'],
            ['key', 'Enter'],
            ['type', 'three'],
        ],
        expected: 'one\n\nthree',
    },
    'line-edges': {
        needs: 'lines',
        steps: [
            ['type', 'body'],
            ['tap', 0],
            ['key', 'Enter'],
            ['tap', 'end'],
            ['key', 'Enter'],
            ['key', 'Enter'],
            ['type', 'end'],
        ],
        expected: '\nbody\n\nend',
    },
    'select-lines': {
        needs: 'lines',
        steps: [
            ['type', 'one'],
            ['key', 'Enter'],
            ['type', 'two'],
            ['key', 'Enter'],
            ['type', 'three'],
            ['select', 2, 10],
            ['type', 'X'],
        ],
        expected: 'onXree',
    },
    'blank-end': {
        needs: 'lines',
        steps: [
            ['type', 'top'],
            ['key', 'Enter'],
            ['key', 'Enter'],
        ],
        expected: 'top\n\n',
    },
    'select-all-lines': {
        needs: 'lines',
        steps: [['type', 'a'], ['key', 'Enter'], ['key', 'Enter'], ['select-all'], ['type', 'z']],
        expected: 'z',
    },
    // Sync: the app changes the text (another device, a reply), blank lines included; the phone shows it and typing
    // goes on in it. A click on the PC moves its caret into the text typed (the phone follows, or starts afresh).
    sync: {
        needs: 'sync',
        steps: [
            ['content', ['first', '', 'second']],
            ['tap', 'end'],
            ['type', ' more'],
        ],
        expected: 'first\n\nsecond more',
    },
    'sync-blank-end': {
        needs: ['sync', 'lines'],
        steps: [
            ['content', ['top', '', '']],
            ['tap', 'end'],
            ['type', 'x'],
        ],
        expected: 'top\n\nx',
    },
    click: {
        needs: 'pcCaret',
        steps: [['type', 'hello world'], ['pcCaret', 5], ['click'], ['type', ',']],
        expected: 'hello, world',
    },
    // Closed and opened again: the phone knows nothing of a blind field's text, and moves past it.
    reopen: {
        needs: 'caret',
        steps: [['type', 'hello world'], ['reopen'], ['drag', -6], ['type', ',']],
        expected: 'hello, world',
    },
    // Typed blind, the text stays on the phone as long as the PC's focus and caret stay with it, polls going on.
    linger: {
        listed: true,
        needs: 'caret',
        steps: [
            ['type', 'hello world'],
            ['idle', 5000],
        ],
        expected: 'hello world',
        whole: true,
    },
    // Inline emoji images (Discord's Slate, Slack's Quill): the phone shows each as the emoji its name stands for, a
    // custom one by its name (":partyparrot:"), several side by side or apart, over several lines; the caret steps
    // over each whole; typing goes between two; Backspace and a selection take each whole, across lines too; a tap
    // in a custom one's name puts the caret beside it, a selection starting in it (a long press) takes it whole.
    'emoji-row': {
        needs: 'emoji',
        steps: [
            ['content', ['a :joy::joy: b :heart:', '', ':partyparrot: end :smile:']],
            ['tap', 'end'],
            ['type', '!'],
        ],
        expected: 'a :joy::joy: b :heart:\n\n:partyparrot: end :smile:!',
    },
    'emoji-between': {
        needs: 'emoji',
        steps: [
            ['content', ['a :joy::joy: b']],
            ['tap', 4],
            ['type', 'X'],
        ],
        expected: 'a :joy:X:joy: b',
    },
    'emoji-drag': {
        needs: 'emoji',
        steps: [
            ['content', ['a :joy: b']],
            ['tap', 0],
            ['drag', 3, { gap: 80 }],
            ['type', 'X'],
        ],
        expected: 'a :joy:X b',
    },
    'emoji-backspace': {
        needs: 'emoji',
        steps: [
            ['content', ['ok :joy: :smile:']],
            ['tap', 'end'],
            ['key', 'Backspace'],
            ['key', 'Backspace'],
            ['key', 'Backspace'],
        ],
        expected: 'ok ',
    },
    'emoji-select': {
        needs: 'emoji',
        steps: [
            ['content', ['a :joy: b :smile: c']],
            ['select', 2, 9],
            ['type', 'X'],
        ],
        expected: 'a X c',
    },
    'emoji-select-lines': {
        needs: 'emoji',
        steps: [
            ['content', ['x :joy:', ':smile: y']],
            ['select', 2, 7],
            ['type', 'Z'],
        ],
        expected: 'x Z y',
    },
    'emoji-custom-tap': {
        needs: 'emoji',
        steps: [
            ['content', ['go :partyparrot: now']],
            ['tap', 6],
            ['type', 'yo'],
        ],
        expected: 'go yo:partyparrot: now',
    },
    'emoji-custom-select': {
        needs: 'emoji',
        steps: [
            ['content', ['go :partyparrot: now']],
            ['select', 5, 10],
            ['type', 'yo'],
        ],
        expected: 'go yo now',
    },
    // A line of emojis side by side erased: Backspace held (one after the other, fast), or the line selected.
    'emoji-run-erase': {
        needs: 'emoji',
        fast: true,
        steps: [
            ['content', ['x', ':joy::joy::sweat_smile::joy::smile:']],
            ['tap', 'end'],
            ...Array(6).fill(['key', 'Backspace']),
        ],
        expected: 'x',
    },
    'emoji-run-select': {
        needs: 'emoji',
        steps: [
            ['content', ['x', ':joy::joy::sweat_smile::joy::smile:', 'y']],
            ['select', 2, 12],
            ['key', 'Backspace'],
        ],
        expected: 'x\n\ny',
    },
    'emoji-type': {
        needs: 'emoji',
        steps: [
            ['content', ['hi']],
            ['tap', 'end'],
            ['commit', ' 😂'],
        ],
        expected: 'hi 😂',
    },
};

/** How long the PC took to answer each message, by action, in ms. */
function latencies(log) {
    const sent = new Map(log.filter((entry) => 'out' in entry).map((entry) => [entry.out, entry]));
    const byAction = {};
    for (const answer of log.filter((entry) => 'in' in entry)) {
        const message = sent.get(answer.in);
        if (message) (byAction[message.action] ??= []).push(Math.round(answer.at - message.at));
    }
    return byAction;
}

/** What the phone sent, in short: typed text, keys, edits (with how the PC answered). */
function summarize(log) {
    const answers = new Map(log.filter((entry) => 'in' in entry).map((entry) => [entry.in, entry]));
    return log
        .filter((entry) => 'out' in entry && !['mirror-read', 'mirror-close', 'media-state'].includes(entry.action))
        .map((entry) => {
            const answer = answers.get(entry.out);
            const failed = answer && !answer.ok ? `!${answer.error}` : '';
            if (entry.action === 'text') {
                const { backspace, delete: forward, text } = entry.data;
                return `text(${backspace ? `⌫${backspace}` : ''}${forward ? `⌦${forward}` : ''}${JSON.stringify(text)})${failed}`;
            }
            if (entry.action === 'mirror-edit') {
                const accepted = answer?.result?.accepted;
                return `edit(${entry.data.start}-${entry.data.end}${JSON.stringify(entry.data.text)})${accepted ? '' : `✗${JSON.stringify(answer?.result?.snapshot?.text)}`}${failed}`;
            }
            return `${entry.action}(${JSON.stringify(entry.data?.key ?? entry.data)})${failed}`;
        })
        .join(' ');
}

const results = [];
/** The scenarios a field gets: smoke, then its edge tier (see scenarios), narrowed by --mode. */
function scenariosFor(entry, target) {
    // text: fields take typed text, not only keys (all but the keys-only terminal).
    const has = (need) => (need === 'text' ? entry.text !== false : entry[need]);
    const edge = tiers.includes('edge') && (!quick || (target === 'chrome' && quickEdge.includes(entry.id)));
    return Object.entries(scenarios)
        .filter(([name, scenario]) =>
            name === 'smoke' ? tiers.includes('smoke')
            : !edge || !entry.edge || entry.skip?.includes(name) ? false
            : entry.edge === true ? !scenario.listed && [scenario.needs ?? []].flat().every(has)
            : entry.edge.includes(name) && [scenario.needs ?? []].flat().every(has)
        )
        .map(([name]) => name)
        .filter((name) => !onlyModes || onlyModes.includes(name));
}

async function runCase({
    target,
    entry,
    mode,
    focus,
    value,
    phone,
    windows,
    moveCaret = () => Promise.reject(new Error('No PC caret here')),
    content = () => Promise.reject(new Error('The app cannot change this field')),
    title = `${marker} ${entry.id}`,
}) {
    const scenario = scenarios[mode];
    await focus(entry.id);
    await windows.ask({ do: 'bring', title });
    // A window coming to the foreground can give the focus back to its first field (WinForms): focus again.
    await focus(entry.id);
    await wait(100);
    // A typing scenario types the field's own text; the others their own.
    const typing = !('expected' in scenario);
    const expected = typing ? entry.expected : scenario.expected;
    const check = typing && entry.check ? entry.check : (got) => got === expected;
    // The phone shows the PC's text, or what was typed blind: all of it, or its end once the focus moved on (a code's
    // next box). Moving the caret or deleting leaves only part of the text blind: any part of the final text.
    // An emoji image shows on the phone as the emoji its name stands for (host/windows/emoji-names.json), else by name.
    const plain = (text) =>
        entry.emoji ? text.replace(/:([a-z0-9_+-]+):/g, (name, code) => emojiNames[code] ?? name) : text;
    const echoes = ({ text, blind }, got) =>
        blind ?
            scenario.whole ? text === expected
            : typing ? entry.typed.endsWith(text)
            : expected.includes(text)
        : typing ? got.endsWith(text)
        : plain(text) === plain(got);
    const { gboard } = phone;
    const steps = {
        typed: (style, gap = 40) =>
            style === 'ime' ? gboard.type(entry.typed, gap)
            : style === 'correct' ? gboard.typeCorrected(entry.typed, gap)
            : phone.keys(entry.typed, style, gap),
        type: (text, gap) => gboard.type(text, gap),
        correct: (text) => gboard.typeCorrected(text),
        commit: (text) => gboard.commit(text),
        dictate: (phrase) => gboard.dictate(phrase),
        replace: (from, to) => gboard.replaceWord(from, to),
        'double-space': () => gboard.doubleSpace(),
        tap: (position) => gboard.tap(position),
        drag: (count, options) => gboard.drag(count, options),
        select: (start, end) => gboard.selectRange(start, end),
        'select-all': () => gboard.selectAll(),
        swipe: (count, gap) => gboard.swipeWords(count, gap),
        key: (name) => gboard.key(name),
        pcCaret: (position) => moveCaret(entry.id, position),
        click: () => phone.click(),
        idle: (ms) => wait(ms),
        // The app's change shows on the phone before anything is typed in it.
        content: async (lines) => {
            await content(entry.id, lines);
            const wanted = plain(lines.join('\n'));
            for (const end = Date.now() + 5000; plain((await phone.view()).text) !== wanted; await wait(50))
                if (Date.now() > end) throw new Error(`The phone never showed ${JSON.stringify(wanted)}`);
        },
        reopen: async () => {
            await phone.quiet(400);
            await phone.close();
            await wait(300);
            await phone.open();
        },
    };
    await phone.open();
    const started = performance.now();
    let problem = '',
        got,
        view;
    try {
        for (const [step, ...args] of scenario.steps) {
            await steps[step](...args);
            if (!scenario.fast) await phone.quiet();
        }
        // Done as soon as the PC holds the expected text and the phone shows it, twice in a row (a letter arriving
        // late would show in between); given up after a while.
        for (let end = Date.now() + 8000, matched = 0; ; await wait(150)) {
            await phone.quiet(200);
            got = await value(entry.id);
            view = await phone.view();
            matched = check(got) && echoes(view, got) ? matched + 1 : 0;
            if (matched === 2 || Date.now() > end) break;
        }
    } catch (error) {
        problem = error.message;
    }
    const phoneState = await phone.state();
    await phone.close().catch(() => {});
    got = await value(entry.id);
    view ??= phoneState;
    const result = {
        target,
        id: entry.id,
        mode,
        echo: echoes(view, got),
        // The phone was told what the field takes (its keyboard), where the fixture names it.
        kind: !entry.kind || phoneState.kind === entry.kind,
        pass: check(got) && !problem,
        problem,
        got,
        expected,
        phone: view.text,
        blind: view.blind,
        sent: summarize(phoneState.log),
        latency: latencies(phoneState.log),
        // The PC's last answers to reads, for diagnosis (report only).
        reads: phoneState.log
            .filter((entry) => 'in' in entry && entry.result && 'readable' in entry.result)
            .slice(-4)
            .map((entry) => entry.result),
        errors: [...new Set(phoneState.log.filter((entry) => entry.error).map((entry) => entry.error))],
        ms: Math.round(performance.now() - started),
    };
    result.pass &&= result.echo && result.kind;
    results.push(result);
    const mark = result.pass ? 'ok  ' : 'FAIL';
    console.log(
        `${mark} ${target.padEnd(8)} ${entry.id.padEnd(10)} ${mode.padEnd(16)} ${result.blind ? 'blind' : 'read '} ${JSON.stringify(got)}${result.pass ? '' : ` ≠ ${JSON.stringify(expected)}`}  phone ${JSON.stringify(result.phone)}  ${result.ms}ms`
    );
    if (problem) console.log(`       ${problem}`);
    if (result.errors.length) console.log(`       PC errors: ${result.errors.join(' | ')}`);
    if (!result.pass || process.argv.includes('--verbose')) console.log(`       ${result.sent}`);
    // What the phone was shown, timed from the end of the run backwards.
    if (!result.echo || process.argv.includes('--trace'))
        for (const { at, ...render } of phoneState.renders ?? [])
            console.log(`         ${Math.round(at - phoneState.now)}ms ${JSON.stringify(render)}`);
}

await cleanupBrowsers();
const host = await startHost();
const windows = lineProcess('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(root, 'tests/checks/typing-windows.ps1'),
]);
let phone;
const cleanup = async () => {
    await windows.ask({ do: 'close' }).catch(() => {});
    windows.stop();
    await phone?.stop().catch(() => {});
    await host.stop();
    await cleanupBrowsers();
};
process.once('SIGINT', async () => {
    await cleanup();
    process.exit(130);
});
try {
    phone = await startPhone(host);
    const selected = (cases, target) =>
        cases.filter((entry) => (!onlyCases || onlyCases.includes(entry.id)) && scenariosFor(entry, target).length);
    for (const target of targets) {
        // Windows' own Notepad, a fresh one for each run, on an empty test file named with the marker (its title).
        if (target === 'notepad') {
            const entry = {
                id: 'notepad',
                typed: 'hello world',
                expected: 'hello world',
                caret: true,
                lines: true,
                edge: true,
            };
            for (const mode of selected([entry], target).length ? scenariosFor(entry, target) : []) {
                const file = path.join(tmpdir(), `${marker}-notepad.txt`);
                await writeFile(file, '');
                const notepad = spawn('notepad.exe', [file], { stdio: 'ignore' });
                try {
                    await runCase({
                        target,
                        entry,
                        mode,
                        phone,
                        windows,
                        title: `${marker}-notepad`,
                        focus: () => wait(300),
                        value: () => windows.ask({ do: 'window-text', title: `${marker}-notepad` }),
                    });
                } finally {
                    notepad.kill();
                    await wait(200);
                    await rm(file, { force: true });
                }
            }
            continue;
        }
        // VS Code: its editor takes typing through a hidden input the phone cannot read (typing blind). A fresh
        // instance with a profile of its own, no extensions or suggestions, on a test file named with the marker
        // (its title) that saves itself: the file holds what was typed. Emptied on disk before each run.
        if (target === 'vscode') {
            const code = path.join(process.env.LOCALAPPDATA ?? '', 'Programs/Microsoft VS Code/Code.exe');
            if (!existsSync(code)) {
                console.log('vscode: not installed, skipped');
                continue;
            }
            // Typed blind: the scenarios where the phone has to know what it typed.
            const entry = {
                id: 'editor',
                typed: 'hello world',
                expected: 'hello world',
                caret: true,
                lines: true,
                edge: ['drag', 'reopen', 'lines'],
            };
            if (!selected([entry], target).length) continue;
            const profile = await temp('vscode');
            const file = path.join(profile, `${marker}-vscode.txt`);
            await mkdir(path.join(profile, 'data', 'User'), { recursive: true });
            await writeFile(
                path.join(profile, 'data', 'User', 'settings.json'),
                JSON.stringify({
                    'files.autoSave': 'afterDelay',
                    'files.autoSaveDelay': 50,
                    'editor.quickSuggestions': { other: 'off', comments: 'off', strings: 'off' },
                    'editor.suggestOnTriggerCharacters': false,
                    'editor.wordBasedSuggestions': 'off',
                    'editor.autoClosingBrackets': 'never',
                    'editor.autoClosingQuotes': 'never',
                    'workbench.startupEditor': 'none',
                    'workbench.tips.enabled': false,
                    'window.restoreWindows': 'none',
                    'security.workspace.trust.enabled': false,
                    'update.mode': 'none',
                    'telemetry.telemetryLevel': 'off',
                    'chat.disableAIFeatures': true,
                })
            );
            await writeFile(file, '');
            const vscode = spawn(
                code,
                [
                    '--user-data-dir',
                    path.join(profile, 'data'),
                    '--extensions-dir',
                    path.join(profile, 'extensions'),
                    '--disable-extensions',
                    '--new-window',
                    '--skip-welcome',
                    '--skip-release-notes',
                    file,
                ],
                {
                    stdio: 'ignore',
                    // Run from VS Code's own terminal, its variables would make Code.exe run as Node or hand the
                    // file to that window.
                    env: Object.fromEntries(
                        Object.entries(process.env).filter(([name]) => !/^(VSCODE_|ELECTRON_)/i.test(name))
                    ),
                }
            );
            const title = `${marker}-vscode`;
            try {
                for (const mode of scenariosFor(entry, target))
                    await runCase({
                        target,
                        entry,
                        mode,
                        phone,
                        windows,
                        title,
                        focus: async () => {
                            await writeFile(file, '');
                            // The first time, VS Code takes a few seconds to show its window.
                            for (let attempt = 0; ; attempt++)
                                try {
                                    await windows.ask({ do: 'bring', title });
                                    break;
                                } catch (error) {
                                    if (attempt >= 15) throw error;
                                }
                            // Long enough for VS Code to load the emptied file.
                            await wait(1200);
                        },
                        // VS Code saves Windows line breaks.
                        value: async () => {
                            await wait(300);
                            return (await readFile(file, 'utf8')).replaceAll('\r\n', '\n');
                        },
                    });
            } finally {
                spawn('taskkill', ['/PID', String(vscode.pid), '/T', '/F'], { stdio: 'ignore' });
                await wait(1000);
                await rm(profile, { recursive: true, force: true }).catch(() => {});
            }
            continue;
        }
        if (target in nativeCases) {
            await windows.ask({ do: 'open', window: target, marker });
            for (const entry of selected(nativeCases[target], target))
                for (const mode of scenariosFor(entry, target))
                    await runCase({
                        target,
                        entry,
                        mode,
                        phone,
                        windows,
                        focus: (id) => windows.ask({ do: 'focus', window: target, id }),
                        value: (id) => windows.ask({ do: 'value', window: target, id }),
                    });
            await windows.ask({ do: 'close' });
            continue;
        }
        if (!installed(target)) {
            console.log(`${target}: not installed, skipped`);
            continue;
        }
        const fixture = await startFixturePage();
        const browser = await openBrowser(target, fixture.url, { app: false });
        try {
            const cases = selected(await fixture.cases(), target);
            for (const entry of cases)
                for (const mode of scenariosFor(entry, target))
                    await runCase({
                        target,
                        entry,
                        mode,
                        phone,
                        windows,
                        focus: (id) => fixture.command({ do: 'focus', id }),
                        value: (id) => fixture.command({ do: 'value', id }).then((reply) => reply.value),
                        moveCaret: (id, position) => fixture.command({ do: 'caret', id, position }),
                        content: (id, lines) => fixture.command({ do: 'content', id, lines }),
                    });
            // Last: once the address bar has the focus, the page cannot take it back by itself.
            for (const entry of selected(addressCases, target))
                for (const mode of scenariosFor(entry, target))
                    await runCase({
                        target,
                        entry,
                        mode,
                        phone,
                        windows,
                        title: marker,
                        focus: () => windows.ask({ do: 'address', title: marker, action: 'focus' }),
                        value: () => windows.ask({ do: 'address', title: marker, action: 'value' }),
                    });
            await fixture.command({ do: 'end' });
        } finally {
            await browser.close();
            await fixture.close();
        }
    }
} finally {
    if (phone?.exceptions.length) console.log('Phone exceptions:', phone.exceptions);
    await cleanup();
}
// The PC's answer times over the whole run, per target and action: median and slowest tenth.
const percentile = (values, share) =>
    values.toSorted((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * share))];
console.log('\nPC answer times (ms): median / 90th percentile / count');
for (const target of new Set(results.map((result) => result.target))) {
    const byAction = {};
    for (const result of results.filter((entry) => entry.target === target))
        for (const [action, values] of Object.entries(result.latency)) (byAction[action] ??= []).push(...values);
    const line = Object.entries(byAction)
        .map(([action, values]) => `${action} ${percentile(values, 0.5)}/${percentile(values, 0.9)}/${values.length}`)
        .join('  ');
    console.log(`  ${target.padEnd(8)} ${line}`);
}
const failures = results.filter((result) => !result.pass);
const report = path.join(tmpdir(), 'remote-smart-trackpad-typing-report.json');
await writeFile(report, JSON.stringify(results, null, 2));
console.log(
    `\n${failures.length ? `${failures.length} failed` : 'No failure'} in ${results.length} runs. Report: ${report}`
);
process.exitCode = failures.length ? 1 : 0;
