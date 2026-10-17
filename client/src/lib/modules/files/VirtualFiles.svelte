<script lang="ts">
// The windowed grid/list for the file manager. It owns its own scroll container and renders only
// the rows that intersect the viewport (+overscan), so 500+ files stay smooth. Because off-screen
// cards really are unmounted, their FileThumb releases its blob-cache ref on scroll-out — which
// keeps the cache's ref-count + LRU honest (only roughly the visible previews are ever decrypted or
// held).
//
// Uniform row heights make the arithmetic trivial: every grid cell is GRID_CARD_H tall (with a
// GRID_GAP gap) and every list row is LIST_ROW_H tall. No per-item measurement is needed.

import { FolderClosed, Shield, Cloud, CloudDownload, MoreHorizontal } from "lucide-svelte";
import type { DecryptedItemMeta } from "$lib/core/data/items";
import { fileIcon, humanSize, relativeTime } from "$lib/core/utils/format";
import { pinManager } from "$lib/core/files/pin-manager-state.svelte";
import Button from "$lib/core/ui/Button.svelte";
import { Checkbox, ItemTitle, MetaText } from "$lib/core/ui";
import FilePresenceBadge from "./FilePresenceBadge.svelte";
import FileThumb from "./FileThumb.svelte";

export type VirtualItem =
    | (DecryptedItemMeta & { fullPath?: string })
    | { isGroupHeader: true; id: string; title: string };

interface Props {
    files: VirtualItem[];
    mode: "grid" | "list";
    onSelect: (f: DecryptedItemMeta) => void;
    selectedIds: Set<string>;
    onToggle: (id: string) => void;
}
const { files, mode, onSelect, selectedIds, onToggle }: Props = $props();

const GRID_CARD_H = 144;
const GRID_GAP = 12;
const GRID_STRIDE = $derived(GRID_CARD_H + GRID_GAP);
const LIST_ROW_H = 56;
const OVERSCAN_ROWS = 4;

let viewport = $state<HTMLElement | null>(null);
let content = $state<HTMLElement | null>(null);
let scrollTop = $state(0);
let viewportH = $state(0);
let contentW = $state(0);

let showContextMenu = $state(false);
let contextMenuPos = $state({ x: 0, y: 0, startX: 0, startY: 0 });
let contextMenuFile = $state<DecryptedItemMeta | null>(null);
let menuWidth = $state(200);
let menuHeight = $state(100);

function handleContextMenu(e: MouseEvent, f: VirtualItem) {
    if ("isGroupHeader" in f) return;
    document.body.click();
    e.preventDefault();
    e.stopPropagation();
    contextMenuPos = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY };
    contextMenuFile = f as DecryptedItemMeta;
    showContextMenu = true;
}

function portalAction(element: HTMLElement) {
    document.body.appendChild(element);
    return {
        destroy() {
            if (element.parentNode) {
                element.parentNode.removeChild(element);
            }
        },
    };
}

$effect(() => {
    if (showContextMenu) {
        let x = contextMenuPos.startX;
        let y = contextMenuPos.startY;
        if (y + menuHeight > window.innerHeight)
            y = Math.max(10, window.innerHeight - menuHeight - 10);
        if (x + menuWidth > window.innerWidth) x = Math.max(10, window.innerWidth - menuWidth - 10);
        if (contextMenuPos.x !== x || contextMenuPos.y !== y) {
            contextMenuPos.x = x;
            contextMenuPos.y = y;
        }
    }
});

