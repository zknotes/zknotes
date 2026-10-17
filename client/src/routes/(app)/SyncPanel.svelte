<script lang="ts">
// The sync-activity slide-over. It opens on a click of the SyncStatus chip and shows what is
// syncing: the live progress of file uploads (imports through the tracker included) + the queue of
// pending changes + "Sync now".
// It lives in routes rather than core/ui because it reads the upload state from modules/files — core
// must not import modules. upload-manager (which is TipTap-heavy) is imported dynamically on the first
// open, so it does not enter the shell bundle.
import { File as FileIcon, FileText, Folder, RefreshCw, Upload, X } from "lucide-svelte";
import { fade, fly } from "svelte/transition";
import Button from "$lib/core/ui/Button.svelte";
import { Eyebrow, MetaText, EmptyState } from "$lib/core/ui";
import { decryptItemPayload } from "$lib/core/crypto/item-codec";
import { getDB } from "$lib/core/db";
import {
    clearSyncErrorsAndRequeue,
    mutationRetryAt,
    pushPendingMutations,
} from "$lib/core/sync/engine";
import { syncStore } from "$lib/core/sync/store.svelte";
import { relativeTime } from "$lib/core/utils/format";
import type { UploadState } from "$lib/modules/files/upload-manager";
import { computeUploadDisplayPct } from "$lib/modules/files/upload";

interface Props {
    open: boolean;
    onClose: () => void;
}
const { open, onClose }: Props = $props();

// ── The upload tracker (loaded dynamically, deferring TipTap) ───────────────
type UploadManager = typeof import("$lib/modules/files/upload-manager");
let mgr = $state<UploadManager | null>(null);
let tick = $state(0);

$effect(() => {
    if (open && !mgr) {
        import("$lib/modules/files/upload-manager").then((m) => {
            mgr = m;
        });
    }
});

$effect(() => {
    if (!mgr) return;
    // Do NOT touch `tick` here (reading and writing the same state in an effect = an infinite loop).
    // The `uploads` derived depends on `mgr`, so it recomputes the first time the manager loads; the
    // subscription
    // callback bumps `tick` for the later changes during an upload.
    const unsub = mgr.subscribeAllUploads(() => {
        tick++;
    });
    return unsub;
});

const uploads = $derived.by<Array<{ id: string } & UploadState>>(() => {
    void tick;
    if (!mgr) return [];
    return Array.from(mgr.getAllUploadStates().entries()).map(([id, s]) => ({ id, ...s }));
});

// ── Pending mutations (the mutation queue joined with items + the title decrypt) ─────────
type PendingRow = {
    id: string;
    title: string;
    type: "note" | "folder" | "file";
    mutationType: "upsert" | "delete";
    /** What kind of upsert this is — we distinguish them for the UI label. */
    upsertKind: "save" | "trash" | "new" | "conflict";
    attemptCount: number;
    nextRetryAt: number | null; // a ms timestamp, null = at once / no backoff
};
let pending = $state<PendingRow[]>([]);

