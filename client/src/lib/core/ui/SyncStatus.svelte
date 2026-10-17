<script lang="ts">
// A compact indicator of the sync state. It READS from syncStore alone — no new
// source of truth. It shows offline / syncing / sync issue / unsaved changes / N pending /
// "Synced Xm ago".
import { Check, CloudOff, PenLine, RefreshCw, TriangleAlert } from "lucide-svelte";
import { syncStore } from "$lib/core/sync/store.svelte";
import { relativeTime } from "$lib/core/utils/format";
import Button from "./Button.svelte";

// A click opens the Sync activity panel (the (app) layout owns that state).
const { onOpen }: { onOpen?: () => void } = $props();

// A 30s tick, so the relative time ("Synced 2m ago") keeps refreshing even with no sync events.
let now = $state(Date.now());
$effect(() => {
    const t = setInterval(() => {
        now = Date.now();
    }, 30_000);
    return () => clearInterval(t);
});

type SyncState = "offline" | "syncing" | "error" | "unsaved" | "pending" | "idle";
let syncState = $derived.by<SyncState>(() => {
    if (!syncStore.isOnline) return "offline";
    if (syncStore.isSyncing) return "syncing";
    if (syncStore.lastError || syncStore.failedCount > 0) return "error";
    // Edits still waiting for the autosave are not in IndexedDB yet — never "All changes saved" over them.
    if (syncStore.hasUnsavedEdits) return "unsaved";
    if (syncStore.pendingCount > 0) return "pending";
    return "idle";
});

let label = $derived.by(() => {
    void now; // a dependency: force the relative time to re-evaluate on every tick
    switch (syncState) {
        case "offline":
            return "Offline";
        case "syncing":
            return "Syncing…";
        case "error":
            return "Sync issue";
        case "unsaved":
            return "Unsaved changes";
        case "pending":
            return `${syncStore.pendingCount} ${syncStore.pendingCount === 1 ? "change" : "changes"} pending`;
        default:
            return syncStore.lastSyncAt
                ? `Synced ${relativeTime(Math.round(syncStore.lastSyncAt / 1000))}`
                : "All changes saved";
    }
});

let colorClass = $derived(
    {
        offline: "text-[var(--warning)]",
        syncing: "text-[var(--info)]",
        error: "text-[var(--danger)]",
        unsaved: "text-[var(--warning)]",
        pending: "text-[var(--info)]",
        idle: "text-[var(--text-dim)]",
    }[syncState],
);
</script>

<div class="flex items-center min-w-0">
    <Button
        variant="ghost"
        onclick={onOpen}
        data-testid="sync-status"
        class="!h-auto !px-0 gap-1 text-2xs font-mono leading-tight hover:opacity-80 {colorClass} min-w-0"
        title={syncState === "error" ? (syncStore.lastError ?? "Sync issue") : `${label} — open sync activity`}
    >
        {#if syncState === "offline"}
            <CloudOff class="w-2.5 h-2.5 shrink-0" />
        {:else if syncState === "syncing"}
            <RefreshCw class="w-2.5 h-2.5 shrink-0 animate-spin" />
        {:else if syncState === "error"}
            <TriangleAlert class="w-2.5 h-2.5 shrink-0" />
        {:else if syncState === "unsaved"}
            <PenLine class="w-2.5 h-2.5 shrink-0" />
        {:else if syncState === "pending"}
            <span
                class="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                style="background-color: var(--info)"
            ></span>
        {:else}
            <Check class="w-2.5 h-2.5 shrink-0" />
        {/if}
        <span class="truncate">{label}</span>
    </Button>
</div>
