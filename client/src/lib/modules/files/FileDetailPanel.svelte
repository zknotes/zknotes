<script lang="ts">
// The file detail / preview panel. It opens on a click on a card. The preview is XSS-safe:
// only raster images sniffed from the real bytes render inline as <img src=blob:>; everything
// else is download-only. The blob: URL is always revoked when the panel closes or the file changes.

import { createQuery } from "@tanstack/svelte-query";
import {
    Cloud,
    CloudDownload,
    Crop,
    Download,
    FolderClosed,
    Loader2,
    RefreshCw,
    Save,
    Shield,
    Trash2,
    X,
} from "lucide-svelte";
import { QUERY_KEYS } from "$lib/core/constants/query-keys";
import { type DecryptedItemMeta, folderPathSegments } from "$lib/core/data/items";
import Button from "$lib/core/ui/Button.svelte";
import Dialog from "$lib/core/ui/Dialog.svelte";
import DialogActions from "$lib/core/ui/DialogActions.svelte";
import { Eyebrow, EmptyState, ErrorText } from "$lib/core/ui";
import { formatDate, humanSize } from "$lib/core/utils/format";
import CropModal from "./CropModal.svelte";
import FilePresenceBadge from "./FilePresenceBadge.svelte";
import { pinManager } from "$lib/core/files/pin-manager-state.svelte";
import { checkFilePresence, type FilePresence } from "$lib/modules/files/presence";
import { onFilesChanged } from "./files-changed-bus";

interface Props {
    file: DecryptedItemMeta;
    onClose: () => void;
    /** Called after a rename, a description edit or a delete, so the list can refresh. */
    onChanged?: () => void;
}
const { file, onClose, onChanged }: Props = $props();

// The path of the folder the file lives in (one source of truth — folderPathSegments).
const treeQuery = createQuery(() => ({
    queryKey: QUERY_KEYS.treeItems,
    queryFn: async () => {
        const { getTreeItems } = await import("$lib/core/data/items");
        return getTreeItems();
    },
}));

let folderPath = $derived.by(() => {
    if (!file.parent_id) return "Unlinked";
    const map = new Map<string, { title: string; parent_id: string | null }>();
    for (const i of treeQuery.data ?? []) map.set(i.id, { title: i.title, parent_id: i.parent_id });
    return (
        folderPathSegments(file.parent_id, map)
            .map((s) => s.title)
            .join(" / ") || "Home"
    );
});

let pickingNote = $state(false);

let previewUrl = $state<string | null>(null);
let previewState = $state<
    "loading" | "raster" | "video" | "audio" | "download" | "needs-download" | "error"
>("loading");
let errorMsg = $state<string | null>(null);
let downloading = $state(false);
let downloadingToCache = $state(false);

// Drafts of the editable metadata — reset when a different file is selected.
let nameDraft = $state("");
let descDraft = $state("");
let saving = $state(false);
let confirmDelete = $state(false);
let deleting = $state(false);
let replaceInput = $state<HTMLInputElement | null>(null);
let replacing = $state<string | null>(null);
// The crop/edit modal for an existing image; its result replaces the file.
let editing = $state<{ blob: Blob; name: string } | null>(null);
let preparingEdit = $state(false);

// Not $state — it must not become a reactive dependency in the effects below.
let _prevFileId = "";
let _prevPreviewKey = "";

$effect(() => {
    // It resets the drafts only when the file really changes (by id), and not when the parent sets the
    // same file on a new object reference (an onChanged with stale query data, say).
    const id = file.id;
    if (id === _prevFileId) return;
    _prevFileId = id;
    nameDraft = file.title;
    descDraft = file.description ?? "";
    confirmDelete = false;
});

let presence = $state<FilePresence | null>(null);