async function loadPending() {
    const db = await getDB();
    const queue = await db.getAll("mutation-queue");
    const rows = await Promise.all(
        queue.map(async (m): Promise<PendingRow> => {
            const item = await db.get("items", m.id);
            const type = (item?.type as PendingRow["type"]) ?? "note";
            // The engine's own due time — the scheduler's retry timer fires at the same moment.
            const nextRetryAt = m.attempt_count > 0 ? mutationRetryAt(m) : null;

            // ── Title ───────────────────────────────────────────────────────
            let title = "Untitled";
            let upsertKind: PendingRow["upsertKind"] = "save";

            if (m.type === "delete") {
                // A hard delete: the item may already be gone from IDB (the pull received a purge
                // tombstone). Show the ID's last 8 characters as the only identifier available.
                title = item ? `(deleting ${item.id.slice(-8)})` : `(purged ${m.id.slice(-8)})`;
                upsertKind = "save"; // unused for delete
            } else if (item?.encrypted_payload) {
                try {
                    const p = await decryptItemPayload<{ title?: string; name?: string }>(item);
                    title = p?.name || p?.title || "Untitled";
                } catch {
                    title = "Encrypted…";
                }
                // Tell the kinds of upsert apart for a clearer UI label
                if (item.conflict_of) {
                    upsertKind = "conflict";
                } else if (item.deleted_at) {
                    upsertKind = "trash";
                } else if (item.version === 1 && item.dirty) {
                    upsertKind = "new";
                } else {
                    upsertKind = "save";
                }
            } else if (item?.deleted_at) {
                // A trashed item whose payload the server has already nulled — show the ID
                title = `(trashing ${m.id.slice(-8)})`;
                upsertKind = "trash";
            }

            return {
                id: m.id,
                title,
                type,
                mutationType: m.type,
                upsertKind,
                attemptCount: m.attempt_count,
                nextRetryAt,
            };
        }),
    );
    const queued = new Set(rows.map((r) => r.id));
    for (const item of await db.getAll("items")) {
        if (!item.sync_error || queued.has(item.id)) continue;
        let title = "Untitled";
        if (item.encrypted_payload) {
            try {
                const p = await decryptItemPayload<{ title?: string; name?: string }>(item);
                title = p?.name || p?.title || "Untitled";
            } catch {
                title = "Encrypted…";
            }
        }
        rows.push({
            id: item.id,
            title,
            type: (item.type as PendingRow["type"]) ?? "note",
            mutationType: "upsert",
            upsertKind: "save",
            attemptCount: 3,
            nextRetryAt: null,
        });
    }
    pending = rows;
}

$effect(() => {
    // The reactive dependencies: opening, a change in the pending count, and the upload tick (a drain changes them).
    // isSyncing too: a failed retry leaves the count unchanged, so without it the attempt count and
    // the countdown shown would go stale.
    void syncStore.pendingCount;
    void syncStore.isSyncing;
    void tick;
    if (open) void loadPending();
    else pending = [];
});

let isSyncingNow = $state(false);
async function syncNow() {
    if (isSyncingNow) return;
    isSyncingNow = true;
    try {
        await pushPendingMutations({ force: true });
        await syncStore.refreshPendingCount();
        await loadPending();
    } finally {
        isSyncingNow = false;
    }
}

/** Re-enqueue the items carrying a permanent sync_error and attempt a push at once. */
async function retryFailedItems() {
    if (isSyncingNow) return;
    isSyncingNow = true;
    try {
        await clearSyncErrorsAndRequeue();
        await pushPendingMutations({ force: true });
        await syncStore.refreshPendingCount();
        await loadPending();
    } finally {
        isSyncingNow = false;
    }
}

let now = $state(Date.now());
$effect(() => {
    // 1s while the panel is open (to refresh the retry countdown); 30s when it is closed (a relative time).
    const interval = open ? 1_000 : 30_000;
    const t = setInterval(() => {
        now = Date.now();
    }, interval);
    return () => clearInterval(t);
});

const statusLabel = $derived.by(() => {
    void now;
    if (!syncStore.isOnline) return "Offline — changes will sync when you reconnect";
    // Say which half of the sync runs. The list below shows only the queue, and a note save goes
    // straight to the server past it, so a bare "Syncing…" over an empty list read as a contradiction.
    if (syncStore.isPushing || isSyncingNow) return "Sending changes…";
    if (syncStore.isSyncing) return "Checking for changes from other devices…";
    if (syncStore.lastError) return `Sync issue: ${syncStore.lastError}`;
    if (syncStore.failedCount > 0) return `${syncStore.failedCount} item(s) failed to sync`;
    if (syncStore.hasUnsavedEdits) {
        return "Unsaved edits in the open note — they save automatically when you pause typing";
    }
    if (syncStore.pendingCount > 0) return `${syncStore.pendingCount} change(s) waiting to sync`;
    return syncStore.lastSyncAt
        ? `All changes saved · synced ${relativeTime(Math.round(syncStore.lastSyncAt / 1000))}`
        : "All changes saved";
});

const PHASE_LABEL: Record<UploadState["phase"], string> = {
    encrypting: "Encrypting",
    uploading: "Uploading",
    finalizing: "Finalizing",
    committing: "Saving",
    done: "Done",
};

