<script lang="ts">
import { Download, Eye, EyeOff, Lock, Shield } from "lucide-svelte";
import { Toggle } from "bits-ui";
import type { NotePayload } from "@zknotes/shared";
import { viewProofB64FromFragmentKey } from "@zknotes/shared";
import type { ShareAttachmentWire } from "$lib/core/api/shares";
import { getShareMeta, viewShare } from "$lib/core/api/shares";
import Button from "$lib/core/ui/Button.svelte";
import LegalFooter from "$lib/core/ui/LegalFooter.svelte";
import { sanitizeShareHtml } from "$lib/core/utils/dompurify";
import { pageTitle } from "$lib/core/utils/page-title";
import {
    deriveSharePasswordKeysTask,
    unwrapAndDecryptShareTask,
} from "$lib/core/workers/crypto-rpc";
import {
    applyTablePropsFromAttr,
    applyTableWidthsFromAttr,
} from "$lib/modules/editor/extensions/table";
import { applyRowHeightsFromAttr } from "$lib/modules/editor/extensions/table-row";
import { hydrateShareNoteHtml } from "$lib/modules/share/share-content";
import { readShareFragmentKey, resolveSharePasswordKdf } from "$lib/modules/share/share-crypto";
import {
    downloadShareAttachment,
    saveShareAttachmentFile,
} from "$lib/modules/share/share-download";
import { tick, untrack } from "svelte";
import { page } from "$app/state";

type SharePageMeta =
    | { status: "loading" }
    | { status: "unavailable" }
    | {
          status: "ready";
          needsPassword: boolean;
          kdfSalt?: string | null;
          kdfParams?: import("@zknotes/shared").KdfParams;
          oneTime: boolean;
          hasAttachments: boolean;
      };

let meta = $state<SharePageMeta>({ status: "loading" });

let password = $state("");
let showSharePassword = $state(false);
let shareAuthKeyB64 = $state<string | undefined>();
let viewing = $state(false);
let note = $state<NotePayload | null>(null);
let renderedHtml = $state<string | null>(null);
let contentEl = $state<HTMLElement | undefined>();
let contentBlobUrls = $state<string[]>([]);
let attachments = $state<ShareAttachmentWire[]>([]);
let downloadOnlyAttachments = $state<ShareAttachmentWire[]>([]);
let attachmentNames = $state<Record<string, string>>({});
let downloadingId = $state<string | null>(null);
let errorMsg = $state<string | null>(null);
let burnGraceSec = $state<number | null>(null);
let passwordInput = $state<HTMLInputElement | undefined>();

const shareId = $derived(page.params.share_id ?? "");

$effect(() => {
    return () => {
        for (const url of contentBlobUrls) URL.revokeObjectURL(url);
    };
});

/** readonly prevents PM autofill; it has to be removed before a programmatic focus(). */
async function focusSharePasswordInput(): Promise<void> {
    await tick();
    const el = passwordInput;
    if (!el) return;
    el.removeAttribute("readonly");
    el.focus({ preventScroll: true });
}

function resetNoteViewState() {
    note = null;
    renderedHtml = null;
    burnGraceSec = null;
    for (const url of contentBlobUrls) URL.revokeObjectURL(url);
    contentBlobUrls = [];
    attachments = [];
    downloadOnlyAttachments = [];
    attachmentNames = {};
    shareAuthKeyB64 = undefined;
}

async function loadShareMeta(id: string): Promise<void> {
    try {
        const res = await getShareMeta(id);
        if ("status" in res && res.status === "unavailable") {
            meta = { status: "unavailable" };
            return;
        }
        const alive = res as Exclude<
            import("$lib/core/api/shares").ShareMetaResponse,
            { status: "unavailable" }
        >;
        meta = {
            status: "ready",
            needsPassword: alive.needs_password,
            kdfSalt: alive.share_kdf_salt,
            kdfParams: alive.share_kdf_params,
            oneTime: alive.max_views === 1,
            hasAttachments: Boolean(alive.has_attachments),
        };
    } catch {
        meta = { status: "unavailable" };
    }
}

$effect(() => {
    const id = shareId;
    // Re-run when the same /s/:id route is opened again (an Enter in the address bar, say).
    void page.url.href;
    if (!id) {
        meta = { status: "unavailable" };
        return;
    }

    let cancelled = false;
    meta = { status: "loading" };
    errorMsg = null;
    showSharePassword = false;
    untrack(() => resetNoteViewState());

    void loadShareMeta(id).then(() => {
        if (cancelled) return;
    });

    return () => {
        cancelled = true;
    };
});

/** BFCache / a reload: check the meta again if we are stuck on unavailable (an old wrong-password bug, say). */
$effect(() => {
    if (typeof window === "undefined") return;
    const handler = () => {
        if (shareId && meta.status === "unavailable") {
            errorMsg = null;
            void loadShareMeta(shareId);
        }
    };
    window.addEventListener("pageshow", handler);
    return () => window.removeEventListener("pageshow", handler);
});

