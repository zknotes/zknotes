<script lang="ts">
// "Proof of existence" in the file panel: the seals of this file's current content, a way to seal
// it, and the certificate export. Rendered through core's file-panel extension point, so
// modules/files never imports this module.
import { FileOutput, ShieldCheck } from "lucide-svelte";
import { loadInstancePublicConfig } from "$lib/core/constants/public-www";
import type { FilePanelFile } from "$lib/core/events/file-panel-extensions";
import { Button, Callout, Checkbox, Dialog, DialogActions, ErrorText, Eyebrow } from "$lib/core/ui";
import { formatDate } from "$lib/core/utils/format";
import SealBadge from "./SealBadge.svelte";
import SealDialog from "./SealDialog.svelte";
import {
    chunkSetOfFile,
    existedBefore,
    loadSeals,
    type SealView,
    sealsForChunkSet,
    upgradePendingSeals,
} from "./seal-service";

interface Props {
    file: FilePanelFile;
}
const { file }: Props = $props();

/** A pending seal older than this has probably lost its calendar; the user is told so. */
const STALLED_AFTER_SEC = 24 * 60 * 60;

let seals = $state<SealView[]>([]);
let accountHasSeals = $state(false);
let perDay = $state(0);
let usedToday = $state(0);
let loaded = $state(false);
let loadError = $state<string | null>(null);
let sealing = $state(false);
let exporting = $state<SealView | null>(null);
let includeFile = $state(true);
let exportBusy = $state(false);
let exportError = $state<string | null>(null);

let instanceSeals = $state(false);
const enabled = $derived(instanceSeals && perDay > 0);
const atLimit = $derived(usedToday >= perDay);
const visible = $derived(loaded && (enabled || seals.length > 0));

function stateOf(s: SealView): "pending" | "confirmed" | "stalled" {
    if (s.state === "confirmed") return "confirmed";
    return Date.now() / 1000 - s.createdAt > STALLED_AFTER_SEC ? "stalled" : "pending";
}

function isoSeconds(iso: string): number {
    return Math.floor(Date.parse(iso) / 1000);
}

async function refresh(fileId: string, isCurrent: () => boolean) {
    loadError = null;
    try {
        const [config, chunkSetId, overview] = await Promise.all([
            loadInstancePublicConfig(),
            chunkSetOfFile(fileId),
            loadSeals(),
        ]);
        if (!isCurrent()) return;
        instanceSeals = config.sealsEnabled === true;
        perDay = overview.perDay;
        usedToday = overview.usedToday;
        accountHasSeals = overview.seals.length > 0;
        seals = chunkSetId ? sealsForChunkSet(overview.seals, chunkSetId) : [];
        loaded = true;
        if (seals.some((s) => s.state === "pending" || !s.record.block_time)) {
            const upgraded = await upgradePendingSeals(seals);
            if (isCurrent()) seals = upgraded;
        }
    } catch (e) {
        if (!isCurrent()) return;
        loaded = true;
        loadError = e instanceof Error ? e.message : "Could not load seals";
    }
}

$effect(() => {
    // Again when another file opens, or this one's content is replaced.
    const id = file.id;
    void file.updatedAt;
    let current = true;
    loaded = false;
    seals = [];
    void refresh(id, () => current);
    return () => {
        current = false;
    };
});

function onSealed(view: SealView) {
    sealing = false;
    seals = [view, ...seals];
    accountHasSeals = true;
    usedToday += 1;
}

async function onExport() {
    const view = exporting;
    if (!view) return;
    exportBusy = true;
    exportError = null;
    try {
        const { exportCertificate, SealExportCancelled } = await import("./seal-export");
        try {
            await exportCertificate(view, { itemId: file.id, includeFile });
            exporting = null;
        } catch (e) {
            if (e instanceof SealExportCancelled) return;
            throw e;
        }
    } catch (e) {
        exportError = e instanceof Error ? e.message : "Export failed";
    } finally {
        exportBusy = false;
    }
}
</script>

