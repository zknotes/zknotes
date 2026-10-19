<script lang="ts">
import Button from "$lib/core/ui/Button.svelte";
import Dialog from "$lib/core/ui/Dialog.svelte";
import DialogActions from "$lib/core/ui/DialogActions.svelte";
import ErrorText from "$lib/core/ui/ErrorText.svelte";

let {
    html,
    onClose,
}: {
    /** An `editor.getHTML()` snapshot — it is shown as textContent and nothing else. */
    html: string;
    onClose: () => void;
} = $props();

let preEl = $state<HTMLPreElement | undefined>(undefined);
let copyState = $state<"idle" | "copied" | "error">("idle");
let copyError = $state("");
let copyResetTimer: ReturnType<typeof setTimeout> | undefined;
$effect(() => () => clearTimeout(copyResetTimer));

$effect(() => {
    const el = preEl;
    if (!el) return;
    // An explicit textContent — never {@html} (an XSS in a "read-only" view).
    el.textContent = html;
    const frame = requestAnimationFrame(() => el.focus());
    return () => cancelAnimationFrame(frame);
});

function onSourceKeydown(e: KeyboardEvent) {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "a") return;
    if (!preEl) return;
    e.preventDefault();
    e.stopPropagation();
    window.getSelection()?.selectAllChildren(preEl);
}

async function copyToClipboard() {
    copyError = "";
    copyState = "idle";
    try {
        if (!navigator.clipboard?.writeText) {
            throw new Error("clipboard unavailable");
        }
        await navigator.clipboard.writeText(html);
        copyState = "copied";
        clearTimeout(copyResetTimer);
        copyResetTimer = setTimeout(() => {
            copyState = "idle";
        }, 2000);
    } catch {
        copyState = "error";
        copyError = "Couldn't copy to the clipboard";
    }
}
</script>

<Dialog
    title="View source"
    width="max-w-2xl"
    contentMaxHeight="min(60vh, 32rem)"
    onBackdropClick={onClose}
>
    <!-- The tabindex + keydown are deliberate: Cmd/Ctrl+A has to select the source alone. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <pre
        bind:this={preEl}
        tabindex="0"
        data-testid="note-source-pre"
        aria-label="Note source"
        class="m-0 font-mono text-sm text-[var(--text)] bg-[var(--surface-raised)]
               border border-[var(--stroke)] rounded-md p-3 whitespace-pre-wrap break-words
               outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-color)]"
        onkeydown={onSourceKeydown}
    ></pre>

    {#snippet footer()}
        <div class="flex flex-col items-end gap-2 w-full">
            {#if copyError}
                <ErrorText>{copyError}</ErrorText>
            {/if}
            <DialogActions>
                <Button variant="ghost" onclick={onClose}>Close</Button>
                <Button variant="primary" onclick={() => void copyToClipboard()}>
                    {copyState === "copied" ? "Copied" : "Copy to clipboard"}
                </Button>
            </DialogActions>
        </div>
    {/snippet}
</Dialog>
