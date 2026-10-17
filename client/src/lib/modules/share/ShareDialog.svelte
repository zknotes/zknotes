<script lang="ts">
import { Copy, Eye, EyeOff, Info, Trash2 } from "lucide-svelte";
import { Toggle } from "bits-ui";
import Dialog from "$lib/core/ui/Dialog.svelte";
import DialogActions from "$lib/core/ui/DialogActions.svelte";
import Button from "$lib/core/ui/Button.svelte";
import { globalToasts } from "$lib/core/stores/toast.svelte";
import { getStorage } from "$lib/core/api/files";
import type { ShareListEntry } from "$lib/core/api/shares";
import {
    createShareLink,
    formatShareError,
    getActiveShareForNote,
    revokeShare,
    shareTtlOptions,
    type ShareLinkType,
} from "./share-service";
import { formatDate } from "$lib/core/utils/format";
import { countInternalNoteLinks } from "./share-note-links";

let {
    open = $bindable(false),
    noteId,
    noteContent = "",
    attachmentFileIds = [],
}: {
    open?: boolean;
    noteId: string;
    /** The note's current HTML content — for the warning about internal links. */
    noteContent?: string;
    attachmentFileIds?: string[];
} = $props();

let linkType = $state<ShareLinkType>("standard");
let expiresInSec = $state(24 * 3600);
let usePassword = $state(false);
let password = $state("");
let showSharePassword = $state(false);
let includeAttachments = $state(false);
/** The concrete TTL limit from the server; `0` until the answer arrives (feature-off). */
let maxShareTtlSec = $state(0);
let creating = $state(false);
let revoking = $state(false);
let createdUrl = $state<string | null>(null);
let existingShare = $state<ShareListEntry | null>(null);
/** The user wants a new link rather than a look at the existing one. */
let replacing = $state(false);

const ttlOptions = $derived(shareTtlOptions(maxShareTtlSec));
const canIncludeAttachments = $derived(attachmentFileIds.length > 0);
const shareTypeOptions = [
    { value: "standard", icon: "🔗", label: "Standard link" },
    { value: "expiry", icon: "⏱", label: "Expires in" },
    { value: "burn", icon: "🔥", label: "One-time (link dies after first view)" },
] as const satisfies ReadonlyArray<{
    value: ShareLinkType;
    icon: string;
    label: string;
}>;

const showExistingPanel = $derived(Boolean(existingShare && !createdUrl && !replacing));
const showCreateForm = $derived(!createdUrl && (!existingShare || replacing));
const internalLinkCount = $derived(countInternalNoteLinks(noteContent));

const dialogTitle = $derived(
    createdUrl ? "Link ready" : showExistingPanel ? "Active share link" : "Share this note",
);

function formatTs(sec: number | null): string {
    if (!sec) return "Never";
    return formatDate(sec);
}

function existingLinkTypeLabel(row: ShareListEntry): string {
    if (row.max_views === 1) return "One-time";
    if (row.expires_at) return `Expires ${formatTs(row.expires_at)}`;
    return "Standard";
}

$effect(() => {
    if (!open) {
        createdUrl = null;
        linkType = "standard";
        usePassword = false;
        password = "";
        showSharePassword = false;
        includeAttachments = false;
        existingShare = null;
        replacing = false;
        return;
    }
    // On by default when the note has attachments — attachments are not behind a paid gate.
    includeAttachments = attachmentFileIds.length > 0;
    void getStorage()
        .then((s) => {
            maxShareTtlSec = s.max_share_ttl_sec ?? 0;
        })
        .catch(() => {
            maxShareTtlSec = 0;
        });
    void getActiveShareForNote(noteId)
        .then((row) => {
            existingShare = row;
            replacing = false;
        })
        .catch(() => {
            existingShare = null;
        });
});