/**
 * Table widths: `sanitizeShareHtml` strips `style`, so the percentage is reconstructed from
 * `data-user-width` once `{@html}` has already inserted the sanitised content.
 */
$effect(() => {
    void renderedHtml;
    void note;
    const el = contentEl;
    if (el) {
        applyTableWidthsFromAttr(el);
        applyRowHeightsFromAttr(el);
        applyTablePropsFromAttr(el);
    }
});

/** The password form: focus the field as soon as it appears, and again after a wrong password. */
$effect(() => {
    if (meta.status !== "ready" || !meta.needsPassword || note) return;
    if (!readShareFragmentKey()) return;
    void errorMsg;
    if (!passwordInput) return;
    void focusSharePasswordInput();
});

async function handleView() {
    if (meta.status !== "ready") return;
    const fragmentKey = readShareFragmentKey();
    if (!fragmentKey) {
        errorMsg = "Missing link key in URL fragment.";
        return;
    }

    viewing = true;
    errorMsg = null;
    const sharePwd = password.trim();
    const shareKdf = meta.needsPassword ? resolveSharePasswordKdf(meta) : null;
    try {
        if (meta.needsPassword) {
            if (!sharePwd) {
                errorMsg = "Enter the password.";
                return;
            }
            if (!shareKdf?.kdfSaltB64) {
                errorMsg = "This link is misconfigured. Ask the sender to create a new one.";
                return;
            }
            const derived = await deriveSharePasswordKeysTask({
                password: sharePwd,
                kdfSaltB64: shareKdf.kdfSaltB64,
                kdfParams: shareKdf.kdfParams,
            });
            shareAuthKeyB64 = derived.shareAuthKeyB64;
        }

        const fragmentKey = readShareFragmentKey();
        if (!fragmentKey) {
            errorMsg = "This link is incomplete (missing key). Ask the sender for the full URL.";
            return;
        }
        let viewProofB64: string;
        try {
            viewProofB64 = viewProofB64FromFragmentKey(fragmentKey);
        } catch {
            errorMsg = "This link is invalid. Ask the sender for a new one.";
            return;
        }

        const viewRes = await viewShare(shareId, {
            shareAuthKeyB64,
            viewProofB64,
        });
        if ("status" in viewRes && viewRes.status === "unavailable") {
            // Re-fetch the metadata — burnt or expired → the full dead state; still ready → a wrong password.
            if (meta.needsPassword) {
                shareAuthKeyB64 = undefined;
                try {
                    const again = await getShareMeta(shareId);
                    if ("status" in again && again.status === "unavailable") {
                        meta = { status: "unavailable" };
                        return;
                    }
                    // The metadata is still "ready" → the password is wrong (anti-enumeration: the server does not distinguish).
                    errorMsg = "Incorrect password. Try again.";
                    return;
                } catch {
                    meta = { status: "unavailable" };
                    return;
                }
            }
            meta = { status: "unavailable" };
            return;
        }
        const content = viewRes as Exclude<
            import("$lib/core/api/shares").ShareViewResponse,
            { status: "unavailable" }
        >;

        let payload: NotePayload;
        try {
            const decrypted = await unwrapAndDecryptShareTask<NotePayload>({
                shareId,
                sourceItemId: content.source_item_id,
                wrappedItemKey: Uint8Array.from(atob(content.wrapped_item_key), (c) =>
                    c.charCodeAt(0),
                ),
                itemKeyNonce: Uint8Array.from(atob(content.item_key_nonce), (c) => c.charCodeAt(0)),
                encryptedPayload: Uint8Array.from(atob(content.encrypted_payload), (c) =>
                    c.charCodeAt(0),
                ),
                payloadNonce: Uint8Array.from(atob(content.payload_nonce), (c) => c.charCodeAt(0)),
                fragmentKeyB64url: fragmentKey,
                password: meta.needsPassword ? sharePwd : undefined,
                kdfSaltB64: shareKdf?.kdfSaltB64,
                kdfParams: shareKdf?.kdfParams,
            });
            payload = decrypted.data;
        } catch {
            errorMsg = meta.needsPassword
                ? "Incorrect password or link key. Try again."
                : "Could not decrypt note. Check that the link is complete.";
            return;
        }

        note = payload;
        attachments = content.attachments ?? [];
        burnGraceSec = content.burn_download_grace_sec ?? null;

        const cryptoCtx = {
            shareId,
            fragmentKeyB64url: fragmentKey,
            password: meta.needsPassword ? sharePwd : undefined,
            kdfSaltB64: shareKdf?.kdfSaltB64,
            kdfParams: shareKdf?.kdfParams,
            shareAuthKeyB64,
        };
        for (const url of contentBlobUrls) URL.revokeObjectURL(url);
        const hydrated = await hydrateShareNoteHtml(payload.content ?? "", attachments, cryptoCtx);
        contentBlobUrls = hydrated.blobUrls;
        renderedHtml = hydrated.html;

        const inlined = new Set(hydrated.inlinedFileIds);
        downloadOnlyAttachments = attachments.filter((att) => !inlined.has(att.file_id));

        const names: Record<string, string> = {};
        for (const att of downloadOnlyAttachments) {
            try {
                const { data: filePayload } = await unwrapAndDecryptShareTask<{
                    kind?: string;
                    name?: string;
                }>({
                    shareId,
                    sourceItemId: att.file_id,
                    wrappedItemKey: Uint8Array.from(atob(att.wrapped_item_key), (c) =>
                        c.charCodeAt(0),
                    ),
                    itemKeyNonce: Uint8Array.from(atob(att.item_key_nonce), (c) => c.charCodeAt(0)),
                    encryptedPayload: Uint8Array.from(atob(att.encrypted_payload), (c) =>
                        c.charCodeAt(0),
                    ),
                    payloadNonce: Uint8Array.from(atob(att.payload_nonce), (c) => c.charCodeAt(0)),
                    fragmentKeyB64url: fragmentKey,
                    password: meta.needsPassword ? sharePwd : undefined,
                    kdfSaltB64: shareKdf?.kdfSaltB64,
                    kdfParams: shareKdf?.kdfParams,
                });
                names[att.file_id] = filePayload.name || "Attachment";
            } catch {
                names[att.file_id] = "Attachment";
            }
        }
        attachmentNames = names;
    } catch (e) {
        errorMsg = e instanceof Error ? e.message : "Could not load note";
    } finally {
        viewing = false;
    }
}