$effect(() => {
    const vp = viewport;
    const ct = content;
    if (!vp || !ct) return;

    const measure = () => {
        viewportH = vp.clientHeight;
        contentW = ct.clientWidth;
    };
    const onScroll = () => {
        scrollTop = vp.scrollTop;
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(vp);
    ro.observe(ct);
    vp.addEventListener("scroll", onScroll, { passive: true });
    return () => {
        ro.disconnect();
        vp.removeEventListener("scroll", onScroll);
    };
});

const cols = $derived(mode === "list" ? 1 : contentW >= 940 ? 4 : contentW >= 600 ? 3 : 2);
const stride = $derived(mode === "list" ? LIST_ROW_H : GRID_STRIDE);
const rowCount = $derived(Math.ceil(files.length / cols));
const totalHeight = $derived(Math.max(0, rowCount * stride - (mode === "list" ? 0 : GRID_GAP)));

const startRow = $derived(Math.max(0, Math.floor(scrollTop / stride) - OVERSCAN_ROWS));
const endRow = $derived(
    Math.min(rowCount, Math.ceil((scrollTop + viewportH) / stride) + OVERSCAN_ROWS),
);
const offsetY = $derived(startRow * stride);
const visible = $derived(files.slice(startRow * cols, endRow * cols));
</script>

<svelte:window onclick={() => showContextMenu = false} />

<!-- List mode: allow horizontal scroll on narrow screens instead of crushing columns.
     Grid stays fluid. Virtualization still needs fixed row heights (no multi-line name wrap). -->
<div bind:this={viewport} class="h-full overflow-auto">
    <div bind:this={content} class="max-w-6xl mx-auto px-3 sm:px-8 pb-10 pt-2">
        <div
            style="height: {totalHeight}px; position: relative;"
            class={mode === "list" ? "min-w-[36rem]" : undefined}
        >
            <div style="position: absolute; inset: 0; transform: translateY({offsetY}px);">
                {#if mode === "grid"}
                    <div class="grid gap-3" style="grid-template-columns: repeat({cols}, minmax(0, 1fr));">
                        {#each visible as f (f.id)}
                            {#if !('isGroupHeader' in f)}
                                {@const Icon = fileIcon(f.mime)}
                                {@const checked = selectedIds.has(f.id)}
                                <div
                                    role="button"
                                    tabindex="0"
                                    onclick={() => onToggle(f.id)}
                                    oncontextmenu={(e) => handleContextMenu(e, f)}
                                    onkeydown={(e) => e.key === "Enter" && onToggle(f.id)}
                                    style="height: {GRID_CARD_H}px;"
                                    class="group relative text-left bg-[var(--surface-panel)]/60 border rounded-lg p-3 sm:p-4 hover:border-[var(--stroke)] transition flex flex-col cursor-pointer select-none overflow-hidden min-w-0 {checked ? 'border-brand0/60 ring-1 ring-brand0/30 bg-brand/20' : 'border-[var(--stroke)]'}"
                                >
                                    <div class="flex items-start gap-2 mb-3">
                                        <button 
                                            class="text-left rounded overflow-hidden" 
                                            title="View details"
                                            onclick={(e) => { e.stopPropagation(); onSelect(f); }}
                                        >
                                            <FileThumb fileId={f.id} mime={f.mime} icon={Icon} updatedAt={f.updated_at} />
                                        </button>
                                        <div class="ml-auto flex items-center justify-center p-1">
                                            <Checkbox {checked} onCheckedChange={() => onToggle(f.id)} />
                                        </div>
                                    </div>
                                    <button 
                                        class="text-left hover:underline mb-1 min-w-0 max-w-full"
                                        title="View details"
                                        onclick={(e) => { e.stopPropagation(); onSelect(f); }}
                                    >
                                        <ItemTitle weight="semibold" class="leading-normal pb-[1px] text-[var(--text)] block">{f.title}</ItemTitle>
                                    </button>
                                    {#if f.fullPath}
                                        <MetaText as="div" class="!text-2xs truncate flex items-center gap-1 min-w-0" title={f.fullPath}>
                                            <FolderClosed class="w-[0.625rem] h-[0.625rem] flex-shrink-0" /> {f.fullPath}
                                        </MetaText>
                                    {:else if f.description}
                                        <MetaText as="div" class="truncate italic min-w-0">{f.description}</MetaText>
                                    {/if}

                                    <MetaText as="div" class="mt-auto pt-3 border-t border-[var(--stroke)] flex items-center justify-between gap-1 font-mono min-w-0">
                                        <span class="truncate">{humanSize(f.size)}</span>
                                        <FilePresenceBadge fileId={f.id} />
                                        <span class="truncate shrink-0">{relativeTime(f.updated_at)}</span>
                                    </MetaText>
                                </div>
                            {/if}
                        {/each}
                    </div>
                {:else}
                    <div class="rounded-lg border border-[var(--stroke)] overflow-hidden w-full">
                        {#each visible as f (f.id)}
                            {#if 'isGroupHeader' in f}
                                <div
                                    style="height: {LIST_ROW_H}px;"
                                    class="flex items-end px-3 pb-2 text-xs font-mono text-[var(--text-muted)] bg-[var(--surface-panel)] uppercase tracking-widest w-full border-b border-[var(--stroke)] last:border-b-0"
                                >
                                    {f.title}
                                </div>
                            {:else}
                                {@const Icon = fileIcon(f.mime)}
                                {@const checked = selectedIds.has(f.id)}
                                <div
                                    role="button"
                                    tabindex="0"
                                    onclick={() => onToggle(f.id)}
                                    oncontextmenu={(e) => handleContextMenu(e, f)}
                                    onkeydown={(e) => e.key === "Enter" && onToggle(f.id)}
                                    style="height: {LIST_ROW_H}px;"
                                    class="group flex items-center gap-3 px-3 border-b border-[var(--stroke)]/60 last:border-b-0 text-left hover:bg-[var(--surface-panel)]/50 transition w-full cursor-pointer select-none {checked ? 'bg-brand/20' : ''}"
                                >
                                    <Checkbox {checked} onCheckedChange={() => onToggle(f.id)} class="flex-shrink-0" />
                                    <button
                                        class="flex items-center gap-3 min-w-[12rem] flex-1 overflow-hidden text-left"
                                        title="View details"
                                        onclick={(e) => {
                                            e.stopPropagation();
                                            onSelect(f);
                                        }}
                                    >
                                        <FileThumb fileId={f.id} mime={f.mime} icon={Icon} updatedAt={f.updated_at} />
                                        <div class="min-w-0 flex-1 overflow-hidden">
                                            <ItemTitle
                                                as="div"
                                                weight="semibold"
                                                class="hover:underline leading-normal pb-[1px] text-[var(--text)]"
                                            >
                                                {f.title}
                                            </ItemTitle>
                                            {#if f.fullPath}
                                                <MetaText
                                                    as="div"
                                                    class="!text-2xs truncate mt-0.5 flex items-center gap-1"
                                                    title={f.fullPath}
                                                >
                                                    <FolderClosed class="w-[0.625rem] h-[0.625rem] flex-shrink-0" /> {f.fullPath}
                                                </MetaText>
                                            {:else if f.description}
                                                <MetaText as="div" class="truncate italic mt-0.5">{f.description}</MetaText>
                                            {/if}
                                        </div>
                                    </button>
                                    <MetaText as="div" class="font-mono flex items-center gap-3 flex-shrink-0">
                                        <span class="tabular-nums w-16 text-right">{humanSize(f.size)}</span>
                                        <FilePresenceBadge fileId={f.id} />
                                        <span class="w-14 text-right">{relativeTime(f.updated_at)}</span>
                                        <span class="text-brand-fg/70"><Shield class="w-[0.6875rem] h-[0.6875rem]" /></span>
                                    </MetaText>
                                </div>
                            {/if}
                        {/each}
                    </div>
                {/if}
            </div>
        </div>
    </div>
</div>

{#if showContextMenu && contextMenuFile}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        use:portalAction
        bind:clientWidth={menuWidth}
        bind:clientHeight={menuHeight}
        class="ctx-menu fixed"
        style="top: {contextMenuPos.y}px; left: {contextMenuPos.x}px; z-index: 200;"
        onclick={(e) => e.stopPropagation()}
    >
        <div class="px-2.5 pt-1.5 pb-1">
            <div class="text-xs leading-normal pb-[1px] font-semibold text-[var(--text)] truncate">{contextMenuFile.title}</div>
        </div>
        <div class="ctx-divider"></div>

        <!-- UX-DEBT: a raw <button> in the ctx menu — it should go through MenuItem. -->
        {#if pinManager.isPinned(contextMenuFile.id)}
            <button class="ctx-item" onclick={() => { showContextMenu = false; pinManager.unpinItem(contextMenuFile!.id); }}>
                <Cloud class="w-[0.8125rem] h-[0.8125rem] shrink-0 text-[var(--text-muted)]" /><span>Remove from device</span>
            </button>
        {:else}
            <button class="ctx-item" onclick={() => { showContextMenu = false; pinManager.pinItem(contextMenuFile!.id); }}>
                <CloudDownload class="w-[0.8125rem] h-[0.8125rem] shrink-0 text-[var(--text-muted)]" /><span>Keep on this device</span>
            </button>
        {/if}
    </div>
{/if}
