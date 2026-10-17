<script lang="ts">
import { onMount } from "svelte";
import { collectStorageSnapshot, type StorageSnapshot } from "./storage-snapshot";
import { useQueryClient } from "@tanstack/svelte-query";
import { abortPendingUpload } from "$lib/modules/files/upload-manager";
import { cleanupLocalPendingRow } from "$lib/modules/files/upload-session-cleanup";
import { traceFile, type FileTraceResult } from "./dev-file-trace";
import { getDB } from "$lib/core/db";

let snapshot = $state<StorageSnapshot | null>(null);
let loading = $state(false);

let traceInput = $state("");
let traceResult = $state<FileTraceResult | null>(null);
let tracing = $state(false);

// We get the query client from context
const queryClient = useQueryClient();

async function refresh() {
    loading = true;
    try {
        snapshot = await collectStorageSnapshot({ queryClient, includeServer: true });
    } finally {
        loading = false;
    }
}

onMount(() => {
    refresh();
});

async function runTrace() {
    if (!traceInput) return;
    tracing = true;
    try {
        traceResult = await traceFile(traceInput.trim());
    } finally {
        tracing = false;
    }
}

async function doAbort(localId: string) {
    if (!confirm(`Abort upload for ${localId}?`)) return;
    await abortPendingUpload(null, localId);
    await refresh();
}

async function doDeleteLocal(localId: string) {
    if (!confirm(`Force delete local row for ${localId}?`)) return;
    const db = await getDB();
    const pending = await db.get("pending-uploads", localId);
    if (pending) {
        await cleanupLocalPendingRow(pending);
    }
    await refresh();
}

function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
}

