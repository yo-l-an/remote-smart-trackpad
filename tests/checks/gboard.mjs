// Gboard on Android, as Chrome sees it in the phone app's text field (#editor-text), for tests/checks/typing-check.mjs:
// the same events a real Gboard causes, sent through the DevTools protocol (page) to the headless phone.
// - Words are composed letter by letter, then committed (Input.imeSetComposition, Input.insertText).
// - A suggestion or an autocorrection replaces text already there: Android's setComposingRegion over it, then the
//   commit (imeSetComposition with replacementStart/End).
// - The space bar's cursor moves the selection, several characters per step when the finger goes fast.
// - The Backspace swipe selects whole words backwards while the finger drags, and deletes them when it lifts.
// Positions are in the text the phone shows: the field's zero-width anchors (docs/adr/0001) are counted for the
// keyboard, not by the test.
const anchor = '​';

export function createGboard({ page, evaluate, wait }) {
    /** Runs `body` in the page with `field` (the text field) and `lead` (anchors before the text) defined. */
    const inField = (body) =>
        evaluate(`(() => {
            const field = document.querySelector('#editor-text');
            const lead = field.value.match(/^${anchor}*/)[0].length;
            ${body}
        })()`);
    const caret = () => inField('return field.selectionStart - lead;');
    const text = () => inField(`return field.value.replaceAll('${anchor}', '');`);
    const select = (start, end = start) => inField(`field.setSelectionRange(lead + ${start}, lead + ${end});`);
    const key = async (name) => {
        const codes = { Backspace: 8, Enter: 13 };
        const event = { key: name, code: name, windowsVirtualKeyCode: codes[name] };
        if (name === 'Enter') Object.assign(event, { text: '\r', unmodifiedText: '\r' });
        await page('Input.dispatchKeyEvent', { type: 'keyDown', ...event });
        await page('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
    };
    /** Composes `word` letter by letter, then commits `committed` (the word itself, or its correction). */
    async function compose(word, committed = word, gap = 40) {
        for (let length = 1; length <= word.length; length++) {
            await page('Input.imeSetComposition', {
                text: word.slice(0, length),
                selectionStart: length,
                selectionEnd: length,
            });
            await wait(gap);
        }
        await page('Input.insertText', { text: committed });
        await wait(gap);
    }
    return {
        caret,
        text,
        key,
        /** Words composed and committed, anything else (spaces, digits, signs) committed as is. */
        async type(typed, gap = 40) {
            for (const piece of typed.match(/[\p{L}]+|[^\p{L}]/gu) ?? []) {
                if (/\p{L}/u.test(piece)) await compose(piece, piece, gap);
                else {
                    await page('Input.insertText', { text: piece });
                    await wait(gap);
                }
            }
        },
        /** Each word composed misspelled (its last two letters swapped), the autocorrection committing it right. */
        async typeCorrected(typed, gap = 40) {
            for (const piece of typed.match(/[\p{L}]+|[^\p{L}]/gu) ?? []) {
                if (!/\p{L}/u.test(piece)) {
                    await page('Input.insertText', { text: piece });
                    await wait(gap);
                } else
                    await compose(
                        piece.length > 2 ? piece.slice(0, -2) + piece.at(-1) + piece.at(-2) : piece,
                        piece,
                        gap
                    );
            }
        },
        /** Commits text at once: a suggestion, an emoji from the emoji keyboard, the clipboard. */
        async commit(committed) {
            await page('Input.insertText', { text: committed });
            await wait(60);
        },
        /** Voice typing: the phrase grows word by word as a composition, then is committed whole. */
        async dictate(phrase, gap = 120) {
            const words = phrase.split(' ');
            for (let count = 1; count <= words.length; count++) {
                const partial = words.slice(0, count).join(' ');
                await page('Input.imeSetComposition', {
                    text: partial,
                    selectionStart: partial.length,
                    selectionEnd: partial.length,
                });
                await wait(gap);
            }
            await page('Input.insertText', { text: phrase });
            await wait(gap);
        },
        /**
         * A suggestion or autocorrection replacing the word `from` (its first occurrence) with `to`, the caret
         * staying where it is otherwise: Android marks the word as the composition, then commits the replacement.
         */
        async replaceWord(from, to) {
            const shown = await text();
            const start = shown.indexOf(from);
            if (start < 0) throw new Error(`No "${from}" to replace`);
            const lead = await inField('return lead;');
            await page('Input.imeSetComposition', {
                text: from,
                selectionStart: from.length,
                selectionEnd: from.length,
                replacementStart: lead + start,
                replacementEnd: lead + start + from.length,
            });
            await wait(60);
            await page('Input.insertText', { text: to });
            await wait(60);
        },
        /** Two spaces after a word: Gboard turns them into a period and a space. */
        async doubleSpace() {
            await page('Input.insertText', { text: ' ' });
            await wait(80);
            const at = (await inField('return field.selectionStart;')) - 1;
            await page('Input.imeSetComposition', {
                text: ' ',
                selectionStart: 1,
                selectionEnd: 1,
                replacementStart: at,
                replacementEnd: at + 1,
            });
            await wait(30);
            await page('Input.insertText', { text: '. ' });
            await wait(80);
        },
        /** A tap in the text: the caret jumps there ('end': after the last character). */
        async tap(position) {
            await select(position === 'end' ? (await text()).length : position);
            await wait(150);
        },
        /** The space bar's cursor: `steps` characters (negative: left), `per` characters a step, `gap` ms apart. */
        async drag(steps, { per = 1, gap = 60 } = {}) {
            let left = Math.abs(steps);
            while (left > 0) {
                const step = Math.min(per, left);
                await inField(
                    `const at = field.selectionStart + ${Math.sign(steps) * step}; field.setSelectionRange(at, at);`
                );
                left -= step;
                await wait(gap);
            }
        },
        /** Select all, from the keyboard's or the field's menu. */
        async selectAll() {
            await select(0, (await text()).length);
            await wait(150);
        },
        /** A range selected by dragging its handles. */
        async selectRange(start, end) {
            await select(start, end);
            await wait(150);
        },
        /** The Backspace swipe: whole words selected backwards, one at a time, then deleted as the finger lifts. */
        async swipeWords(count, gap = 120) {
            const end = await caret();
            const shown = await text();
            let start = end;
            for (let word = 0; word < count; word++) {
                while (start > 0 && shown[start - 1] === ' ') start--;
                while (start > 0 && shown[start - 1] !== ' ') start--;
                await select(start, end);
                await wait(gap);
            }
            await key('Backspace');
            await wait(80);
        },
    };
}
