<script lang="ts">
// A lazy, cache-backed thumbnail for a file card. It decrypts only once the card enters
// the viewport (IntersectionObserver), pulls a shared blob: URL from the central cache and
// releases its ref on unmount. Non-image files (or images that do not sniff as a raster) fall back
// to an icon. It decrypts again when `updatedAt` changes (a Replace invalidated the cache entry).
// For `large=true`: when the policy blocks the auto-download, it shows a placeholder with a "Download" button.
import { Download } from "lucide-svelte";
import Button from "$lib/core/ui/Button.svelte";
import type { LucideIcon } from "$lib/core/types/icons";
import { FileNotLocalError } from "./download";
import { isRasterImageMime } from "./sniff";

interface Props {
    fileId: string;
    mime?: string;
    /** The Lucide icon shown while no raster preview is available. */
    icon: LucideIcon;
    /** Bumped by a Replace; it forces a re-acquire of fresh bytes. */
    updatedAt: number;
    /** When true, it fills the parent container instead of a fixed w-7 h-7. */
    large?: boolean;
}
const { fileId, mime, icon: Icon, updatedAt, large = false }: Props = $props();

let url = $state<string | null>(null);
let root = $state<HTMLElement | null>(null);
let acquired = false; // whether we currently hold a cache ref
let inView = $state(false);
let reloadNonce = $state(0); // bumped to re-acquire after the cached URL is LRU-evicted
let errorCount = $state(0); // prevents an infinite loop on unsupported formats
// The auto-download is blocked (the policy is never, or too large) — show a Download button.
let needsDownload = $state(false);
let downloading = $state(false);

const isImage = $derived(isRasterImageMime(mime));

$effect(() => {
    const el = root;
    if (!el || !isImage) return;
    const obs = new IntersectionObserver(
        (entries) => {
            for (const e of entries) if (e.isIntersecting) inView = true;
        },
        { rootMargin: "200px" }, // start decrypting slightly before it scrolls into view
    );
    obs.observe(el);
    return () => obs.disconnect();
});

function releaseRef() {
    if (acquired) {
        if (large) {
            void import("./blob-cache").then((m) => m.release(fileId));
        } else {
            void import("./blob-cache").then((m) => m.releaseThumbnail(fileId));
        }
        acquired = false;
    }
    url = null;
}

// Load — and reload on a Replace — once it is in view. Keyed on fileId plus updatedAt.
// Grid cards (large=false) use acquireThumbnail — a fast payload-only decrypt with no chunk download.
// Detail-panel cards (large=true) use acquire — the full-resolution image out of every chunk.
$effect(() => {
    fileId;
    updatedAt;
    reloadNonce;
    if (!isImage || !inView) return;

    needsDownload = false;
    let cancelled = false;
    (async () => {
        const cache = await import("./blob-cache");
        try {
            const { url: u, render } = large
                ? await cache.acquire(fileId)
                : await cache.acquireThumbnail(fileId);
            if (cancelled) {
                large ? cache.release(fileId) : cache.releaseThumbnail(fileId);
                return;
            }
            acquired = true;
            url = render === "raster" ? u : null;
            if (render !== "raster") releaseRef(); // download-only: nothing to show, so drop the ref
        } catch (e) {
            if (cancelled) return;
            if (large && e instanceof FileNotLocalError) {
                // The policy forbids an auto-download → show the Download button.
                needsDownload = true;
            } else {
                url = null;
            }
        }
    })();

    return () => {
        cancelled = true;
        releaseRef();
    };
});

async function handleExplicitDownload() {
    downloading = true;
    needsDownload = false;
    try {
        const cache = await import("./blob-cache");
        const { url: u, render } = await cache.acquire(fileId, { force: true });
        acquired = true;
        url = render === "raster" ? u : null;
        if (render !== "raster") releaseRef();
    } catch {
        url = null;
    } finally {
        downloading = false;
    }
}
</script>

<div bind:this={root} class="{large ? 'w-full h-full' : 'w-7 h-7 rounded-md flex-shrink-0'} bg-[var(--surface-raised)] flex items-center justify-center text-[var(--text-muted)] overflow-hidden">
    {#if url}
        <img
            src={url}
            alt=""
            class="w-full h-full object-cover"
            onerror={() => {
                // Failing several times usually means an unsupported format (HEIC on Chrome, say).
                  // Stop retrying and drop the URL so it falls back to the icon.
                if (errorCount > 0) {
                    url = null;
                    return;
                }
                errorCount++;
                // Otherwise the URL may have been LRU-evicted from under us → drop the ref and re-acquire.
                releaseRef();
                reloadNonce++;
            }}
        />
    {:else if needsDownload && large}
        <!-- The policy blocks the auto-download: show a Download button (in large mode only). -->
        <Button
            variant="ghost"
            onclick={handleExplicitDownload}
            disabled={downloading}
            loading={downloading}
            class="flex-col !h-auto gap-2 p-4"
            data-testid="file-download-placeholder"
            title="Download to view"
        >
            <Download class="w-6 h-6" />
            <span class="text-xs font-medium">Download to view</span>
        </Button>
    {:else}
        <Icon class={large ? 'w-7 h-7' : 'w-[0.875rem] h-[0.875rem]'} />
    {/if}
</div>