function formatBytes(bytes: number | null | undefined) {
    if (bytes == null) return "—";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
</script>

<div class="inspector">
    <div class="toolbar">
        <h2>Storage Inspector</h2>
        <span class="subtitle">Maps the client-side data layers — plaintext layers highlighted.</span>
        <button onclick={refresh} disabled={loading}>Refresh</button>
    </div>

    {#if snapshot}
        <!-- Section A -->
        <section>
            <h3>A — Origin overview</h3>
            <div class="stats">
                <div>
                    <strong>Origin quota:</strong> {formatBytes(snapshot.quota?.usage)} / {formatBytes(snapshot.quota?.quota)}
                    <span>[persisted: {snapshot.persistOutcome}]</span>
                </div>
                {#if snapshot.server}
                    <div>
                        <strong>Server quota:</strong> {formatBytes(snapshot.server.breakdown.total_used)} / {formatBytes(snapshot.server.storage_quota)}
                        <span>[trashed: {formatBytes(snapshot.server.breakdown.trashed_bytes)}, max_file: {formatBytes(snapshot.server.max_file_size)}]</span>
                    </div>
                {/if}
            </div>
        </section>

        <!-- Section B -->
        <section>
            <h3>B — IndexedDB stores</h3>
            <table>
                <thead>
                    <tr><th>Store</th><th>Rows</th><th>Est. bytes</th><th>Notes</th></tr>
                </thead>
                <tbody>
                    {#each snapshot.idb as stat}
                        <tr class={stat.sensitivity}>
                            <td>{stat.id}</td>
                            <td>{stat.rowCount}</td>
                            <td>{formatBytes(stat.bytes)}</td>
                            <td>{stat.sensitivity} {stat.detail ? `(${stat.detail})` : ''}</td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        </section>

        <!-- Section C -->
        <section>
            <h3>C — OPFS staging</h3>
            <table>
                <thead>
                    <tr><th>stagingId</th><th>bytes</th><th>linked pending phase</th><th>complete?</th></tr>
                </thead>
                <tbody>
                    {#each snapshot.opfs as entry}
                        <tr class="plaintext">
                            <td>{entry.stagingId}</td>
                            <td>{formatBytes(entry.bytes)}</td>
                            <td>{entry.linkedPending ? entry.linkedPending.phase : "Orphan"}</td>
                            <td>{entry.complete === true ? '✓' : entry.complete === false ? '✗' : '—'}</td>
                        </tr>
                    {/each}
                    {#if snapshot.opfs.length === 0}
                        <tr><td colspan="4" class="empty">No active staging</td></tr>
                    {/if}
                </tbody>
            </table>
            {#if snapshot.pendingWithoutStaging.length > 0}
                <div class="warning">Reverse orphans (pending without OPFS): {snapshot.pendingWithoutStaging.join(", ")}</div>
            {/if}
            {#if snapshot.staleUploadChunks > 0}
                <div class="warning">Stale upload-chunks: {snapshot.staleUploadChunks}</div>
            {/if}
        </section>

        <!-- Section D -->
        <section>
            <h3>D — RAM blob-cache</h3>
            <table>
                <tbody>
                    <tr><td>Entries</td><td>{snapshot.blobCache.entries}</td></tr>
                    <tr><td>Live refs</td><td>{snapshot.blobCache.liveRefs}</td></tr>
                    <tr><td>Soft cap usage</td><td>{snapshot.blobCache.entries} / {snapshot.blobCache.softCap}</td></tr>
                    <tr><td>Hard cap usage</td><td>{snapshot.blobCache.entries} / {snapshot.blobCache.hardCap}</td></tr>
                    <tr><td>Inflight decrypts</td><td>{snapshot.blobCache.inflight}</td></tr>
                    <tr><td>Thumb entries</td><td>{snapshot.blobCache.thumbEntries}</td></tr>
                    <tr><td>Active decrypts</td><td>{snapshot.blobCache.activeDecrypts}</td></tr>
                    <tr><td>Queue length</td><td>{snapshot.blobCache.queueLength}</td></tr>
                </tbody>
            </table>
        </section>

        <!-- Section D2 -->
        <section>
            <h3>D2 — TanStack Query RAM cache (plaintext)</h3>
            {#if snapshot.queryCache}
                <table>
                    <tbody>
                        <tr><td>tree-items cached?</td><td>{snapshot.queryCache.treeItemsCount !== null ? `✓ (${snapshot.queryCache.treeItemsCount})` : '✗'}</td></tr>
                        <tr><td>deleted-items cached?</td><td>{snapshot.queryCache.deletedItemsCount !== null ? `✓ (${snapshot.queryCache.deletedItemsCount})` : '✗'}</td></tr>
                        <tr><td>note(id) entries</td><td>{snapshot.queryCache.noteEntries}</td></tr>
                        <tr><td>queries in total</td><td>{snapshot.queryCache.totalQueries}</td></tr>
                    </tbody>
                </table>
            {:else}
                <div class="empty">QueryCache not provided</div>
            {/if}
        </section>

        <!-- Section E -->
        <section>
            <h3>E — Pending uploads</h3>
            <div class="scroll-table">
                <table>
                    <thead>
                        <tr><th>local_id</th><th>phase</th><th>size</th><th>chunk_set_id</th><th>Actions</th></tr>
                    </thead>
                    <tbody>
                        {#each snapshot.pendingUploads as pending}
                            <tr class="plaintext">
                                <td>
                                    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                                    <span class="copyable" onclick={() => copyToClipboard(pending.local_id)} title="Copy ID">{pending.local_id}</span>
                                </td>
                                <td>{pending.phase || "—"}</td>
                                <td>{formatBytes(pending.plain_size)}</td>
                                <td>
                                    {#if pending.chunk_set_id}
                                        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                                        <span class="copyable" onclick={() => copyToClipboard(pending.chunk_set_id || '')} title="Copy ID">{pending.chunk_set_id}</span>
                                    {:else}
                                        —
                                    {/if}
                                </td>
                                <td>
                                    <button onclick={() => doAbort(pending.local_id)}>Abort</button>
                                    <button onclick={() => doDeleteLocal(pending.local_id)}>Del Local</button>
                                </td>
                            </tr>
                        {/each}
                        {#if snapshot.pendingUploads.length === 0}
                            <tr><td colspan="5" class="empty">No pending uploads</td></tr>
                        {/if}
                    </tbody>
                </table>
            </div>
        </section>

        <!-- Section F -->
        <section>
            <h3>F — File Trace</h3>
            <div class="trace-form">
                <input type="text" bind:value={traceInput} placeholder="fileId or local:..." />
                <button onclick={runTrace} disabled={tracing}>Trace</button>
            </div>
            {#if traceResult}
                <div class="trace-result">
                    <p><strong>Resolved Type:</strong> {traceResult.resolvedType}</p>
                    
                    {#if traceResult.item}
                        <div class="trace-box">
                            <h4>items table</h4>
                            <p>parent_id: {traceResult.item.parent_id}</p>
                            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                            <p>chunk_set_id: <span class="copyable" onclick={() => copyToClipboard(traceResult!.item!.chunk_set_id)} title="Copy ID">{traceResult.item.chunk_set_id}</span></p>
                            <p>version: {traceResult.item.version}</p>
                            <p>deleted_at: {traceResult.item.deleted_at}</p>
                            <p>purged_at: {traceResult.item.purged_at}</p>
                        </div>
                    {/if}

                    {#if traceResult.trash}
                        <div class="trace-box">
                            <h4>Trash state</h4>
                            <p>is_pending_trash: <span class:red={traceResult.trash.is_pending_trash}>{traceResult.trash.is_pending_trash}</span></p>
                        </div>
                    {/if}

                    {#if traceResult.sync}
                        <div class="trace-box">
                            <h4>Sync & Pin</h4>
                            <p>is_pinned: {traceResult.sync.is_pinned}</p>
                            <p>sync_mode: {traceResult.sync.sync_mode}</p>
                        </div>
                    {/if}

                    {#if traceResult.fileChunks}
                        <div class="trace-box">
                            <h4>file-chunks</h4>
                            <p>cached chunks: {traceResult.fileChunks.cachedChunks}</p>
                            <p>total bytes: {formatBytes(traceResult.fileChunks.totalBytes)}</p>
                            <p class="subtitle">Note: file-chunks are keyed by chunkSetId, not by fileId.</p>
                        </div>
                    {/if}

                    {#if traceResult.blobCache}
                        <div class="trace-box red-box">
                            <h4>RAM blob-cache (Plaintext)</h4>
                            <p>refs: {traceResult.blobCache.refs}</p>
                            <p>render: {traceResult.blobCache.render}</p>
                        </div>
                    {/if}

                    {#if traceResult.pending}
                        <div class="trace-box red-box">
                            <h4>Pending Upload / OPFS (Plaintext)</h4>
                            <p>phase: {traceResult.pending.phase}</p>
                            <p>opfs_bytes: {formatBytes(traceResult.pending.opfs_bytes)}</p>
                        </div>
                    {/if}

                    {#if traceResult.server}
                        <div class="trace-box grey-box">
                            <h4>Server status</h4>
                            <p>status: {traceResult.server.status}</p>
                            {#if traceResult.server.total_size}
                                <p>total size: {formatBytes(traceResult.server.total_size)}</p>
                            {/if}
                        </div>
                    {/if}
                </div>
            {/if}
        </section>

    {:else}
        <div class="loading">Loading snapshot...</div>
    {/if}
</div>

<style>
    .inspector {
        padding: 16px;
        color: #ddd;
        overflow-y: auto;
        height: 100%;
        font-family: sans-serif;
        font-size: var(--text-sm);
    }

    .toolbar {
        display: flex;
        align-items: center;
        gap: 16px;
        margin-bottom: 24px;
    }

    .toolbar h2 {
        margin: 0;
        color: #fff;
    }
    
    .subtitle {
        color: #888;
        font-size: var(--text-xs);
    }

    section {
        margin-bottom: 24px;
        background: #252526;
        padding: 12px;
        border-radius: 6px;
        border: 1px solid #333;
    }

    h3 {
        margin-top: 0;
        margin-bottom: 12px;
        font-size: var(--text-sm);
        color: #ff2a5f;
    }

    table {
        width: 100%;
        border-collapse: collapse;
        text-align: left;
    }

    th, td {
        padding: 6px 8px;
        border-bottom: 1px solid #333;
    }

    th {
        color: #888;
        font-weight: normal;
        font-size: var(--text-xs);
        text-transform: uppercase;
    }

    tr.plaintext td {
        color: #ff5f5f;
    }

    .empty {
        text-align: center;
        color: #666;
        padding: 12px;
    }

    .warning {
        color: #cca700;
        margin-top: 8px;
    }
    
    .stats div {
        margin-bottom: 4px;
    }

    .copyable {
        cursor: pointer;
        text-decoration: underline;
        text-decoration-style: dashed;
    }
    .copyable:hover {
        color: #ff2a5f;
    }
    .trace-form {
        display: flex;
        gap: 8px;
        margin-bottom: 12px;
    }
    .trace-form input {
        flex: 1;
        background: #111;
        border: 1px solid #333;
        color: #fff;
        padding: 4px 8px;
        border-radius: 4px;
    }
    .trace-box {
        background: #111;
        border: 1px solid #333;
        padding: 8px;
        margin-bottom: 8px;
        border-radius: 4px;
    }
    .trace-box h4 {
        margin: 0 0 4px 0;
        color: #aaa;
        font-size: var(--text-xs);
    }
    .trace-box p {
        margin: 2px 0;
    }
    .red-box {
        border-left: 3px solid #ff5f5f;
    }
    .grey-box {
        border-left: 3px solid #666;
    }
    .red {
        color: #ff5f5f;
    }
</style>