function uploadPct(s: UploadState): number | null {
    return computeUploadDisplayPct(s);
}

const typeIcon = { note: FileText, folder: Folder, file: FileIcon } as const;

function mutationLabelClass(row: PendingRow): string {
    if (row.mutationType === "delete") return "text-[var(--danger)]";
    if (row.upsertKind === "new") return "text-[var(--info)]";
    if (row.upsertKind === "trash") return "text-[var(--warning)]";
    if (row.upsertKind === "conflict") return "text-purple-400";
    return "text-[var(--text-dim)]";
}
</script>

<svelte:window
    onkeydown={(e) => {
        if (open && e.key === "Escape") onClose();
    }}
/>

{#if open}
    <!-- Overlay -->
    <div class="fixed inset-0 z-[80]" transition:fade={{ duration: 150 }}>
        <Button
            variant="ghost"
            onclick={onClose}
            aria-label="Close sync panel"
            class="w-full h-full min-h-0 rounded-none border-0 bg-black/50 backdrop-blur-sm hover:bg-black/50 p-0"
        />
    </div>

    <!-- A slide-over from the right -->
    <aside
        class="fixed right-0 top-0 bottom-0 z-[81] w-[min(420px,100vw)] bg-[var(--surface-panel)] border-l border-[var(--stroke)] shadow-[var(--float-shadow)] flex flex-col"
        transition:fly={{ x: 420, duration: 200 }}
    >
        <header class="flex items-center justify-between px-5 h-14 border-b border-[var(--stroke)] shrink-0">
            <div class="flex items-center gap-2">
                <RefreshCw class="w-4 h-4 text-[var(--info)] {syncStore.isSyncing || isSyncingNow ? 'animate-spin' : ''}" />
                <h2 class="text-sm font-semibold text-[var(--text)]">Sync activity</h2>
            </div>
            <Button
                variant="ghost"
                size="icon"
                onclick={onClose}
                aria-label="Close"
            >
                <X class="w-4 h-4" />
            </Button>
        </header>

        <div class="flex-1 overflow-y-auto px-5 py-4 space-y-5">
            <MetaText as="p" class="leading-relaxed">{statusLabel}</MetaText>
            {#if syncStore.lastError || syncStore.failedCount > 0}
                <Button
                    variant="ghost"
                    size="sm"
                    onclick={retryFailedItems}
                    disabled={isSyncingNow || !syncStore.isOnline}
                    class="h-auto px-0 text-xs font-medium text-[var(--info)] hover:underline hover:bg-transparent disabled:no-underline"
                >
                    Retry failed items
                </Button>
            {/if}

            <!-- Active uploads -->
            {#if uploads.length > 0}
                <section class="space-y-2">
                    <Eyebrow as="h3" size="xs" class="font-semibold">Uploading files</Eyebrow>
                    {#each uploads as u (u.id)}
                        {@const pct = uploadPct(u)}
                        <div class="rounded-lg border border-[var(--stroke)] bg-[color-mix(in_srgb,var(--surface-raised)_40%,transparent)] px-3 py-2.5">
                            <div class="flex items-center gap-2 min-w-0">
                                <Upload class="w-3.5 h-3.5 shrink-0 text-[var(--info)]" />
                                <span class="text-xs text-[var(--text-sub)] truncate flex-1">{u.name ?? u.id}</span>
                                <span class="text-xs font-mono shrink-0 {u.status === 'failed' ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'}">
                                    {u.status === "failed" ? "Failed" : PHASE_LABEL[u.phase]}{pct !== null && u.status !== "failed" ? ` ${pct}%` : ""}
                                </span>
                            </div>
                            {#if u.status !== "failed"}
                                <div class="mt-2 h-1 rounded-full bg-[var(--stroke)] overflow-hidden">
                                    <div
                                        class="h-full bg-[var(--info)] transition-[width] duration-200 {pct === null ? 'animate-pulse w-1/3' : ''}"
                                        style={pct !== null ? `width:${pct}%` : ""}
                                    ></div>
                                </div>
                            {:else}
                                <div class="mt-1.5 flex items-center justify-between gap-2">
                                    <span class="text-xs text-[var(--danger)] truncate">{u.error ?? "Upload failed"}</span>
                                    <div class="flex gap-2 shrink-0">
                                        <Button variant="ghost" size="sm" class="h-auto px-0 text-xs text-[var(--info)] hover:underline hover:bg-transparent" onclick={() => mgr?.retryUpload(null, u.id)}>Retry</Button>
                                        <Button variant="ghost" size="sm" class="h-auto px-0 text-xs text-[var(--text-muted)] hover:text-[var(--text-sub)] hover:bg-transparent" onclick={() => mgr?.abortTracked(u.id)}>Dismiss</Button>
                                    </div>
                                </div>
                            {/if}
                        </div>
                    {/each}
                </section>
            {/if}

            <!-- Pending changes -->
            <section class="space-y-2">
                <div class="flex items-center justify-between">
                    <Eyebrow as="h3" size="xs" class="font-semibold">
                        Pending changes{pending.length ? ` (${pending.length})` : ""}
                    </Eyebrow>
                    {#if pending.length > 0}
                        <Button
                            variant="ghost"
                            size="sm"
                            onclick={syncNow}
                            disabled={isSyncingNow || !syncStore.isOnline}
                            class="h-auto px-0 text-xs font-medium text-[var(--info)] hover:underline hover:bg-transparent disabled:no-underline"
                        >
                            Sync now
                        </Button>
                    {/if}
                </div>

                {#if pending.length === 0}
                    <!-- About the queue only — the overall state is the status line at the top, and an
                         empty queue does not mean nothing is syncing or unsaved. -->
                    <EmptyState as="p">Nothing waiting to be sent.</EmptyState>
                {:else}
                    {#each pending as row (row.id)}
                        {@const Icon = typeIcon[row.type]}
                        {@const retryIn = row.nextRetryAt ? Math.max(0, Math.ceil((row.nextRetryAt - now) / 1000)) : null}
                        <div class="rounded-lg border border-[var(--stroke)] bg-[color-mix(in_srgb,var(--surface-raised)_30%,transparent)] px-3 py-2 space-y-1">
                            <div class="flex items-center gap-2">
                                <Icon class="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
                                <span class="text-xs text-[var(--text-sub)] truncate flex-1">{row.title}</span>
                                <span class="text-2xs font-mono uppercase shrink-0 {mutationLabelClass(row)}">
                                    {#if row.mutationType === "delete"}
                                        purge
                                    {:else if row.upsertKind === "new"}
                                        new
                                    {:else if row.upsertKind === "trash"}
                                        trash
                                    {:else if row.upsertKind === "conflict"}
                                        conflict
                                    {:else}
                                        update
                                    {/if}
                                </span>
                            </div>
                            {#if row.attemptCount > 0}
                                <div class="flex items-center gap-2 pl-5">
                                    <span class="text-2xs font-mono text-[var(--warning)]">
                                        ×{row.attemptCount} {row.attemptCount === 1 ? "retry" : "retries"}
                                    </span>
                                    {#if retryIn !== null && retryIn > 0}
                                        <span class="text-2xs font-mono text-[var(--text-dim)]">· next in {retryIn}s</span>
                                    {:else if retryIn === 0}
                                        <span class="text-2xs font-mono text-[var(--info)]">· retrying…</span>
                                    {/if}
                                    <span class="text-2xs font-mono text-[var(--text-dim)] ml-auto select-all opacity-60">{row.id.slice(-8)}</span>
                                </div>
                            {:else}
                                <div class="pl-5">
                                    <span class="text-2xs font-mono text-[var(--text-dim)] select-all opacity-60">{row.id.slice(-8)}</span>
                                </div>
                            {/if}
                        </div>
                    {/each}
                {/if}
            </section>
        </div>

        <footer class="px-5 py-3 border-t border-[var(--stroke)] shrink-0">
            <MetaText as="p" class="leading-relaxed">
                Changes are encrypted on this device, then pushed to the server in the background. Files
                upload first, then their metadata. Failed pushes retry automatically with backoff.
            </MetaText>
        </footer>
    </aside>
{/if}