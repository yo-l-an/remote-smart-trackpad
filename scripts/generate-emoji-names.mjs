import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// The emoji an app's inline emoji image stands for, by its name (host/windows/mirror-rules.psm1, Get-ObjectDisplay):
// the shortcodes Slack (iamcal), Discord (close to joypixels), GitHub and emojibase use, and CLDR's names, spaces as
// underscores. The first set to name a shortcode wins, in that order. Skin tones included.
const require = createRequire(import.meta.url);
const load = async (name) => JSON.parse(await readFile(require.resolve(`emojibase-data/en/${name}`), 'utf8'));
const emojis = new Map();
for (const entry of await load('compact.json'))
    for (const each of [entry, ...(entry.skins ?? [])]) emojis.set(each.hexcode, each);
const names = {};
const add = (code, hexcode) => {
    const key = code.toLowerCase().replaceAll(' ', '_');
    if (!(key in names) && emojis.has(hexcode)) names[key] = emojis.get(hexcode).unicode;
};
for (const preset of ['iamcal', 'joypixels', 'github', 'emojibase', 'cldr'])
    for (const [hexcode, codes] of Object.entries(await load(`shortcodes/${preset}.json`)))
        for (const code of [codes].flat()) add(code, hexcode);
for (const emoji of emojis.values()) if (emoji.label) add(emoji.label, emoji.hexcode);
await writeFile(new URL('../host/windows/emoji-names.json', import.meta.url), JSON.stringify(names));
console.log(`${Object.keys(names).length} names`);