function handleContentClick(e: MouseEvent) {
    const chip = (e.target as HTMLElement).closest<HTMLElement>("[data-share-file-id]");
    if (!chip?.hasAttribute("data-share-download")) return;
    e.preventDefault();
    const fileId = chip.getAttribute("data-share-file-id");
    if (!fileId || downloadingId) return;
    const att = attachments.find((a) => a.file_id === fileId);
    if (att) void handleDownloadAttachment(att);
}

async function handleDownloadAttachment(att: ShareAttachmentWire) {
    if (meta.status !== "ready") return;
    const fragmentKey = readShareFragmentKey();
    if (!fragmentKey) return;

    downloadingId = att.file_id;
    errorMsg = null;
    try {
        const result = await downloadShareAttachment({
            shareId,
            attachment: att,
            fragmentKeyB64url: fragmentKey,
            password: meta.needsPassword ? password.trim() : undefined,
            kdfSaltB64: resolveSharePasswordKdf(meta).kdfSaltB64,
            kdfParams: resolveSharePasswordKdf(meta).kdfParams,
            shareAuthKeyB64,
        });
        saveShareAttachmentFile(result.bytes, result.name, result.mime);
    } catch (e) {
        errorMsg = e instanceof Error ? e.message : "Download failed";
    } finally {
        downloadingId = null;
    }
}
</script>

<svelte:head>
    <title>{pageTitle("Shared note — ZKnotes")}</title>
    <meta name="robots" content="noindex" />
    <!-- The proxy sends the same policy (docker/Caddyfile); this holds behind any other proxy too. -->
    <meta name="referrer" content="no-referrer" />
    <meta name="description" content="Encrypted note shared via ZKnotes" />
</svelte:head>

