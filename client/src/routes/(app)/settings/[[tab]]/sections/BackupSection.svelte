<script lang="ts">
import { useQueryClient } from "@tanstack/svelte-query";
import type { RestoreMode } from "@zknotes/shared";
import {
    Download,
    FileText,
    FileUp,
    HardDriveDownload,
    Loader2,
    Shield,
    Upload,
} from "lucide-svelte";
import { onMount } from "svelte";
import { APP_EVENTS } from "$lib/core/constants/events";
import { QUERY_KEYS } from "$lib/core/constants/query-keys";
import { pushPendingMutations } from "$lib/core/sync";
import { syncStore } from "$lib/core/sync/store.svelte";
import { SettingsCard } from "$lib/core/ui";
import Button from "$lib/core/ui/Button.svelte";
import { humanSize } from "$lib/core/utils/format";
import {
    type MissingFiles,
    type MissingFilesReport,
    measureMissingFiles,
    needsDownloadNotice,
} from "$lib/modules/export/missing-files";
import type { ActiveRestore, BeginRestoreResult } from "$lib/modules/export/restore-wizard";
import type { SkippedItem } from "$lib/modules/export/utils";
import { onFilesChanged } from "$lib/modules/files/files-changed-bus";

// File attachments: separate checkboxes for the backup and the readable export card.
let backupIncludeFiles = $state(true);
let htmlExportIncludeFiles = $state(true);

let importFileInputRef = $state<HTMLInputElement>();

// ── Readable export (HTML or Markdown) ────────────────────────────────────────────────────
let exportingHtml = $state(false);
let exportHtmlMsg = $state("");
/** The readable format last asked for: the one waiting behind the download notice, or running. */
let readableFormat = $state<"html" | "markdown">("html");
const runningFormat = $derived(exportingHtml ? readableFormat : null);

// The encrypted full backup: a separate passphrase → an Argon2id container.
let encBackupState = $state<"idle" | "prompt" | "exporting">("idle");
let encBackupPass = $state("");
let encBackupPassConfirm = $state("");
let encBackupError = $state("");
let encBackupMsg = $state("");

// ── What a backup or an export downloads first ──────────────────────────────
// Measured when the section opens and after the files change — never between the click and the save
// dialog, which needs the click's transient activation.
let missingFiles = $state<MissingFilesReport | null>(null);
let measuringFiles = $state(true);
let measureRunning = false;
let measureAgain = false;
/** The export that waits for the user to accept downloading first. */
let downloadNotice = $state<"backup" | "html" | null>(null);
let encBackupSkipped = $state<SkippedItem[]>([]);
let exportHtmlSkipped = $state<SkippedItem[]>([]);

// Restore wizard state
type RestoreUiState =
    | "idle"
    | "loading"
    | "passphrase"
    | "mode_select"
    | "summary"
    | "pending_sync"
    | "resume"
    | "wrong_file"
    | "other_session"
    | "importing"
    | "blocked"
    | "dirty";

let zipImportState = $state<RestoreUiState>("idle");
let zipParsedBackup = $state<import("$lib/modules/export/full-backup-import").ParsedBackup | null>(
    null,
);
let zipEncryptedBytes = $state<Uint8Array | null>(null);
let zipRawBytes = $state<Uint8Array | null>(null);
let zipImportPass = $state("");
let zipImportMode = $state<"overwrite" | "skip">("skip");
let zipImportError = $state("");
let zipImportProgress = $state({ done: 0, total: 0, label: "" });
let restoreSession = $state<ActiveRestore | null>(null);
/** A non-proxied copy for executeRestore — a $state proxy breaks the IDB structured clone and Maps. */
let restoreEngine: ActiveRestore | null = null;
let restoreResult = $state<"done" | "dirty" | null>(null);
let restoreLeftover = $state<string[]>([]);
let restoreBlockers = $state<string>("");
let otherSessionId = $state("");
let pendingResumeHash = $state("");

function toRestoreMode(mode: "overwrite" | "skip"): RestoreMode {
    return mode === "overwrite" ? "overwrite_all" : "skip_existing";
}

/** A cancelled "Save as" dialog is not an error — recognise it by name, without eagerly importing the sink module. */
function isBackupAborted(e: unknown): boolean {
    return e instanceof Error && e.name === "BackupAbortedError";
}

/**
 * A restore the server refused reads as a sentence with the server's code in brackets, not as the
 * bare code. Recognised by name too, so the restore API module is not imported eagerly.
 */
