<script lang="ts">
// The storage badge on file cards. It reflects the user's "Keep on this device" choice rather than
// the raw cache:
// ☁️ Cloud only — the file is (only) in the cloud as far as this device is concerned.
// ✅ On this device — the user keeps it locally and every chunk has been fetched (available offline).
// ⏳ Saving… — marked for "on this device", the chunks are still coming down.
// Incidentally cached (unpinned) files are NOT shown as "on this device" — that is an internal cache.
import { Loader2 } from "lucide-svelte";
import { pinManager } from "$lib/core/files/pin-manager-state.svelte";
import { checkFilePresence, type FilePresence } from "$lib/modules/files/presence";
import { onFilesChanged } from "./files-changed-bus";

interface Props {
    fileId: string;
}
const { fileId }: Props = $props();

let presence = $state<FilePresence | null>(null);

// Reactive through pinManager.roots ($state) — the badge refreshes on a pin/unpin.
const keptOnDevice = $derived(pinManager.isPinned(fileId));

$effect(() => {
    const id = fileId;
    void checkFilePresence(id).then((p) => {
        presence = p;
    });
    return onFilesChanged((changedIds) => {
        if (changedIds.includes(id)) {
            void checkFilePresence(id).then((p) => {
                presence = p;
            });
        }
    });
});
</script>

{#if keptOnDevice && presence === "downloaded"}
    <span class="text-2xs leading-none text-brand-fg select-none" title="On this device">✅</span>
{:else if keptOnDevice}
    <Loader2 class="w-3 h-3 animate-spin text-[var(--text-muted)]/70" aria-label="Saving to device" />
{:else}
    <span class="text-2xs leading-none text-[var(--text-muted)]/70 select-none" title="Cloud only">☁️</span>
{/if}
