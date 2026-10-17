<script lang="ts">
import { Editor } from "@tiptap/core";
import Color from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import Link from "@tiptap/extension-link";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import { TableRow } from "$lib/modules/editor/extensions/table-row";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import Underline from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";
import { untrack } from "svelte";
import { EncFile } from "$lib/modules/editor/encrypted-file/enc-file-node";
import { applyTableWidths, Table, ZkTableView } from "$lib/modules/editor/extensions/table";
import { ImageResize } from "$lib/modules/editor/image-resize";

let { content }: { content: string } = $props();

let container = $state<HTMLDivElement | undefined>(undefined);
let editorInstance: Editor | undefined;

// Create the editor once, when the container mounts; destroy it on unmount.
$effect(() => {
    const el = container;
    if (!el) return;

    const editor = new Editor({
        element: el,
        editable: false,
        extensions: [
            StarterKit.configure({ link: false, underline: false }),
            TextStyle,
            Color,
            Underline,
            Highlight.configure({ multicolor: true }),
            Link.configure({
                openOnClick: true,
                autolink: true,
                HTMLAttributes: { rel: "noopener", target: "_blank" },
            }),
            ImageResize.configure({ inline: false, allowBase64: true }),
            EncFile,
            TextAlign.configure({ types: ["heading", "paragraph"] }),
            Table.configure({ resizable: false, View: ZkTableView }),
            TableRow,
            TableHeader,
            TableCell,
        ],
        editorProps: {
            attributes: {
                class: "prose prose-sm prose-invert max-w-none text-[var(--text-sub)] prose-headings:text-[var(--text)] prose-a:text-brand-fg prose-code:text-brand-fg prose-code:bg-[var(--surface-raised)] prose-code:px-1 prose-code:rounded prose-pre:bg-[var(--surface-raised)] prose-blockquote:border-brand0/50 prose-blockquote:text-[var(--text-muted)] focus:outline-none",
            },
        },
        content: untrack(() => content),
    });
    // TableView clears table.style.width — the width is applied to the wrapper (see extensions/table.ts).
    applyTableWidths(editor);
    editorInstance = editor;

    return () => {
        editor.destroy();
        editorInstance = undefined;
    };
});

// Update the content when the prop changes (a different snapshot was selected).
$effect(() => {
    const html = content;
    const editor = editorInstance;
    if (editor && !editor.isDestroyed) {
        editor.commands.setContent(html);
        applyTableWidths(editor);
    }
});
</script>

<div bind:this={container}></div>