function restoreErrorMessage(e: unknown, fallback: string): string {
    if (e instanceof Error && e.name === "RestoreClientError") {
        return `The server refused the restore (${e.message}).`;
    }
    return e instanceof Error ? e.message : fallback;
}

function exportBusy(): boolean {
    return encBackupState === "exporting" || exportingHtml;
}

async function measureFiles(): Promise<void> {
    // An export's own reads emit filesChanged for every file — measure again once it has finished.
    if (measureRunning || exportBusy()) {
        measureAgain = true;
        return;
    }
    measureRunning = true;
    measuringFiles = true;
    try {
        do {
            measureAgain = false;
            missingFiles = await measureMissingFiles();
        } while (measureAgain && !exportBusy());
    } catch (e) {
        // Without a measurement the export still downloads what it needs; it just cannot say so first.
        console.warn("[backup] could not measure the files to download", e);
        missingFiles = null;
    } finally {
        measureRunning = false;
        measuringFiles = false;
    }
}

function afterExport(): void {
    if (measureAgain) void measureFiles();
}

/**
 * What the given export would download first, when that needs the user's go-ahead: `null` when it
 * downloads nothing, stays within what this device's auto-download policy would fetch anyway, or
 * the measurement is unknown.
 */
function missingFor(kind: "backup" | "html"): MissingFiles | null {
    if (!missingFiles) return null;
    const missing =
        kind === "backup"
            ? backupIncludeFiles
                ? missingFiles.all
                : null
            : htmlExportIncludeFiles
              ? missingFiles.all
              : missingFiles.embedded;
    return needsDownloadNotice(missing) ? missing : null;
}

function describeSkipped(items: SkippedItem[]): string {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
    return [...counts].map(([type, n]) => `${n} ${type}${n === 1 ? "" : "s"}`).join(", ");
}

const queryClient = useQueryClient();

async function handleImportFileSelect(file: File) {
    zipImportError = "";
    restoreResult = null;
    await handleZipFileSelect(file);
    if (importFileInputRef) importFileInputRef.value = "";
}

function resetImport() {
    zipImportState = "idle";
    zipParsedBackup = null;
    zipEncryptedBytes = null;
    zipRawBytes = null;
    zipImportPass = "";
    zipImportError = "";
    restoreSession = null;
    restoreEngine = null;
    restoreBlockers = "";
    otherSessionId = "";
    pendingResumeHash = "";
}

async function cancelRestore() {
    const { abortActiveRestore, loadPersistedRestore } = await import(
        "$lib/modules/export/restore-wizard"
    );
    if (restoreSession) {
        await abortActiveRestore(restoreSession.sessionId).catch(() => {});
    } else {
        const persisted = await loadPersistedRestore();
        if (persisted) await abortActiveRestore(persisted.restore_session_id).catch(() => {});
    }
    resetImport();
}

async function runReadableExport(format: "html" | "markdown", downloadAccepted = false) {
    if (exportingHtml) return;
    readableFormat = format;
    // The notice comes before the save dialog, not after it. Both formats include the same files.
    if (!downloadAccepted && missingFor("html")) {
        downloadNotice = "html";
        return;
    }
    downloadNotice = null;
    exportHtmlSkipped = [];
    exportingHtml = true;
    exportHtmlMsg = "Decrypting…";
    const options = {
        includeFiles: htmlExportIncludeFiles,
        onProgress: (p: { phase: "notes" | "files" | "zipping"; done: number; total: number }) => {
            if (p.phase === "notes") exportHtmlMsg = `Notes ${p.done}/${p.total}…`;
            else if (p.phase === "files") exportHtmlMsg = `Files ${p.done}/${p.total}…`;
            else exportHtmlMsg = "Packaging…";
        },
    };
    try {
        if (format === "html") {
            const { exportHtml } = await import("$lib/modules/export/html-export");
            exportHtmlSkipped = (await exportHtml(options)).skipped;
        } else {
            const { exportMarkdown } = await import("$lib/modules/export/markdown-export");
            exportHtmlSkipped = (await exportMarkdown(options)).skipped;
        }
    } catch (e: unknown) {
        if (!isBackupAborted(e)) alert(e instanceof Error ? e.message : "Export failed");
    } finally {
        exportingHtml = false;
        exportHtmlMsg = "";
        afterExport();
    }
}

