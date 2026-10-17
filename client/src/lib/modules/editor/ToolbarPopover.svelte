<script lang="ts">
import type { Snippet } from "svelte";

type Props = {
    open: boolean;
    anchor: HTMLElement | null | undefined;
    align?: "left" | "right";
    onclose?: () => void;
    children: Snippet;
};

let { open, anchor, align = "left", onclose, children }: Props = $props();

let el: HTMLElement | undefined = $state();
let positioned = $state(false);
let top = $state(0);
let left = $state(0);

// Recompute is also called from the scroll/resize listeners, so it must not depend on $effect tracking.
function reposition(anchorEl: HTMLElement, popoverEl: HTMLElement) {
    const r = anchorEl.getBoundingClientRect();
    const w = popoverEl.offsetWidth;
    const h = popoverEl.offsetHeight;

    let t = r.bottom + 4;
    let l = align === "right" ? r.right - w : r.left;

    // When the left alignment does not fit, try the right of the anchor (and vice versa) before clamping to the viewport.
    if (align === "left" && l + w > window.innerWidth - 8) l = r.right - w;
    if (align === "right" && l < 8) l = r.left;

    if (l + w > window.innerWidth - 8) l = window.innerWidth - w - 8;
    if (l < 8) l = 8;
    if (t + h > window.innerHeight - 8) t = r.top - h - 4;
    if (t < 8) t = 8;

    top = t;
    left = l;
    positioned = true;
}

$effect(() => {
    if (!open || !anchor || !el) {
        positioned = false;
        return;
    }
    const anchorEl = anchor;
    const popoverEl = el;
    reposition(anchorEl, popoverEl);

    // `capture: true` catches a scroll on any ancestor (the note scroller, .tableWrapper), not only
    // the window — otherwise the popover is left hanging while the anchor scrolls away.
    const onScrollOrResize = () => {
        // The anchor has left the DOM (an undo, a sync merge, a deleted table) — close instead of
        // leaving the popover floating over nothing.
        if (!anchorEl.isConnected) {
            onclose?.();
            return;
        }
        reposition(anchorEl, popoverEl);
    };
    const onKeydown = (e: KeyboardEvent) => {
        if (e.key === "Escape") onclose?.();
    };

    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("keydown", onKeydown);
    return () => {
        window.removeEventListener("scroll", onScrollOrResize, true);
        window.removeEventListener("resize", onScrollOrResize);
        window.removeEventListener("keydown", onKeydown);
    };
});
</script>

{#if open}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        bind:this={el}
        class="fixed z-[200]"
        style="top: {top}px; left: {left}px; visibility: {positioned ? 'visible' : 'hidden'};"
        onpointerdown={(e) => e.stopPropagation()}
    >
        {@render children()}
    </div>
{/if}
