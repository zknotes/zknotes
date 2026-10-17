<script lang="ts">
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { X } from "lucide-svelte";
import Button from "$lib/core/ui/Button.svelte";
import { OUTLINE_MAX_HEADING_LEVEL, outlineStore } from "$lib/core/stores/outline.svelte";

interface OutlineHeading {
    level: number;
    text: string;
    pos: number;
    /** The depth in the tree (0 = the top), not the absolute H level — H1→H3 gives depth 1, not 2. */
    depth: number;
}

const INDENT_PX = 14;

let { editor, scrollEl }: { editor: Editor; scrollEl: HTMLElement | undefined } = $props();

let headings = $state<OutlineHeading[]>([]);
let activeIndex = $state(0);
let spySuppressedUntil = 0;

const MAX_LEVEL = OUTLINE_MAX_HEADING_LEVEL;
const SPY_OFFSET = 80; // px below the top of the scroll area that counts as the "current" heading
const SPY_SUPPRESS_MS = 800; // for as long as the smooth scroll from an outline click lasts

function computeActiveIndex(el: HTMLElement): number {
    if (headings.length === 0) return 0;
    // The last heading: pin it only when the scroll is at the bottom and that heading is above the threshold.
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
        const threshold = el.getBoundingClientRect().top + SPY_OFFSET;
        const last = headings[headings.length - 1];
        const lastDom = last ? (editor.view.nodeDOM(last.pos) as HTMLElement | null) : null;
        if (lastDom && lastDom.getBoundingClientRect().top <= threshold) {
            return headings.length - 1;
        }
    }
    if (el.scrollTop <= 2) return 0;

    const threshold = el.getBoundingClientRect().top + SPY_OFFSET;
    let idx = 0;
    for (let i = 0; i < headings.length; i++) {
        const h = headings[i];
        if (!h) continue;
        const dom = editor.view.nodeDOM(h.pos) as HTMLElement | null;
        if (!dom) continue;
        if (dom.getBoundingClientRect().top <= threshold) idx = i;
        else break;
    }
    return idx;
}

// One place of truth: read the headings straight out of the TipTap doc, never a mirror.
function rebuild() {
    const list: OutlineHeading[] = [];
    const levelStack: number[] = [];
    editor.state.doc.descendants((node, pos) => {
        if (node.type.name === "heading" && (node.attrs.level as number) <= MAX_LEVEL) {
            const level = node.attrs.level as number;
            while (levelStack.length > 0 && levelStack[levelStack.length - 1]! >= level) {
                levelStack.pop();
            }
            list.push({
                level,
                text: node.textContent,
                pos,
                depth: levelStack.length,
            });
            levelStack.push(level);
        }
        return true;
    });
    headings = list;
}

// Rebuild once on mount and on every change to the doc (coalesced into one rAF).
$effect(() => {
    let raf = 0;
    const onUpdate = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(rebuild);
    };
    editor.on("update", onUpdate);
    rebuild();
    return () => {
        cancelAnimationFrame(raf);
        editor.off("update", onUpdate);
    };
});

// Scroll-spy: the active heading is the last one whose top has crossed the offset line.
$effect(() => {
    const el = scrollEl;
    if (!el) return;
    let raf = 0;
    const recompute = () => {
        if (performance.now() < spySuppressedUntil) return;
        activeIndex = computeActiveIndex(el);
    };
    const onScroll = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(recompute);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    recompute();
    return () => {
        cancelAnimationFrame(raf);
        el.removeEventListener("scroll", onScroll);
    };
});