async function startEncryptedBackup(downloadAccepted = false) {
    encBackupError = "";
    // No minimum length — the user chooses how strong a passphrase they want (a short one is allowed).
    if (encBackupPass.length === 0) {
        encBackupError = "Enter a passphrase.";
        return;
    }
    if (encBackupPass !== encBackupPassConfirm) {
        encBackupError = "Passphrases do not match.";
        return;
    }
    // The notice comes before the save dialog, not after it.
    if (!downloadAccepted && missingFor("backup")) {
        downloadNotice = "backup";
        return;
    }
    downloadNotice = null;
    encBackupSkipped = [];
    const passphrase = encBackupPass;
    encBackupState = "exporting";
    encBackupMsg = "Decrypting…";
    try {
        const { exportFullBackup } = await import("$lib/modules/export/full-backup");
        const result = await exportFullBackup({
            encrypt: true,
            passphrase,
            includeFiles: backupIncludeFiles,
            onProgress: (p) => {
                if (p.phase === "notes") encBackupMsg = `Notes ${p.done}/${p.total}…`;
                else if (p.phase === "files") encBackupMsg = `Files ${p.done}/${p.total}…`;
                else encBackupMsg = "Encrypting & packaging…";
            },
        });
        encBackupSkipped = result.skipped;
        encBackupState = "idle";
        encBackupPass = "";
        encBackupPassConfirm = "";
    } catch (e: unknown) {
        encBackupState = "prompt";
        if (!isBackupAborted(e)) encBackupError = e instanceof Error ? e.message : "Export failed";
    } finally {
        encBackupMsg = "";
        afterExport();
    }
}

async function handleZipFileSelect(file: File) {
    zipImportState = "loading";
    zipImportError = "";
    restoreResult = null;
    zipEncryptedBytes = null;
    try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        zipRawBytes = bytes;
        const { isEncryptedBackup, parseBackupZip } = await import(
            "$lib/modules/export/full-backup-import"
        );
        if (isEncryptedBackup(bytes)) {
            zipEncryptedBytes = bytes;
            zipImportState = "passphrase";
        } else {
            zipParsedBackup = parseBackupZip(bytes);
            if (pendingResumeHash) {
                await continueWithParsed();
            } else {
                zipImportState = "mode_select";
            }
        }
    } catch (e: unknown) {
        zipImportError = restoreErrorMessage(e, "Error reading ZIP file.");
        zipImportState = "idle";
    }
}

async function submitZipPassphrase() {
    if (!zipEncryptedBytes || !zipImportPass) return;
    zipImportError = "";
    zipImportState = "loading";
    try {
        const { parseEncryptedBackupZip } = await import("$lib/modules/export/full-backup-import");
        zipParsedBackup = await parseEncryptedBackupZip(zipEncryptedBytes, zipImportPass);
        zipImportPass = "";
        zipEncryptedBytes = null;
        if (pendingResumeHash) {
            await continueWithParsed();
        } else {
            zipImportState = "mode_select";
        }
    } catch (e: unknown) {
        zipImportError = restoreErrorMessage(e, "Decryption error.");
        zipImportState = "passphrase";
    }
}

async function applyBeginResult(result: BeginRestoreResult) {
    if (result.status === "pending_unsynced") {
        zipImportState = "pending_sync";
        return;
    }
    if (result.status === "wrong_backup") {
        zipImportState = "wrong_file";
        zipImportError = "This is not the backup that started this restore.";
        return;
    }
    if (result.status === "other_session") {
        otherSessionId = result.restore_session_id;
        zipImportState = "other_session";
        return;
    }
    restoreEngine = result.session;
    // The verdict alone for the UI — $state must not wrap the engine's Map/fileMap (the IDB clone + execute).
    restoreSession = {
        ...result.session,
        items: [],
        fileMap: new Map(),
        idMap: new Map(),
        stagedIds: [],
    };
    zipImportState = "summary";
}

async function continueWithParsed() {
    if (!zipParsedBackup || !zipRawBytes) return;
    const { hashBackupBytes, resumeRestore } = await import("$lib/modules/export/restore-wizard");
    const hash = await hashBackupBytes(zipRawBytes);
    const result = await resumeRestore({ parsed: zipParsedBackup, backupHash: hash });
    pendingResumeHash = "";
    await applyBeginResult(result);
}

async function startRestoreReview() {
    if (!zipParsedBackup || !zipRawBytes) return;
    zipImportError = "";
    zipImportState = "loading";
    try {
        const { beginRestore, hashBackupBytes } = await import(
            "$lib/modules/export/restore-wizard"
        );
        const hash = await hashBackupBytes(zipRawBytes);
        const result = await beginRestore({
            parsed: zipParsedBackup,
            backupHash: hash,
            mode: toRestoreMode(zipImportMode),
        });
        await applyBeginResult(result);
    } catch (e: unknown) {
        zipImportError = restoreErrorMessage(e, "Restore error.");
        zipImportState = "mode_select";
    }
}

