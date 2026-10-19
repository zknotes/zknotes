<script lang="ts">
// The floating bar that asks before files dropped or pasted into a note are uploaded. It only shows
// the queue and reports the two choices; the page owns the queue and the upload itself.
import Button from "$lib/core/ui/Button.svelte";
import { humanSize } from "$lib/core/utils/format";

interface Props {
    queue: ReadonlyArray<{ file: File }>;
    onCancel: () => void;
    onConfirm: () => void;
}

let { queue, onCancel, onConfirm }: Props = $props();

const count = $derived(queue.length);
const single = $derived(count === 1 ? queue[0]?.file : undefined);
</script>

<div class="fixed inset-x-0 bottom-6 z-[65] flex justify-center px-4 pointer-events-none">
    <div
        class="pointer-events-auto flex items-center gap-3 bg-[var(--surface-panel)] border border-[var(--stroke)] rounded-xl px-4 py-3 shadow-[var(--float-shadow)] max-w-sm w-full"
        data-testid="upload-confirm-bar"
    >
        <div class="flex-1 min-w-0">
            {#if single}
                <div class="text-sm font-medium text-[var(--text)] truncate">{single.name}</div>
                <div class="text-xs text-[var(--text-dim)]">
                    {humanSize(single.size)} — upload to this note?
                </div>
            {:else}
                <div class="text-sm font-medium text-[var(--text)]">
                    {count} files — upload to this note?
                </div>
                <div class="text-xs text-[var(--text-muted)] mt-1 space-y-0.5 max-h-20 overflow-y-auto">
                    {#each queue as q}
                        <div class="truncate">{q.file.name}</div>
                    {/each}
                </div>
            {/if}
        </div>
        <Button onclick={onCancel}>Cancel</Button>
        <Button variant="primary" onclick={onConfirm}>
            {count === 1 ? "Upload" : `Upload ${count}`}
        </Button>
    </div>
</div>