async function handleCreate() {
    creating = true;
    try {
        let toRevoke = existingShare?.id ?? null;
        if (!toRevoke) {
            const row = await getActiveShareForNote(noteId).catch(() => null);
            toRevoke = row?.id ?? null;
        }
        if (toRevoke) {
            await revokeShare(toRevoke);
            existingShare = null;
        }
        const { fullUrl } = await createShareLink({
            sourceItemId: noteId,
            linkType,
            expiresInSec: linkType === "expiry" ? expiresInSec : undefined,
            password: usePassword ? password : undefined,
            includeAttachments: includeAttachments && canIncludeAttachments,
            attachmentFileIds: includeAttachments ? attachmentFileIds : undefined,
        });
        createdUrl = fullUrl;
        replacing = false;
        globalToasts.add({ message: "Share link created", variant: "success" });
    } catch (e) {
        const raw = e instanceof Error ? e.message : "Failed to create link";
        globalToasts.add({ message: formatShareError(raw), variant: "error" });
    } finally {
        creating = false;
    }
}

async function handleStopSharing() {
    if (!existingShare) return;
    revoking = true;
    try {
        await revokeShare(existingShare.id);
        globalToasts.add({ message: "Sharing stopped", variant: "success" });
        open = false;
    } catch (e) {
        const raw = e instanceof Error ? e.message : "Revoke failed";
        globalToasts.add({ message: formatShareError(raw), variant: "error" });
    } finally {
        revoking = false;
    }
}

async function copyText(text: string, label: string) {
    try {
        await navigator.clipboard.writeText(text);
        globalToasts.add({ message: `${label} copied`, variant: "success" });
    } catch {
        globalToasts.add({ message: "Copy failed", variant: "error" });
    }
}
</script>

