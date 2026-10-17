<script lang="ts">
import { useQueryClient } from "@tanstack/svelte-query";
import { FileText, PenLine, ShieldCheck, WifiOff } from "lucide-svelte";
import Button from "$lib/core/ui/Button.svelte";
import { goto } from "$app/navigation";
import { QUERY_KEYS } from "$lib/core/constants/query-keys";
import { ItemService } from "$lib/core/services/item-service";
import { loadPersisted, rawStringSerde, STORAGE_KEYS } from "$lib/core/utils/persisted";
import { APP_EVENTS } from "$lib/core/constants/events";
import { onMount } from "svelte";

const queryClient = useQueryClient();
let loading = $state(false);
let isPendingClear = $state(false);

function checkPendingClear() {
    isPendingClear =
        loadPersisted(STORAGE_KEYS.pendingClearForUser, "false", rawStringSerde) === "true";
}

onMount(() => {
    checkPendingClear();
    window.addEventListener(APP_EVENTS.vaultItemsChanged, checkPendingClear);
    return () => window.removeEventListener(APP_EVENTS.vaultItemsChanged, checkPendingClear);
});

async function createNote() {
    if (loading || isPendingClear) return;
    loading = true;
    try {
        const item = await ItemService.createItem("note", null, "Untitled");
        await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
        await goto(`/note/${item.id}?new=1`);
    } catch (e) {
        console.error("Failed to create note", e);
    } finally {
        loading = false;
    }
}
</script>

<div class="h-full w-full flex flex-col items-center justify-center text-center p-8 bg-grid relative overflow-hidden">
    <div class="absolute -top-[20%] -left-[10%] w-[60%] h-[60%] rounded-full bg-brand0/5 blur-[120px] pointer-events-none"></div>
    <div class="absolute -bottom-[20%] -right-[10%] w-[50%] h-[50%] rounded-full bg-brand0/5 blur-[120px] pointer-events-none"></div>

    <div class="relative z-10 flex flex-col items-center fade-in">
        <div class="w-20 h-20 rounded-2xl bg-[var(--surface-panel)] border border-[var(--stroke)] flex items-center justify-center mb-6 shadow-xl">
            <div class="w-12 h-12 rounded-xl bg-brand0/10 border border-brand0/20 flex items-center justify-center text-brand-fg">
                {#if isPendingClear}
                    <WifiOff class="w-6 h-6 text-amber-500" />
                {:else}
                    <FileText class="w-6 h-6" />
                {/if}
            </div>
        </div>

        {#if isPendingClear}
            <div class="text-2xs font-mono uppercase tracking-[0.18em] text-amber-500/80 mb-2">
                Offline
            </div>
            <h2 class="text-3xl font-bold tracking-tight text-[var(--text)] mb-2">Vault is waiting</h2>
            <p class="text-[var(--text-dim)] max-w-sm text-sm">
                Connection required for first sync. The app is waiting to connect to the network to download your notes.
            </p>
        {:else}
            <div class="text-2xs font-mono uppercase tracking-[0.18em] text-brand-fg/80 mb-2">
                Zero-knowledge · XChaCha20-Poly1305
            </div>
            <h2 class="text-3xl font-bold tracking-tight text-[var(--text)] mb-2">No note selected</h2>
            <p class="text-[var(--text-dim)] max-w-sm text-sm">
                Pick a note from the sidebar or capture a new thought — encrypted on this device before it
                ever leaves.
            </p>

            <Button variant="normal" class="mt-8" onclick={createNote} disabled={loading} loading={loading}>
                <PenLine class="w-4 h-4" />
                New encrypted note
            </Button>

            <div class="mt-10 flex items-center gap-2 text-2xs font-mono uppercase tracking-wider text-[var(--text-dim)]">
                <ShieldCheck class="w-3 h-3 text-brand-fg/80" />
                end-to-end encrypted
            </div>
        {/if}
    </div>
</div>