async function confirmRestore() {
    if (!restoreEngine) return;
    zipImportState = "importing";
    zipImportError = "";
    zipImportProgress = { done: 0, total: 1, label: "Starting" };
    try {
        const { executeRestore } = await import("$lib/modules/export/restore-wizard");
        const result = await executeRestore(restoreEngine, (p) => {
            zipImportProgress = p;
        });
        if (result.status === "blocked") {
            restoreBlockers = result.blockers.map((b) => b.code).join(", ");
            zipImportState = "blocked";
            return;
        }
        if (result.status === "committed_dirty") {
            restoreLeftover = result.leftoverDirty;
            restoreResult = "dirty";
            zipImportState = "dirty";
        } else {
            restoreResult = "done";
            zipImportState = "idle";
        }
        zipParsedBackup = null;
        zipRawBytes = null;
        restoreSession = null;
        restoreEngine = null;
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
    } catch (e: unknown) {
        zipImportError = restoreErrorMessage(e, "Restore error.");
        zipImportState = "summary";
    }
}

async function syncThenContinue() {
    zipImportError = "";
    zipImportState = "loading";
    try {
        await pushPendingMutations({ force: true });
        await syncStore.refreshPendingCount();
        if (syncStore.pendingCount > 0) {
            zipImportError = "Some changes are still waiting to sync. Stay online and try again.";
            zipImportState = "pending_sync";
            return;
        }
        await startRestoreReview();
    } catch (e: unknown) {
        zipImportError = e instanceof Error ? e.message : "Sync failed.";
        zipImportState = "pending_sync";
    }
}

async function abortOtherSession() {
    if (!otherSessionId) return;
    const { abortActiveRestore } = await import("$lib/modules/export/restore-wizard");
    await abortActiveRestore(otherSessionId);
    otherSessionId = "";
    await startRestoreReview();
}

onMount(() => {
    void (async () => {
        const { loadPersistedRestore } = await import("$lib/modules/export/restore-wizard");
        const persisted = await loadPersistedRestore();
        if (persisted) {
            pendingResumeHash = persisted.backup_hash;
            zipImportState = "resume";
        }
    })();

    void measureFiles();
    const offFilesChanged = onFilesChanged(() => void measureFiles());
    const onItemsChanged = () => void measureFiles();
    window.addEventListener(APP_EVENTS.vaultItemsChanged, onItemsChanged);
    return () => {
        offFilesChanged();
        window.removeEventListener(APP_EVENTS.vaultItemsChanged, onItemsChanged);
    };
});
</script>

