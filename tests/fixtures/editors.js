// The real rich-text editors of the typing fixtures (tests/fixtures/typing.html), bundled by tests/checks/typing-check.mjs:
// tiptap (ProseMirror, as Claude Desktop's prompt box) and Slate with inline emoji images (as Discord's message box).
// Their own code handles Enter, Backspace, blank lines and emojis, as in those apps. Each registers itself in
// window.fixtureEditors under its case id: element (where the keyboard goes), clear(), value() (its text, one line
// per paragraph, an emoji as its name), setContent(lines) (its text set by the app itself, as another device or a
// reply would: a line per paragraph, ":name:" an emoji) and caret(offset) (in value()'s text).
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { createElement as h, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { createEditor, Editor as SlateEditor, Node, Transforms } from 'slate';
import { Editable, ReactEditor, Slate, withReact } from 'slate-react';
import { withHistory } from 'slate-history';

const editors = (window.fixtureEditors = {});

function mountTiptap(id, host) {
    const editor = new Editor({ element: host, extensions: [StarterKit] });
    // Positions of value()'s text in the document: each paragraph's text starts one past the previous one's end.
    const positionOf = (offset) => {
        let left = offset,
            found = null;
        editor.state.doc.forEach((paragraph, start) => {
            if (found !== null) return;
            const length = paragraph.textContent.length;
            if (left <= length) found = start + 1 + left;
            else left -= length + 1;
        });
        return found ?? editor.state.doc.content.size - 1;
    };
    editors[id] = {
        element: () => host.querySelector('[contenteditable]'),
        clear: () => editor.commands.clearContent(),
        value: () => editor.getText({ blockSeparator: '\n' }),
        setContent: (lines) =>
            editor.commands.setContent(
                lines.map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] }))
            ),
        caret: (offset) => editor.commands.setTextSelection(positionOf(offset)),
    };
}

// Slate as Discord sets it up: paragraphs of text and inline void emojis, an image with the emoji's name as its alt.
const emojiPattern = /(:[a-z0-9_+-]+:)/;
const toNodes = (lines) =>
    lines.map((line) => ({
        type: 'paragraph',
        children: line
            .split(emojiPattern)
            .filter((piece, index, pieces) => piece || index === 0 || index === pieces.length - 1)
            .map((piece) =>
                emojiPattern.test(piece) ? { type: 'emoji', name: piece, children: [{ text: '' }] } : { text: piece }
            ),
    }));
const textOf = (node) =>
    node.type === 'emoji' ? node.name
    : 'text' in node ? node.text
    : node.children.map(textOf).join('');
const image =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3Crect width='1' height='1' fill='%23fc0'/%3E%3C/svg%3E";

function SlateField({ id }) {
    const editor = useMemo(() => {
        const made = withHistory(withReact(createEditor()));
        const { isInline, isVoid } = made;
        made.isInline = (element) => element.type === 'emoji' || isInline(element);
        made.isVoid = (element) => element.type === 'emoji' || isVoid(element);
        return made;
    }, []);
    editors[id] = {
        element: () => ReactEditor.toDOMNode(editor, editor),
        clear: () => editors[id].setContent(['']),
        value: () => editor.children.map(textOf).join('\n'),
        setContent: (lines) => {
            Transforms.deselect(editor);
            editor.children = toNodes(lines);
            editor.onChange();
            Transforms.select(editor, SlateEditor.end(editor, []));
            ReactEditor.focus(editor);
        },
        caret: (offset) => {
            // Walks value()'s text to the point at `offset`: within a text node, or before an emoji.
            let left = offset;
            for (const [paragraph, path] of SlateEditor.nodes(editor, {
                at: [],
                match: (node) => node.type === 'paragraph',
            })) {
                const length = textOf(paragraph).length;
                if (left <= length) {
                    for (const [node, at] of Node.texts(paragraph)) {
                        const parent = Node.parent(paragraph, at);
                        const size = parent.type === 'emoji' ? parent.name.length : node.text.length;
                        if (left <= size && parent.type !== 'emoji')
                            return Transforms.select(editor, { path: [...path, ...at], offset: left });
                        left -= size;
                    }
                    return Transforms.select(editor, SlateEditor.end(editor, path));
                }
                left -= length + 1;
            }
        },
    };
    const renderElement = ({ attributes, children, element }) =>
        element.type === 'emoji' ?
            // Discord's markup (tests/fixtures/placeholders.html): the image in a container of its own, Slate's
            // spacer beside it.
            h(
                'span',
                { ...attributes, contentEditable: false },
                h(
                    'span',
                    { className: 'emoji-container' },
                    h('img', {
                        className: 'emoji',
                        alt: element.name,
                        src: image,
                        width: 22,
                        height: 22,
                        draggable: false,
                    })
                ),
                children
            )
        :   h('div', attributes, children);
    return h(
        Slate,
        { editor, initialValue: toNodes(['']) },
        h(Editable, { renderElement, role: 'textbox', 'data-slate-field': id, style: { whiteSpace: 'pre-wrap' } })
    );
}

for (const host of document.querySelectorAll('[data-editor]')) {
    const id = host.closest('[data-case]').dataset.case;
    if (host.dataset.editor === 'tiptap') mountTiptap(id, host);
    else createRoot(host).render(h(SlateField, { id }));
}
