<script lang="ts">
// The empty state of /note/[id] when the note is gone (deleted, or never existed on this account).
import { FileX, PenLine } from "lucide-svelte";
import Button from "$lib/core/ui/Button.svelte";

interface Props {
    onCreate: () => void;
    creating: boolean;
}

let { onCreate, creating }: Props = $props();
</script>

<div class="flex-1 flex flex-col items-center justify-center text-center p-8 relative overflow-hidden fade-in">
    <div class="relative z-10 flex flex-col items-center">
        <div
            class="w-16 h-16 rounded-2xl bg-[var(--surface-raised)] border border-[var(--stroke)] flex items-center justify-center mb-4 shadow-sm text-[var(--text-dim)]"
        >
            <FileX class="w-6 h-6" />
        </div>
        <h2 class="text-lg font-medium text-[var(--text-sub)] mb-1.5">Note not found</h2>
        <p class="text-[var(--text-dim)] max-w-sm text-sm mb-6">
            This note has been deleted or does not exist. Would you like to create a new one instead?
        </p>
        <Button variant="normal" onclick={onCreate} disabled={creating} loading={creating}>
            <PenLine class="w-4 h-4" />
            Create new note
        </Button>
    </div>
</div>