{#if visible}
    <section class="mt-5 pt-4 border-t border-[var(--stroke)]" data-testid="seal-section">
        <Eyebrow class="mb-2 flex items-center gap-1.5">
            <ShieldCheck class="w-[0.6875rem] h-[0.6875rem]" /> Proof of existence
            <span class="rounded border border-[var(--stroke)] px-1 text-[0.625rem] normal-case tracking-normal">Beta</span>
        </Eyebrow>

        {#if loadError}
            <ErrorText class="mb-2">{loadError}</ErrorText>
        {/if}

        {#if seals.length === 0}
            <p class="text-xs text-[var(--text-dim)] mb-3">
                Seal this file to get independent proof that its exact content existed before a point in time.
            </p>
        {:else}
            <ul class="space-y-2 mb-3">
                {#each seals as s (s.id)}
                    {@const st = stateOf(s)}
                    {@const before = st === "confirmed" ? existedBefore(s.record) : null}
                    <li class="rounded-lg border border-[var(--stroke)] px-3 py-2 text-xs" data-testid="seal-row">
                        <div class="flex items-center justify-between gap-2">
                            <SealBadge state={st} />
                            {#if st === "confirmed"}
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onclick={() => {
                                        exporting = s;
                                        includeFile = true;
                                        exportError = null;
                                    }}
                                    data-testid="seal-export"
                                >
                                    <FileOutput class="w-3 h-3" /> Export certificate
                                </Button>
                            {/if}
                        </div>
                        <p class="mt-1.5 text-[var(--text-sub)]">
                            {#if before?.source === "block"}
                                <span
                                    title="When block {before.height.toLocaleString('en-US')} was mined, by its own header, checked on this device"
                                    data-testid="seal-existed-before"
                                    data-source="block"
                                >
                                    Existed before {formatDate(isoSeconds(before.iso))}
                                </span>
                            {:else if before}
                                <span data-testid="seal-existed-before" data-source="confirmation">
                                    Existed before {formatDate(isoSeconds(before.iso))}, when this
                                    device saw the confirmation. The exact time is not checked yet.
                                </span>
                            {:else if st === "pending"}
                                Sealed {formatDate(isoSeconds(s.manifest.sealed_at))}. Waiting for
                                confirmation, usually within a few hours.
                            {:else}
                                Sealed {formatDate(isoSeconds(s.manifest.sealed_at))}, but never
                                confirmed. Seal the file again.
                            {/if}
                        </p>
                    </li>
                {/each}
            </ul>
        {/if}

        {#if enabled}
            <Button
                variant="normal"
                class="w-full"
                onclick={() => (sealing = true)}
                disabled={atLimit}
                data-testid="seal-open"
            >
                <ShieldCheck class="w-[0.8125rem] h-[0.8125rem]" />
                {seals.length === 0 ? "Seal this file" : "Seal again"}
            </Button>
            {#if atLimit}
                <p class="mt-1.5 text-2xs text-[var(--text-dim)]">
                    Daily limit reached ({perDay} seals a day). Try again tomorrow.
                </p>
            {/if}
        {/if}
    </section>
{/if}

{#if sealing}
    <SealDialog {file} firstSeal={!accountHasSeals} onClose={() => (sealing = false)} {onSealed} />
{/if}

{#if exporting}
    <Dialog title="Export certificate" onBackdropClick={exportBusy ? undefined : () => (exporting = null)}>
        {#snippet children()}
            <div class="space-y-3 text-xs text-[var(--text-muted)]">
                <p>
                    A .zip with the certificate, the proof, and instructions anyone can follow to check
                    it without ZKnotes.
                </p>
                <label class="flex items-center gap-2 cursor-pointer text-[var(--text)]">
                    <Checkbox bind:checked={includeFile} data-testid="seal-export-include" />
                    Include the original file
                </label>
                {#if !includeFile}
                    <Callout variant="warning" size="sm">
                        Note: for a third party to verify this proof, you must separately provide them
                        with the exact original file.
                    </Callout>
                {/if}
                {#if exportError}
                    <ErrorText>{exportError}</ErrorText>
                {/if}
            </div>
        {/snippet}
        {#snippet footer()}
            <DialogActions>
                <Button onclick={() => (exporting = null)} disabled={exportBusy}>Cancel</Button>
                <Button
                    variant="primary"
                    onclick={onExport}
                    disabled={exportBusy}
                    loading={exportBusy}
                    data-testid="seal-export-confirm"
                >
                    <FileOutput class="w-3 h-3" /> Export
                </Button>
            </DialogActions>
        {/snippet}
    </Dialog>
{/if}