{#snippet downloadNoticeBox(missing: MissingFiles | null, continueLabel: string, onContinue: () => void)}
    {#if missing}
        <div
            class="p-4 bg-[var(--warning)]/10 text-sm rounded-xl border border-[var(--warning)]/20 space-y-3"
            data-testid="export-download-notice"
        >
            <p class="text-[var(--text)]">
                {missing.count} {missing.count === 1 ? "file is" : "files are"} not on this device
                ({humanSize(missing.bytes)}) and will be downloaded first. Nothing is kept on the device
                afterwards.
            </p>
            <div class="flex gap-3">
                <Button variant="primary" size="lg" onclick={onContinue}>{continueLabel}</Button>
                <Button variant="normal" size="lg" onclick={() => (downloadNotice = null)}>Cancel</Button>
            </div>
        </div>
    {/if}
{/snippet}

{#snippet skippedSummary(items: SkippedItem[], what: string)}
    <div
        class="p-4 mb-4 bg-[var(--warning)]/10 text-sm rounded-xl border border-[var(--warning)]/20"
        data-testid="export-skipped"
    >
        <p class="font-medium text-[var(--text)]">
            The {what} was saved without {items.length} {items.length === 1 ? "item" : "items"} that
            could not be read: {describeSkipped(items)}.
        </p>
        <details class="mt-2 text-[var(--text-muted)]">
            <summary class="cursor-pointer">Details</summary>
            <ul class="mt-1 space-y-0.5 font-mono text-xs">
                {#each items as item (item.id)}
                    <li>{item.type} {item.id} — {item.reason}</li>
                {/each}
            </ul>
        </details>
    </div>
{/snippet}

<div class="mb-8">
    <h1 class="text-2xl font-bold text-[var(--text)]">Backup & Export</h1>
    <p class="text-[var(--text-muted)] mt-1 text-sm">Save and restore your encrypted data</p>
</div>

<div class="divide-y divide-[var(--stroke)]" data-testid="backup-cards">
    <SettingsCard
        tone="brand"
        title="Backup"
        description="Create an encrypted backup you can restore later."
        testId="backup-create"
    >
        {#snippet icon()}
            <Shield class="w-6 h-6" />
        {/snippet}
        <div class="mb-6 space-y-2.5">
            <label class="flex items-center gap-3 text-sm text-[var(--text-muted)]">
                <input type="checkbox" checked disabled class="checkbox" />
                Notes &amp; folders <span class="text-xs">(always included)</span>
            </label>
            <label class="flex items-center gap-3 text-sm text-[var(--text)] cursor-pointer">
                <input type="checkbox" bind:checked={backupIncludeFiles} class="checkbox" />
                File attachments
            </label>
        </div>

        {#if encBackupSkipped.length > 0}
            {@render skippedSummary(encBackupSkipped, "backup")}
        {/if}

        {#if encBackupState !== "idle"}
            <div class="p-5 border border-brand0/20 bg-brand0/5 rounded-2xl space-y-3 mb-4">
                <p class="text-sm text-[var(--text)] font-medium">
                    Choose a passphrase to encrypt this backup. You'll need it to restore — it is independent of your account password and <strong>cannot be recovered if lost</strong>.
                </p>
                {#if encBackupError}
                    <div class="p-3 bg-[var(--danger)]/10 text-[var(--danger)] text-sm rounded-xl border border-[var(--danger)]/20 font-medium">{encBackupError}</div>
                {/if}
                <form onsubmit={(e) => { e.preventDefault(); startEncryptedBackup(); }} class="space-y-3">
                    <input type="text" autocomplete="username" class="hidden" value="zknotes-backup" aria-hidden="true" />
                    <input
                        type="password"
                        autocomplete="new-password"
                        bind:value={encBackupPass}
                        disabled={encBackupState === "exporting"}
                        placeholder="Backup passphrase"
                        class="input w-full"
                    />
                    <input
                        type="password"
                        autocomplete="new-password"
                        bind:value={encBackupPassConfirm}
                        disabled={encBackupState === "exporting"}
                        placeholder="Confirm passphrase"
                        class="input w-full"
                    />
                    {#if downloadNotice === "backup" && missingFor("backup")}
                        {@render downloadNoticeBox(missingFor("backup"), "Download and back up", () => void startEncryptedBackup(true))}
                    {:else}
                        <div class="flex gap-3">
                            <Button
                                type="submit"
                                variant="primary"
                                size="lg"
                                loading={encBackupState === "exporting"}
                                disabled={backupIncludeFiles && measuringFiles && encBackupState !== "exporting"}
                            >
                                {#if encBackupState === "exporting"}
                                    {encBackupMsg || "Exporting…"}
                                {:else if backupIncludeFiles && measuringFiles}
                                    Checking files…
                                {:else}
                                    Create Encrypted Backup
                                {/if}
                            </Button>
                            <Button
                                type="button"
                                variant="normal"
                                size="lg"
                                disabled={encBackupState === "exporting"}
                                onclick={() => { encBackupState = "idle"; encBackupError = ""; encBackupPass = ""; encBackupPassConfirm = ""; }}
                            >
                                Cancel
                            </Button>
                        </div>
                    {/if}
                </form>
            </div>
        {:else}
            <Button
                variant="primary"
                size="lg"
                onclick={() => { encBackupError = ""; encBackupState = "prompt"; }}
            >
                <Shield class="w-4 h-4" />
                Create Encrypted Backup
            </Button>
        {/if}
    </SettingsCard>

    <SettingsCard title="Restore" description="Restore from a backup file.">
        {#snippet icon()}
            <FileUp class="w-6 h-6" />
        {/snippet}
        <div class="space-y-5">
            {#if zipImportError}
                <div class="p-4 bg-[var(--danger)]/10 text-[var(--danger)] text-sm rounded-xl border border-[var(--danger)]/20 font-medium">
                    {zipImportError}
                </div>
            {/if}
            {#if restoreResult === "done"}
                <div
                    class="p-4 bg-brand0/10 text-brand0 text-sm rounded-xl border border-brand0/20 font-medium flex items-center gap-2"
                    data-testid="restore-complete"
                >
                    <span class="text-xl">✅</span>
                    <span>Restore complete. This device now matches the server.</span>
                </div>
            {/if}

            <!-- One picker for both the first selection and "Continue": two inputs bound to the same
                 ref would leave the ref on whichever branch rendered last. -->
            <input
                type="file"
                accept=".zip,.cnbackup"
                class="hidden"
                bind:this={importFileInputRef}
                onchange={(e) => {
                    const f = (e.target as HTMLInputElement).files?.[0];
                    if (f) void handleImportFileSelect(f);
                }}
            />
            {#if zipImportState === "idle"}
                <div>
                    <Button
                        variant="warning"
                        size="lg"
                        onclick={() => importFileInputRef?.click()}
                    >
                        <Upload class="w-4 h-4" />
                        Select backup file
                    </Button>
                </div>
            {:else if zipImportState === "loading"}
                <div class="flex items-center gap-3 p-4 bg-[var(--surface-raised)]/50 rounded-xl text-sm font-medium">
                    <Loader2 class="w-5 h-5 animate-spin text-[var(--accent-color)]" />
                    <span>Working…</span>
                </div>
            {:else if zipImportState === "resume"}
                <div class="p-5 border border-brand0/20 bg-brand0/5 rounded-2xl space-y-4" data-testid="restore-continue">
                    <h3 class="font-bold text-[var(--text)]">Continue restore</h3>
                    <p class="text-sm text-[var(--text-muted)]">
                        A restore is already in progress. Select the same backup file to continue. The backup is not stored in this browser.
                    </p>
                    <div class="flex gap-3">
                        <Button variant="primary" size="lg" onclick={() => importFileInputRef?.click()}>
                            Continue
                        </Button>
                        <Button variant="normal" size="lg" onclick={() => void cancelRestore()}>Cancel</Button>
                    </div>
                </div>
            {:else if zipImportState === "wrong_file"}
                <div class="p-5 border border-[var(--danger)]/20 bg-[var(--danger)]/5 rounded-2xl space-y-4" data-testid="restore-wrong-file">
                    <h3 class="font-bold">This is not the backup that started this restore</h3>
                    <p class="text-sm text-[var(--text-muted)]">Choose the original file, or abandon the in-progress restore.</p>
                    <div class="flex gap-3">
                        <Button variant="primary" size="lg" onclick={() => { zipImportError = ""; zipImportState = "resume"; }}>
                            Try another file
                        </Button>
                        <Button
                            variant="danger"
                            size="lg"
                            onclick={async () => {
                                const { abortActiveRestore, loadPersistedRestore } = await import("$lib/modules/export/restore-wizard");
                                if (restoreSession) await abortActiveRestore(restoreSession.sessionId);
                                else {
                                    const p = await loadPersistedRestore();
                                    if (p) await abortActiveRestore(p.restore_session_id);
                                }
                                resetImport();
                            }}
                        >
                            Abandon restore
                        </Button>
                    </div>
                </div>
            {:else if zipImportState === "other_session"}
                <div class="p-5 border border-[var(--warning)]/20 bg-[var(--warning)]/5 rounded-2xl space-y-4">
                    <h3 class="font-bold">Another restore is already open</h3>
                    <p class="text-sm text-[var(--text-muted)]">Only one restore can run at a time. Abandon it to start this file, or cancel.</p>
                    <div class="flex gap-3">
                        <Button variant="danger" size="lg" onclick={() => void abortOtherSession()}>
                            Abandon the other restore
                        </Button>
                        <Button variant="normal" size="lg" onclick={resetImport}>Cancel</Button>
                    </div>
                </div>
            {:else if zipImportState === "pending_sync"}
                <div class="p-5 border border-[var(--warning)]/20 bg-[var(--warning)]/5 rounded-2xl space-y-4" data-testid="restore-sync-first">
                    <h3 class="font-bold">Sync your changes first</h3>
                    <p class="text-sm text-[var(--text-muted)]">
                        You have unsynced work on this device. Restore will not start until those changes reach the server — otherwise they would be lost.
                    </p>
                    <div class="flex gap-3">
                        <Button variant="primary" size="lg" onclick={() => void syncThenContinue()}>
                            Sync then continue
                        </Button>
                        <Button variant="normal" size="lg" onclick={resetImport}>Cancel</Button>
                    </div>
                </div>
            {:else if zipImportState === "passphrase"}
                    <div class="p-5 border border-brand0/30 bg-brand0/5 rounded-2xl space-y-4">
                        <div class="flex items-start gap-3 text-brand0">
                            <Shield class="w-5 h-5 shrink-0 mt-0.5" />
                            <div>
                                <h3 class="font-bold">Encrypted backup</h3>
                                <p class="text-sm text-[var(--text-muted)] mt-1">Enter the passphrase you chose when creating this backup.</p>
                            </div>
                        </div>
                        <form onsubmit={(e) => { e.preventDefault(); submitZipPassphrase(); }} class="flex gap-3">
                            <input type="text" autocomplete="username" class="hidden" value="zknotes-backup" aria-hidden="true" />
                            <input
                                type="password"
                                autocomplete="current-password"
                                bind:value={zipImportPass}
                                placeholder="Backup passphrase"
                                class="input flex-1"
                            />
                            <Button
                                type="submit"
                                variant="primary"
                                size="lg"
                                disabled={!zipImportPass}
                            >
                                Unlock
                            </Button>
                        </form>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onclick={resetImport}
                        >Cancel</Button>
                    </div>
            {:else if zipImportState === "importing"}
                <div class="flex items-center gap-3 p-4 bg-[var(--surface-raised)]/50 rounded-xl text-sm font-medium">
                    <Loader2 class="w-5 h-5 animate-spin text-brand0" />
                    <span>{zipImportProgress.label || "Restoring"} {zipImportProgress.done}/{zipImportProgress.total}…</span>
                </div>
            {:else if zipImportState === "blocked"}
                <div class="p-5 border border-[var(--warning)]/20 bg-[var(--warning)]/5 rounded-2xl space-y-4">
                    <h3 class="font-bold">Restore cannot finish yet</h3>
                    <p class="text-sm text-[var(--text-muted)]">{restoreBlockers || "The server reported a problem with this restore."}</p>
                    <Button variant="normal" size="lg" onclick={() => (zipImportState = "summary")}>Back</Button>
                </div>
            {:else if zipImportState === "dirty"}
                <div class="p-4 bg-[var(--warning)]/10 text-[var(--warning)] text-sm rounded-xl border border-[var(--warning)]/20">
                    Restore reached the server, but this device had unsynced notes created during the restore
                    ({restoreLeftover.length}). Those notes were kept. Sync them, then refresh to see the restored vault.
                </div>
            {:else if zipImportState === "mode_select" || zipImportState === "summary"}
                <div class="p-5 border border-brand0/20 bg-brand0/5 rounded-2xl space-y-4">
                    <div class="flex items-start gap-3">
                        <div class="p-2 bg-brand0/20 rounded-full text-brand0 shrink-0">
                            <HardDriveDownload class="w-4 h-4" />
                        </div>
                        <div>
                            <h3 class="font-bold text-[var(--text)]">
                                {zipImportState === "summary" ? "Ready to restore" : "Backup ready"}
                            </h3>
                            <p class="text-sm text-[var(--text-muted)] mt-1">
                                Found <strong>{zipParsedBackup?.items.length}</strong> items.
                                {#if zipImportState === "mode_select"}
                                    How should items that already exist on the server be handled?
                                {/if}
                            </p>
                        </div>
                    </div>

                    {#if zipImportState === "mode_select"}
                        <div class="space-y-3 pt-1">
                            <label class="flex items-start gap-3 p-3 rounded-xl border border-[var(--stroke)] hover:bg-[var(--surface-raised)]/50 cursor-pointer transition-colors {zipImportMode === 'skip' ? 'bg-[var(--surface-raised)]' : ''}">
                                <input type="radio" name="zip_mode" value="skip" bind:group={zipImportMode} class="radio mt-1" />
                                <div>
                                    <div class="font-semibold text-[var(--text)]">Skip existing (Recommended)</div>
                                    <div class="text-sm text-[var(--text-muted)]">Leaves items that already exist on the server — including ones in Trash — unchanged.</div>
                                </div>
                            </label>
                            <label class="flex items-start gap-3 p-3 rounded-xl border border-[var(--stroke)] hover:bg-[var(--surface-raised)]/50 cursor-pointer transition-colors {zipImportMode === 'overwrite' ? 'bg-[var(--surface-raised)]' : ''}">
                                <input type="radio" name="zip_mode" value="overwrite" bind:group={zipImportMode} class="radio mt-1" />
                                <div>
                                    <div class="font-semibold text-[var(--text)]">Overwrite all</div>
                                    <div class="text-sm text-[var(--text-muted)]">Replaces matching items with the backup version and restores trashed ones. Items not in the backup stay.</div>
                                </div>
                            </label>
                        </div>
                    {:else if restoreSession}
                        <ul class="text-sm text-[var(--text-muted)] space-y-1">
                            <li>Create {restoreSession.verdict.counts.creates} · overwrite {restoreSession.verdict.counts.overwrites} · skip {restoreSession.verdict.counts.skips}</li>
                            {#if restoreSession.verdict.counts.collide_purged - (restoreSession.verdict.counts.collide_remapped ?? 0) > 0}
                                <!-- An entry whose new id already exists (restored before)
                                     shows up as skip or overwrite instead. -->
                                <li>{restoreSession.verdict.counts.collide_purged - (restoreSession.verdict.counts.collide_remapped ?? 0)} items get new IDs because they were permanently deleted.</li>
                            {/if}
                            {#if restoreSession.verdict.quota.peak_used > restoreSession.verdict.quota.quota && restoreSession.verdict.quota.peak_ok}
                                <li>Storage will temporarily go over your plan while restore runs, then drop back.</li>
                            {/if}
                            {#if restoreSession.verdict.orphan_parents.length > 0}
                                <li>Some items cannot be restored because their folder is in Trash. Change mode or cancel.</li>
                            {/if}
                        </ul>
                    {/if}

                    <div class="flex gap-3 pt-1">
                        {#if zipImportState === "mode_select"}
                            <Button
                                variant="primary"
                                size="lg"
                                class="flex-1"
                                onclick={() => void startRestoreReview()}
                            >
                                Start restore
                            </Button>
                        {:else}
                            <Button
                                variant="primary"
                                size="lg"
                                class="flex-1"
                                disabled={!!restoreSession && (!restoreSession.verdict.ok || restoreSession.verdict.orphan_parents.length > 0)}
                                onclick={() => void confirmRestore()}
                            >
                                Confirm restore
                            </Button>
                        {/if}
                        <Button
                            variant="normal"
                            size="lg"
                            onclick={() =>
                                zipImportState === "summary"
                                    ? void cancelRestore()
                                    : resetImport()}
                        >
                            Cancel
                        </Button>
                    </div>
                </div>
            {/if}
        </div>
    </SettingsCard>

    <!-- The readable export: HTML or Markdown -->
    <SettingsCard
        tone="secondary"
        title="Export"
        description="Download a readable copy of your notes, as HTML pages or Markdown files."
        testId="export-html"
    >
        {#snippet icon()}
            <Download class="w-6 h-6" />
        {/snippet}
        <div class="p-4 bg-amber-500/10 text-amber-500/90 text-sm rounded-xl border border-amber-500/20 font-medium mb-6 flex gap-3 items-start">
            <span class="text-lg">⚠️</span>
            <div>
                <strong class="block text-amber-500 mb-1">A readable export writes your decrypted notes to disk.</strong>
                The files are <strong>not encrypted</strong>: anyone with access to your Downloads folder, OS search index, or a synced cloud Downloads can read them. Delete them after use, or prefer an encrypted backup.
            </div>
        </div>

        <div class="mb-6 space-y-2.5">
            <label class="flex items-center gap-3 text-sm text-[var(--text-muted)]">
                <input type="checkbox" checked disabled class="checkbox" />
                Notes &amp; folders <span class="text-xs">(always included)</span>
            </label>
            <label class="flex items-center gap-3 text-sm text-[var(--text)] cursor-pointer">
                <input type="checkbox" bind:checked={htmlExportIncludeFiles} class="checkbox" />
                File attachments
            </label>
        </div>

        {#if exportHtmlSkipped.length > 0}
            {@render skippedSummary(exportHtmlSkipped, "export")}
        {/if}

        {#if downloadNotice === "html" && missingFor("html")}
            {@render downloadNoticeBox(missingFor("html"), "Download and export", () => void runReadableExport(readableFormat, true))}
        {:else}
            <div class="flex flex-wrap gap-3">
                <Button
                    variant="primary"
                    size="lg"
                    loading={runningFormat === "html"}
                    disabled={runningFormat === "markdown" || (measuringFiles && !exportingHtml)}
                    onclick={() => void runReadableExport("html")}
                >
                    {#if runningFormat === "html"}
                        {exportHtmlMsg || "Exporting…"}
                    {:else if measuringFiles}
                        Checking files…
                    {:else}
                        <Download class="w-4 h-4" />
                        Export as HTML
                    {/if}
                </Button>
                <Button
                    variant="normal"
                    size="lg"
                    loading={runningFormat === "markdown"}
                    disabled={runningFormat === "html" || (measuringFiles && !exportingHtml)}
                    onclick={() => void runReadableExport("markdown")}
                >
                    {#if runningFormat === "markdown"}
                        {exportHtmlMsg || "Exporting…"}
                    {:else if measuringFiles}
                        Checking files…
                    {:else}
                        <FileText class="w-4 h-4" />
                        Export as Markdown
                    {/if}
                </Button>
            </div>
        {/if}
    </SettingsCard>
</div>
