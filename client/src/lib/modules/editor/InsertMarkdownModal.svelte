<script lang="ts">
import type { Editor } from "@tiptap/core";
import { ClipboardPaste } from "lucide-svelte";
import Button from "$lib/core/ui/Button.svelte";
import Dialog from "$lib/core/ui/Dialog.svelte";
import DialogActions from "$lib/core/ui/DialogActions.svelte";
import { importMarkdownToHtml } from "./markdown-import";

let {
    open = $bindable(false),
    editor,
}: {
    open: boolean;
    editor: Editor | undefined;
} = $props();

let markdown = $state("");

function onInsert() {
    if (!editor || !markdown.trim()) return;

    const html = importMarkdownToHtml(markdown);
    editor.chain().focus().insertContent(html).run();

    open = false;
    markdown = "";
}

async function handlePaste() {
    try {
        const text = await navigator.clipboard.readText();
        if (text) {
            markdown += (markdown ? "\n" : "") + text;
        }
    } catch (e) {
        console.error("Failed to read clipboard", e);
    }
}
</script>

{#if open}
    <Dialog title="Insert Markdown" width="max-w-xl" onBackdropClick={() => (open = false)}>
        <div class="p-4 flex flex-col gap-4">
            <p class="text-sm text-[var(--text-muted)]">
                Paste your Markdown code below. It will be converted to rich text and inserted at the
                current cursor position.
            </p>
            <div class="relative">
                <textarea
                    class="w-full h-64 bg-[var(--surface-raised)] border border-[var(--stroke)] rounded p-3 font-mono text-sm resize-y focus:outline-none focus:border-[var(--accent-color)]"
                    placeholder="# Heading&#10;**Bold text**...&#10;$$ \Delta G = ... $$"
                    bind:value={markdown}
                ></textarea>
                <Button
                    variant="ghost"
                    size="icon"
                    class="absolute top-2 right-2 border border-[var(--stroke)] bg-[var(--surface-app)]"
                    title="Paste from clipboard"
                    onclick={handlePaste}
                >
                    <ClipboardPaste class="w-4 h-4" />
                </Button>
            </div>
        </div>

        {#snippet footer()}
            <DialogActions>
                <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
                <Button variant="primary" disabled={!markdown.trim()} onclick={onInsert}>Insert</Button>
            </DialogActions>
        {/snippet}
    </Dialog>
{/if}