<div class="min-h-screen bg-[var(--surface-app)] text-[var(--text)]">
    <header class="border-b border-[var(--stroke)] px-4 py-4 flex items-center gap-2">
        <Shield class="w-5 h-5 text-[var(--accent-color)]" />
        <span class="font-semibold">ZKnotes</span>
        <span class="text-[var(--text-muted)] text-sm">· shared link</span>
    </header>

    <main class="max-w-3xl mx-auto px-4 py-10">
        {#if meta.status === "loading"}
            <p class="text-[var(--text-muted)]">Loading…</p>
        {:else if meta.status === "unavailable"}
            <h1 class="text-2xl font-bold">Link is no longer available</h1>
            <p class="text-[var(--text-muted)] mt-2 text-sm">
                It may have expired, been revoked, or the source note was deleted.
            </p>
            {#if errorMsg}
                <p class="text-[var(--danger)] text-sm mt-4">{errorMsg}</p>
            {/if}
        {:else if !note}
            {#if meta.oneTime}
                <div class="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm mb-6">
                    This link will stop working after you view it. If the page fails to load, the
                    content may be lost.
                </div>
            {/if}

            {#if !readShareFragmentKey()}
                <p class="text-[var(--danger)] text-sm">Missing link key in URL fragment.</p>
            {:else}
                <form
                    autocomplete="off"
                    class="max-w-sm"
                    onsubmit={(e) => {
                        e.preventDefault();
                        if (!viewing) void handleView();
                    }}
                >
                    {#if meta.needsPassword}
                        <label class="block text-sm font-medium mb-2" for="share-password">
                            <Lock class="w-4 h-4 inline mr-1" /> Password
                        </label>
                        <div class="relative mb-4">
                            <input
                                id="share-password"
                                bind:this={passwordInput}
                                name="share-view-password"
                                type={showSharePassword ? "text" : "password"}
                                class="input w-full pr-10"
                                bind:value={password}
                                autocomplete="one-time-code"
                                autocapitalize="off"
                                autocorrect="off"
                                spellcheck={false}
                                readonly
                                data-lpignore="true"
                                data-1p-ignore
                                data-bwignore
                                onfocus={(e) => e.currentTarget.removeAttribute("readonly")}
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
                    <Button
                        variant="primary"
                        size="lg"
                        type="submit"
                        loading={viewing}
                        disabled={viewing}
                    >
                        <Eye class="w-5 h-5" /> View note
                    </Button>
                    {#if errorMsg}
                        <p class="text-[var(--danger)] text-sm mt-3">{errorMsg}</p>
                    {/if}
                </form>
            {/if}
        {:else}
            {#if burnGraceSec != null && attachments.length > 0}
                <div class="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm mb-6">
                    This one-time link has now been used. Attachments stay downloadable for about
                    {Math.round(burnGraceSec / 60)} more minutes — save what you need now.
                </div>
            {/if}
            <h1 class="text-3xl font-bold mb-6">{note.title || "Untitled"}</h1>
            <!-- eslint-disable-next-line svelte/no-at-html-tags — sanitizeShareHtml (stricter: no remote img or style) -->
            <article
                bind:this={contentEl}
                class="prose prose-invert max-w-none share-note-content"
                onclick={handleContentClick}
            >
                <!-- eslint-disable-next-line svelte/no-at-html-tags — sanitizeShareHtml -->
                {@html sanitizeShareHtml(renderedHtml ?? note.content ?? "")}
            </article>

            {#if downloadOnlyAttachments.length > 0}
                <section class="mt-10 border-t border-[var(--stroke)] pt-6">
                    <h2 class="text-lg font-semibold mb-3">Attachments</h2>
                    <ul class="space-y-2">
                        {#each downloadOnlyAttachments as att (att.file_id)}
                            <li class="flex items-center justify-between gap-3 rounded-xl border border-[var(--stroke)] px-4 py-3">
                                <span class="text-sm truncate">
                                    {attachmentNames[att.file_id] ?? "Attachment"}
                                </span>
                                <Button
                                    variant="normal"
                                    size="sm"
                                    loading={downloadingId === att.file_id}
                                    disabled={downloadingId !== null}
                                    onclick={() => handleDownloadAttachment(att)}
                                >
                                    <Download class="w-4 h-4" /> Download
                                </Button>
                            </li>
                        {/each}
                    </ul>
                </section>
            {/if}

            {#if errorMsg}
                <p class="text-[var(--danger)] text-sm mt-4">{errorMsg}</p>
            {/if}
        {/if}
    </main>
    <LegalFooter class="border-t border-[var(--stroke)] px-4 py-4 text-center" />
</div>

<style>
    /*
     * The note body is sharer-controlled HTML and the sanitiser keeps `class`, so every utility in
     * the app's Tailwind build (`fixed inset-0 z-50`, say) is available to it. Paint containment
     * makes the article the containing block for fixed- and absolute-positioned descendants, clips
     * them to its box and gives it its own stacking context, so nothing in a shared note can be
     * drawn outside the note — not over the page header, the footer or the rest of the page.
     * `position: relative` and `isolation: isolate` keep absolute positioning and z-index inside
     * the article even in a browser without `contain`.
     */
    :global(.share-note-content) {
        contain: paint;
        position: relative;
        isolation: isolate;
        /* Paint containment clips what overflows sideways (a wide table, a long URL): scroll it. */
        overflow-x: auto;
    }
    :global(.share-note-content .share-file-chip[data-share-download]) {
        cursor: pointer;
    }
    :global(.share-note-content .share-file-chip.is-downloading) {
        opacity: 0.6;
        pointer-events: none;
    }
    :global(.share-note-content img) {
        max-width: 100%;
        height: auto;
        border-radius: 0.5rem;
        /* Honour the width from the note's HTML (an encFile resize); with no width, the natural size up to max-width. */
        width: auto;
    }
    :global(.share-note-content .share-note-ref) {
        color: var(--muted-foreground);
        cursor: default;
        text-decoration: none;
        border-bottom: 1px dotted color-mix(in srgb, var(--muted-foreground) 55%, transparent);
    }
</style>