{#if open}
    <Dialog title={dialogTitle} width="max-w-lg" onBackdropClick={() => (open = false)}>
        {#snippet children()}
            {#if createdUrl}
                <p class="text-sm text-[var(--text-muted)] break-all font-mono bg-[var(--surface-raised)]/50 rounded-lg p-3">
                    {createdUrl}
                </p>
                {#if usePassword}
                    <p class="text-xs text-[var(--text-muted)] mt-3">
                        Send the password separately — it is not included in the link.
                    </p>
                {/if}
            {:else if showExistingPanel && existingShare}
                <p class="text-sm text-[var(--text-muted)]">
                    This note already has an active share link.
                </p>

                <dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <dt class="text-[var(--text-muted)]">Type</dt>
                    <dd>{existingLinkTypeLabel(existingShare)}</dd>
                    <dt class="text-[var(--text-muted)]">Created</dt>
                    <dd>{formatTs(existingShare.created_at)}</dd>
                    <dt class="text-[var(--text-muted)]">Views</dt>
                    <dd>{existingShare.view_count}</dd>
                    {#if existingShare.needs_password}
                        <dt class="text-[var(--text-muted)]">Password</dt>
                        <dd>Required</dd>
                    {/if}
                    {#if existingShare.attachment_count > 0}
                        <dt class="text-[var(--text-muted)]">Attachments</dt>
                        <dd>{existingShare.attachment_count}</dd>
                    {/if}
                </dl>

                <p class="flex gap-2 text-xs text-[var(--text-muted)] mt-4 leading-relaxed">
                    <Info class="w-4 h-4 shrink-0 mt-0.5" />
                    The full link (with secret key) is shown only when you first create it. If you did
                    not save it, use Create new link. Stop sharing turns off the link without creating
                    a replacement.
                </p>
            {:else if showCreateForm}
                {#if internalLinkCount > 0}
                    <p class="flex gap-2 text-xs text-amber-600 dark:text-amber-400/90 mb-4 leading-relaxed">
                        <Info class="w-4 h-4 shrink-0 mt-0.5" />
                        This note links to {internalLinkCount} other
                        {internalLinkCount === 1 ? "note" : "notes"}. Recipients will see titles only —
                        links won't open.
                    </p>
                {/if}
                {#if replacing && existingShare}
                    <p class="text-sm text-[var(--text-muted)] mb-4">
                        This will revoke the current link and create a new one with a new secret key.
                    </p>
                {/if}

                <fieldset class="space-y-3 text-sm">
                    {#each shareTypeOptions as option}
                        <label
                            class={`flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors cursor-pointer ${
                                linkType === option.value
                                    ? "border-[var(--accent-color)] bg-[var(--accent-color)]/5"
                                    : "border-[var(--stroke)]"
                            }`}
                        >
                            <input
                                type="radio"
                                name="share-type"
                                value={option.value}
                                bind:group={linkType}
                                class="radio"
                            />
                            <span class="text-base leading-none" aria-hidden="true">{option.icon}</span>
                            <span class="flex-1 min-w-0">{option.label}</span>
                            {#if option.value === "expiry"}
                                <select
                                    class="input input-sm"
                                    bind:value={expiresInSec}
                                    disabled={linkType !== "expiry"}
                                >
                                    {#each ttlOptions as opt}
                                        <option value={opt.sec}>{opt.label}</option>
                                    {/each}
                                </select>
                            {/if}
                        </label>
                    {/each}
                </fieldset>

                <label class="flex items-center gap-2 mt-4 text-sm cursor-pointer">
                    <input type="checkbox" class="checkbox" bind:checked={usePassword} />
                    <span class="text-base leading-none" aria-hidden="true">🔏</span>
                    Also require a password
                </label>
                {#if usePassword}
                    <div class="relative mt-2">
                        <input
                            id="share-create-password"
                            type={showSharePassword ? "text" : "password"}
                            class="input w-full pr-10"
                            placeholder="Share password"
                            bind:value={password}
                            autocomplete="new-password"
                        />
                        <Toggle.Root
                            bind:pressed={showSharePassword}
                            aria-label={showSharePassword ? "Hide password" : "Show password"}
                            class="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent-color)]/50 transition-colors"
                        >
                            {#if showSharePassword}
                                <EyeOff class="w-4 h-4" />
                            {:else}
                                <Eye class="w-4 h-4" />
                            {/if}
                        </Toggle.Root>
                    </div>
                {/if}

                {#if attachmentFileIds.length > 0}
                    <label
                        class="flex items-center gap-2 mt-4 text-sm cursor-pointer"
                        title="Share encrypted files attached to this note"
                    >
                        <input type="checkbox" class="checkbox" bind:checked={includeAttachments} />
                        Include attachments
                        <span class="text-[var(--text-muted)]">({attachmentFileIds.length})</span>
                    </label>
                {/if}

                <p class="flex gap-2 text-xs text-[var(--text-muted)] mt-4 leading-relaxed">
                    <Info class="w-4 h-4 shrink-0 mt-0.5" />
                    Recipients always see the current version of this note. If you edit it, the
                    shared link shows the updated content. If you delete it, the link stops
                    working.
                </p>
            {/if}
        {/snippet}

        {#snippet footer()}
            <DialogActions>
                {#if createdUrl}
                    <Button variant="normal" onclick={() => (open = false)}>Done</Button>
                    <Button variant="primary" onclick={() => copyText(createdUrl!, "Link")}>
                        <Copy class="w-4 h-4" /> Copy link
                    </Button>
                {:else if showExistingPanel}
                    <Button variant="ghost" onclick={() => (open = false)}>Close</Button>
                    <Button
                        variant="ghost"
                        onclick={() => handleStopSharing()}
                        loading={revoking}
                        disabled={revoking}
                    >
                        <Trash2 class="w-4 h-4" /> Stop sharing
                    </Button>
                    <Button variant="primary" onclick={() => (replacing = true)}>Create new link</Button>
                {:else}
                    <Button
                        variant="ghost"
                        onclick={() => {
                            if (replacing && existingShare) replacing = false;
                            else open = false;
                        }}
                    >
                        {replacing && existingShare ? "Back" : "Cancel"}
                    </Button>
                    <Button
                        variant="primary"
                        onclick={handleCreate}
                        loading={creating}
                        disabled={creating || (usePassword && !password.trim())}
                    >
                        {replacing ? "Replace link" : "Create link"}
                    </Button>
                {/if}
            </DialogActions>
        {/snippet}
    </Dialog>
{/if}