function goTo(h: OutlineHeading, index: number) {
    const { state, view } = editor;
    const dom = view.nodeDOM(h.pos) as HTMLElement | null;
    const pos = Math.min(h.pos + 1, state.doc.content.size);
    activeIndex = index;
    spySuppressedUntil = performance.now() + SPY_SUPPRESS_MS;
    // Dispatch without scrollIntoView, so it does not fight the smooth scroll below.
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos)));
    view.focus();
    dom?.scrollIntoView({ behavior: "smooth", block: "start" });
    const el = scrollEl;
    if (el) {
        const onScrollEnd = () => {
            spySuppressedUntil = 0;
            activeIndex = computeActiveIndex(el);
        };
        el.addEventListener("scrollend", onScrollEnd, { once: true });
    }
    // On mobile the outline is an overlay drawer — close it once a heading is chosen.
    // Transient: a navigational convenience, not a per-note "hide outline" choice.
    if (window.matchMedia("(max-width: 767px)").matches) outlineStore.setVisibleTransient(false);
}

// Drag the right edge to resize, mirroring the main sidebar. The panel is not at the viewport edge, so
// the width is measured from its own left edge rather than straight from clientX.
let asideEl = $state<HTMLElement | undefined>(undefined);
let resizing = $state(false);

function startResize(e: MouseEvent) {
    e.preventDefault();
    const left = asideEl?.getBoundingClientRect().left ?? 0;
    resizing = true;
    document.body.style.cursor = "col-resize";

    const onMove = (ev: MouseEvent) => outlineStore.setWidth(ev.clientX - left);
    const onUp = () => {
        resizing = false;
        document.body.style.cursor = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
}
</script>

{#if outlineStore.visible}
    <!-- The backdrop is mobile-only: the panel below is an overlay drawer under md (scoped to the
         editor area, below the toolbar). -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <Button
        variant="ghost"
        aria-label="Close outline"
        onclick={() => outlineStore.hide()}
        class="absolute inset-0 z-30 bg-black/50 md:hidden !w-full !h-full !min-h-0 !p-0 !rounded-none"
    ></Button>
    <aside
        data-testid="outline-panel"
        bind:this={asideEl}
        style="width: {outlineStore.width}px"
        class="flex shrink-0 flex-col border-r border-[var(--stroke)] bg-[var(--surface-panel)]
               absolute inset-y-0 left-0 z-40 shadow-2xl
               md:relative md:inset-auto md:z-auto md:bg-[var(--surface-app)] md:shadow-none"
    >
        <div class="flex-1 overflow-y-auto px-2 py-4">
            <div class="flex items-center justify-between px-2 pb-2">
                <span class="font-mono text-2xs uppercase tracking-wider text-[var(--text-dim)]">
                    Outline
                </span>
                <Button
                    variant="ghost"
                    size="icon"
                    onclick={() => outlineStore.hide()}
                    title="Hide outline"
                    class="!w-auto !h-auto !p-0.5"
                >
                    <X class="h-3 w-3" />
                </Button>
            </div>
            {#if headings.length === 0}
                <p class="px-2 text-xs italic text-[var(--text-dim)]">
                    No headings yet — add H1–H4 to build the outline.
                </p>
            {:else}
                <nav class="flex flex-col gap-0.5">
                    {#each headings as h, i (h.pos)}
                        <div style="padding-left: {h.depth * INDENT_PX}px">
                            <Button
                                variant="ghost"
                                active={i === activeIndex}
                                onclick={() => goTo(h, i)}
                                title={h.text || "(empty)"}
                                class="w-full justify-start truncate !h-auto !px-2 !py-1 text-left
                                    {h.level === 1
                                    ? 'text-xs font-medium'
                                    : h.level === 2
                                      ? 'text-xs'
                                      : 'text-xs'}"
                            >
                                {h.text || "(empty)"}
                            </Button>
                        </div>
                    {/each}
                </nav>
            {/if}
        </div>
        <!-- The resize handle (the right edge) — it reuses .sidebar-resizer so the visible line stays
             1px while ::after gives a ~7px grab zone, identical to the notes sidebar. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
            class="absolute top-0 right-0 z-20 hidden h-full w-px cursor-col-resize sidebar-resizer md:block"
            class:dragging={resizing}
            onmousedown={startResize}
        ></div>
    </aside>
{/if}