$effect(() => {
    const id = file.id;
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

// The one storage choice per file: "Keep on this device". The cloud is always the source of truth (a file is always
// in the cloud); this toggle merely keeps an encrypted copy locally as well. Internally it is a
// pin/unpin. Switching it off (unpinItem → freeUnpinnedTree) frees the local space at once.
const keptOnDevice = $derived(pinManager.isPinned(file.id));
function onToggleKeepOnDevice() {
    if (keptOnDevice) pinManager.unpinItem(file.id);
    else pinManager.pinItem(file.id);
}

const dirty = $derived(nameDraft.trim() !== file.title || descDraft !== (file.description ?? ""));

async function onSaveMeta() {
    if (!dirty || !nameDraft.trim()) return;
    saving = true;
    errorMsg = null;
    try {
        const { FileService } = await import("./file-service");
        await FileService.rename(file.id, {
            name: nameDraft.trim(),
            description: descDraft,
        });
        onChanged?.();
    } catch (e) {
        errorMsg = e instanceof Error ? e.message : "Save failed";
    } finally {
        saving = false;
    }
}

async function onReplacePicked(e: Event) {
    const input = e.target as HTMLInputElement;
    const picked = input.files?.[0];
    input.value = "";
    if (!picked) return;
    replacing = "Encrypting…";
    errorMsg = null;
    try {
        const { FileService } = await import("./file-service");
        await FileService.crop(file.id, picked, (p) => {
            replacing =
                p.phase === "uploading" && p.totalChunks && p.totalChunks > 1
                    ? `Uploading ${(p.chunkIndex ?? 0) + 1}/${p.totalChunks}`
                    : "Replacing…";
        });
        onChanged?.();
    } catch (e) {
        errorMsg = e instanceof Error ? e.message : "Replace failed";
    } finally {
        replacing = null;
    }
}

async function onEditImage() {
    if (preparingEdit) return;
    preparingEdit = true;
    errorMsg = null;
    try {
        const { decryptFile } = await import("./download");
        const result = await decryptFile(file.id);
        if (result.render !== "raster") throw new Error("Only images can be cropped");
        editing = {
            blob: new Blob([result.bytes as BlobPart], { type: result.blobMime }),
            name: result.name || file.title,
        };
    } catch (e) {
        errorMsg = e instanceof Error ? e.message : "Could not open editor";
    } finally {
        preparingEdit = false;
    }
}

async function onEditResult(blob: Blob, _skipped: boolean) {
    const name = editing?.name ?? file.title;
    editing = null;
    replacing = "Replacing…";
    errorMsg = null;
    try {
        const { FileService } = await import("./file-service");
        await FileService.crop(file.id, new File([blob], name, { type: blob.type || "image/png" }));
        onChanged?.();
    } catch (e) {
        errorMsg = e instanceof Error ? e.message : "Replace failed";
    } finally {
        replacing = null;
    }
}

async function onDelete() {
    deleting = true;
    // Capture the id and title locally: onClose() tears the panel down, so the `file` prop becomes
    // null before the user clicks Undo in the toast (the closure must not read a live prop).
    const deletedId = file.id;
    const deletedTitle = file.title;
    try {
        const { FileService } = await import("./file-service");
        await FileService.trash(deletedId);

        const { globalToasts } = await import("$lib/core/stores/toast.svelte");
        globalToasts.add({
            variant: "info",
            message: `${deletedTitle || "File"} moved to trash`,
            durationMs: 5000,
        });

        onChanged?.();
        onClose();
    } catch (e) {
        errorMsg = e instanceof Error ? e.message : "Move to trash failed";
        deleting = false;
    }
}

async function onMoveToNote(destinationNoteId: string) {
    pickingNote = false;
    errorMsg = null;
    try {
        const { FileService } = await import("./file-service");
        if (!file.parent_id) {
            await FileService.linkToNote(
                file.id,
                destinationNoteId,
                file.title,
                file.mime || undefined,
            );
        } else {
            await FileService.move(file.id, destinationNoteId, file.title, file.mime || undefined);
        }
        onChanged?.();
        onClose();
    } catch (e) {
        errorMsg = e instanceof Error ? e.message : "Move failed";
    }
}

// It runs again when a different file is selected OR its content changes (a Replace bumps updated_at).
// IMPORTANT: this effect only *writes* previewUrl — it must never *read* it, or previewUrl becomes its
// own dependency and the effect loops (create blob → revoke → re-decrypt → …). The URL created in this
// run is captured locally and revoked in the same run's cleanup.
$effect(() => {
    const id = file.id;
    const key = `${id}::${file.updated_at}`;
    // Skip if the id and updated_at have not really changed (the parent set the same file
    // to a new object reference, an onChanged with still-stale query data, say).
    if (key === _prevPreviewKey) return;
    _prevPreviewKey = key;
    previewState = "loading";
    errorMsg = null;

    let cancelled = false;
    let localUrl: string | null = null;
    (async () => {
        try {
            const { decryptFile, peekSniffFile, FileNotLocalError } = await import("./download");

            // A fast sniff (it fetches only the first chunk), so we do not download a 1 GB video into
            // memory for a preview.
            const sniff = await peekSniffFile(id);
            if (cancelled) return;

            if (sniff.render === "raster") {
                // If it really is an image, we need every byte for the blob URL.
                const result = await decryptFile(id);
                if (cancelled) return;

                localUrl = URL.createObjectURL(
                    new Blob([result.bytes as BlobPart], { type: result.blobMime }),
                );
                previewUrl = localUrl;
                previewState = "raster";
            } else if (sniff.render === "video" || sniff.render === "audio") {
                const { ensureStreamServiceWorker } = await import("$lib/core/streaming/sw-bridge");
                const swOk = await ensureStreamServiceWorker();
                if (cancelled) return;
                if (!swOk) {
                    previewUrl = null;
                    previewState = "download";
                } else {
                    previewUrl = `/zknotes/stream/${id}`;
                    previewState = sniff.render;
                }
            } else {
                previewUrl = null;
                previewState = "download";
            }
        } catch (e) {
            if (cancelled) return;
            // The policy forbids an auto-download → show the Download placeholder.
            const { FileNotLocalError } = await import("./download");
            if (e instanceof FileNotLocalError) {
                previewState = "needs-download";
                return;
            }
            previewState = "error";
            errorMsg = e instanceof Error ? e.message : "Failed to decrypt";

            // Report it to the server log
            import("$lib/core/api/diagnostics").then(({ reportClientError }) => {
                reportClientError({
                    message: e instanceof Error ? e.message : "Failed to decrypt",
                    fileId: id,
                    context: "File preview decryption",
                });
            });
        }
    })();

    return () => {
        cancelled = true;
        if (localUrl) URL.revokeObjectURL(localUrl);
    };
});

async function onDownload() {
    downloading = true;
    errorMsg = null;
    try {
        const { saveFile } = await import("./download");
        await saveFile(file.id);
    } catch (e) {
        if (e instanceof Error && e.name === "DownloadCancelledError") return;
        errorMsg = e instanceof Error ? e.message : "Download failed";
    } finally {
        downloading = false;
    }
}

// An explicit download when the policy blocks auto-downloading.
// Decrypts with forceDownload=true (bypassing the policy) and shows the preview.
async function onDownloadToCache() {
    downloadingToCache = true;
    errorMsg = null;
    const id = file.id;
    try {
        const { decryptFile } = await import("./download");
        const result = await decryptFile(id, undefined, { forceDownload: true });
        if (result.render === "raster") {
            const localUrl = URL.createObjectURL(
                new Blob([result.bytes as BlobPart], { type: result.blobMime }),
            );
            previewUrl = localUrl;
            previewState = "raster";
        } else {
            previewState = "download";
        }
    } catch (e) {
        previewState = "error";
        errorMsg = e instanceof Error ? e.message : "Download failed";
    } finally {
        downloadingToCache = false;
    }
}
</script>

<script module>
    import NotePickerModal from "./NotePickerModal.svelte";
    import { FileOutput } from "lucide-svelte";
</script>

<!-- The backdrop -->
<div
    class="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
    onclick={onClose}
    onkeydown={(e) => e.key === "Escape" && onClose()}
    role="button"
    tabindex="-1"
    aria-label="Close panel"
></div>

<!-- The drawer -->
<aside class="fixed right-0 top-0 bottom-0 z-50 w-full max-w-md bg-[var(--surface-app)] border-l border-[var(--stroke)] shadow-2xl flex flex-col fade-in">
    <div class="flex items-center justify-between px-5 py-4 border-b border-[var(--stroke)]">
        <div class="min-w-0">
            <Eyebrow class="!text-brand-fg/80 mb-1 flex items-center gap-1.5">
                <Shield class="w-[0.6875rem] h-[0.6875rem]" /> Encrypted file
            </Eyebrow>
            <h2 class="text-base font-semibold text-[var(--text)] truncate">{file.title}</h2>
        </div>
        <Button variant="ghost" size="icon" onclick={onClose} title="Close" class="flex-shrink-0">
            <X class="w-4 h-4" />
        </Button>
    </div>

    <div class="flex-1 overflow-y-auto p-5">
        <!-- Preview -->
        <div class="rounded-lg border border-[var(--stroke)] bg-[var(--surface-panel)] min-h-[10rem] flex items-center justify-center mb-5 overflow-hidden">
            {#if previewState === "loading"}
                <div class="flex flex-col items-center gap-2 text-[var(--text-dim)] py-10">
                    <Loader2 class="w-5 h-5 animate-spin" />
                    <span class="text-xs font-mono">Decrypting…</span>
                </div>
            {:else if previewState === "raster" && previewUrl}
                <img src={previewUrl} alt={file.title} class="max-w-full max-h-[50vh] object-contain" />
            {:else if previewState === "video" && previewUrl}
                <video src={previewUrl} controls class="max-w-full max-h-[50vh] object-contain bg-black" title={file.title}><track kind="captions" /></video>
            {:else if previewState === "audio" && previewUrl}
                <audio src={previewUrl} controls class="max-w-full" title={file.title}></audio>
            {:else if previewState === "needs-download"}
                <!-- The policy does not keep the file locally → an explicit "Load preview" (a temporary cache, not a pin). -->
                <div class="flex flex-col items-center gap-3 py-10 px-4 text-center">
                    <EmptyState>
                        File is only in the cloud on this device.<br />Load a preview, or keep it on this device for offline.
                    </EmptyState>
                    <Button
                        variant="normal"
                        onclick={onDownloadToCache}
                        disabled={downloadingToCache}
                        loading={downloadingToCache}
                        data-testid="panel-download-btn"
                    >
                        <Download class="w-[0.8125rem] h-[0.8125rem]" /> Load preview
                    </Button>
                </div>
            {:else if previewState === "error"}
                <ErrorText class="py-10 px-4 text-center">{errorMsg}</ErrorText>
            {:else}
                <EmptyState class="py-10 px-4 text-center">
                    No inline preview for this file type.<br />Save a copy to open it elsewhere.
                </EmptyState>
            {/if}
        </div>

        <!-- The editable name + description -->
        <div class="space-y-3 mb-4">
            <label class="block">
                <Eyebrow as="span" class="mb-1 block">Name</Eyebrow>
                <input
                    bind:value={nameDraft}
                    class="input input-sm input-on-panel w-full"
                />
            </label>
            <label class="block">
                <Eyebrow as="span" class="mb-1 block">Description</Eyebrow>
                <textarea
                    bind:value={descDraft}
                    rows="2"
                    placeholder="What is this file for?"
                    class="input input-sm input-on-panel w-full resize-none"
                ></textarea>
            </label>
            {#if dirty}
                <Button
                    variant="normal"
                    size="sm"
                    onclick={onSaveMeta}
                    disabled={saving || !nameDraft.trim()}
                    loading={saving}
                >
                    <Save class="w-[0.8125rem] h-[0.8125rem]" /> Save changes
                </Button>
            {/if}
        </div>

        <!-- Read-only metadata -->
        <dl class="space-y-2.5 text-xs pt-3 border-t border-[var(--stroke)]">
            <div class="flex justify-between gap-4 items-start">
                <dt class="text-[var(--text-dim)] flex-shrink-0">Location</dt>
                <dd class="text-[var(--text-sub)] flex items-center gap-1 min-w-0" title={folderPath}>
                    <FolderClosed class="w-[0.6875rem] h-[0.6875rem] flex-shrink-0 text-[var(--text-dim)]" />
                    <span class="truncate">{folderPath}</span>
                </dd>
            </div>
            <div class="flex justify-between gap-4">
                <dt class="text-[var(--text-dim)]">Size</dt>
                <dd class="text-[var(--text-sub)] font-mono">{humanSize(file.size)}</dd>
            </div>
            <div class="flex justify-between gap-4">
                <dt class="text-[var(--text-dim)]">Type</dt>
                <dd class="text-[var(--text-sub)] font-mono truncate">{file.mime || "—"}</dd>
            </div>
            <div class="flex justify-between gap-4">
                <dt class="text-[var(--text-dim)]">Updated</dt>
                <dd class="text-[var(--text-sub)]">{formatDate(file.updated_at)}</dd>
            </div>
            <div class="flex justify-between gap-4 items-center">
                <dt class="text-[var(--text-dim)]">Storage</dt>
                <dd class="flex items-center gap-1.5">
                    <FilePresenceBadge fileId={file.id} />
                </dd>
            </div>
        </dl>
    </div>

    <!-- The actions -->
    <div class="px-5 py-4 border-t border-[var(--stroke)] space-y-2">
        {#if errorMsg && previewState !== "error"}
            <ErrorText class="mb-1">{errorMsg}</ErrorText>
        {/if}
        <!-- "Download" = save a decrypted copy to disk (an export). The only "download" in the panel. -->
        <Button variant="primary" class="w-full" onclick={onDownload} disabled={downloading} loading={downloading}>
            <Download class="w-[0.875rem] h-[0.875rem]" /> Save a copy
        </Button>

        <!-- Keep on this device: the one storage choice (the cloud is always there). A switch as a
             role="switch" div (the same a11y idiom as Checkbox.svelte — with no raw button element). -->
        <div class="rounded-lg border border-[var(--stroke)] px-3 py-2.5">
            <div
                role="switch"
                tabindex="0"
                aria-checked={keptOnDevice}
                aria-label="Keep on this device"
                onclick={onToggleKeepOnDevice}
                onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleKeepOnDevice(); } }}
                class="w-full flex items-center justify-between gap-3 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-brand0/50 rounded"
            >
                <span class="flex items-center gap-2 min-w-0">
                    {#if keptOnDevice && presence !== "downloaded"}
                        <Loader2 class="w-[0.8125rem] h-[0.8125rem] animate-spin text-[var(--text-dim)] shrink-0" />
                    {:else if keptOnDevice}
                        <CloudDownload class="w-[0.8125rem] h-[0.8125rem] text-brand0 shrink-0" />
                    {:else}
                        <Cloud class="w-[0.8125rem] h-[0.8125rem] text-[var(--text-dim)] shrink-0" />
                    {/if}
                    <span class="text-sm text-[var(--text)]">Keep on this device</span>
                </span>
                <span
                    class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors {keptOnDevice ? 'bg-brand0' : 'bg-[var(--stroke)]'}"
                >
                    <span
                        class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform {keptOnDevice ? 'translate-x-[1.125rem]' : 'translate-x-0.5'}"
                    ></span>
                </span>
            </div>
            <p class="mt-1.5 text-2xs text-[var(--text-dim)] leading-snug">
                {#if keptOnDevice && presence !== "downloaded"}
                    Saving to device…
                {:else if keptOnDevice}
                    Available offline on this device.
                {:else}
                    Kept only in the cloud. Turn on to open it without internet.
                {/if}
            </p>
        </div>

        {#if previewState === "raster"}
            <Button
                variant="normal"
                class="w-full"
                onclick={onEditImage}
                disabled={preparingEdit || replacing !== null}
                loading={preparingEdit}
            >
                <Crop class="w-[0.8125rem] h-[0.8125rem]" /> Edit image
            </Button>
        {/if}
        <Button
            variant="normal"
            class="w-full"
            onclick={() => replaceInput?.click()}
            disabled={replacing !== null}
            loading={replacing !== null}
        >
            {#if replacing !== null}
                {replacing}
            {:else}
                <RefreshCw class="w-[0.8125rem] h-[0.8125rem]" /> Replace content
            {/if}
        </Button>
        <input bind:this={replaceInput} onchange={onReplacePicked} type="file" class="hidden" />
        <Button variant="ghost" class="w-full" onclick={() => (pickingNote = true)}>
            {#if !file.parent_id}
                Link to note…
            {:else}
                Move to another note…
            {/if}
        </Button>
        <Button variant="danger-ghost" class="w-full" onclick={() => (confirmDelete = true)}>
            <Trash2 class="w-[0.8125rem] h-[0.8125rem]" /> Move to trash
        </Button>
    </div>
</aside>

{#if pickingNote}
    <NotePickerModal
        title="Move to note..."
        excludedNoteId={file.parent_id || undefined}
        onClose={() => (pickingNote = false)}
        onSelect={onMoveToNote}
    />
{/if}

{#if confirmDelete}
    <Dialog title="Move to trash?">
        {#snippet children()}
            <p class="text-xs text-[var(--text-muted)] mb-3">The file will be moved to trash. You can restore it from there.</p>
        {/snippet}
        {#snippet footer()}
            <DialogActions>
                <Button onclick={() => (confirmDelete = false)}>Cancel</Button>
                <Button variant="danger" onclick={onDelete} disabled={deleting} loading={deleting}>
                    <Trash2 class="w-3 h-3" /> Move to trash
                </Button>
            </DialogActions>
        {/snippet}
    </Dialog>
{/if}

{#if editing}
    <CropModal
        file={editing.blob}
        filename={editing.name}
        onCancel={() => (editing = null)}
        onResult={onEditResult}
    />
{/if}
