<script lang="ts">
// Registers an unsaved-edits source from an $effect, the way the note page mounts NoteAutosave
// (`$effect(() => autosave.mount())`), next to the chip that reads it.
import { syncStore } from "$lib/core/sync/store.svelte";
import SyncStatus from "./SyncStatus.svelte";

let dirty = $state(true);

export function setDirty(value: boolean) {
    dirty = value;
}

$effect(() => syncStore.registerUnsavedEdits(() => dirty));
</script>

<SyncStatus />
