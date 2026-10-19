// The freeze session of a popover that must not move while the UI zoom changes under it.
//
// While the popover is open, its size and viewport position are frozen at their state at the moment
// it opened. The app zoom still changes the rest of the UI at once; the popover counter-scales (a
// transform) and stays pinned in viewport pixels, so + and − do not jump out from under the cursor.
// On close the freeze goes away; the next open takes the new, larger or smaller, size. Absolute
// positioning plus a parent reflow (the sidebar grows with the zoom) would otherwise move the whole
// popover even though the counter-scale holds the font.
import { uiZoomStore } from "$lib/core/stores/ui-zoom.svelte";

export class FrozenPopover {
    open = $state(false);
    /** The zoom factor at open (null = closed / no freeze). */
    frozenFactor = $state<number | null>(null);
    /** The viewport anchor at open, in pixels, or null when the popover falls back to flow layout. */
    pin = $state<{ left: number; bottom: number } | null>(null);

    // The reactive current scale — reading .current so the $derived follows the store.
    private currentFactor = $derived.by(() => {
        const _level = uiZoomStore.current;
        void _level;
        return uiZoomStore.factor;
    });

    /** 1 at open; when the user steps the zoom, the layout (in rem) grows or shrinks → the scale returns the visuals to the frozen state. */
    menuScale = $derived(
        this.frozenFactor != null && this.currentFactor > 0
            ? this.frozenFactor / this.currentFactor
            : 1,
    );

    /** The inline style that pins and counter-scales the open popover; undefined in flow layout. */
    style = $derived(
        this.pin
            ? `left: ${this.pin.left}px; bottom: ${this.pin.bottom}px; transform: scale(${this.menuScale}); transform-origin: bottom left;`
            : undefined,
    );

    close = (): void => {
        this.open = false;
        this.frozenFactor = null;
        this.pin = null;
    };

    /** Opens above `anchor` (the trigger), frozen at the current zoom; closes when already open. */
    toggle = (anchor: HTMLElement | null): void => {
        if (this.open) {
            this.close();
            return;
        }
        this.frozenFactor = uiZoomStore.factor;
        const rect = anchor?.getBoundingClientRect();
        if (rect) {
            const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
            const gap = 0.5 * rootPx; // Tailwind mb-2
            this.pin = { left: rect.left, bottom: window.innerHeight - rect.top + gap };
        } else {
            this.pin = null;
        }
        this.open = true;
    };
}
