<script lang="ts">
import type { Snippet } from "svelte";
import { Dialog } from "bits-ui";

interface Props {
    title: string;
    children: Snippet;
    footer: Snippet;
    width?: string;
    onBackdropClick?: () => void;
    resizable?: boolean;
    /** The body's max height (the standard variant); the footer stays visible and the content scrolls. */
    contentMaxHeight?: string;
}
const {
    title,
    children,
    footer,
    width = "max-w-sm",
    onBackdropClick,
    resizable = false,
    contentMaxHeight,
}: Props = $props();
</script>

<!-- svelte:window has to be at the top level, not inside an {#if} block -->
<svelte:window onkeydown={(e) => { if (resizable && e.key === "Escape") onBackdropClick?.(); }} />

{#if resizable}
    <!--
        The resizable variant: a custom overlay + div instead of the bits-ui Dialog.
        bits-ui's DismissibleLayer listens for focusin on the document — a CSS resize moves the focus
        outside the dialog → bits-ui closes it. The overlay and the content are separate elements, so a
        mouseup on the resize handle never fires the overlay's onclick (a click needs the same element
        for pointerdown and pointerup).
    -->
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div
        class="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm"
        role="presentation"
        onclick={() => onBackdropClick?.()}
    ></div>
    <div
        role="dialog"
        aria-modal="true"
        class="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[91]
               flex flex-col resize overflow-hidden
               bg-[var(--surface-panel)] border border-[var(--stroke)] rounded-xl shadow-2xl p-0"
        style="width: min(56rem, calc(100vw - 2rem)); height: 70vh; min-width: 400px; min-height: 300px; max-width: 95vw; max-height: 95vh;"
    >
        <div class="px-5 pt-5 pb-3 shrink-0">
            <h2 class="text-sm font-semibold text-[var(--text)]">{title}</h2>
        </div>
        <div class="flex-1 min-h-0 overflow-hidden">
            {@render children()}
        </div>
        <div class="px-5 pt-3 pb-6 flex gap-2 justify-end border-t border-[var(--stroke)] shrink-0 overflow-visible">
            {@render footer()}
        </div>
    </div>
{:else}
    <!--
        The standard variant: the bits-ui Dialog, for the focus trap, Escape and accessibility.
        onBackdropClick governs whether Escape / a click outside is allowed (for a confirm dialog → it is not).
    -->
    <Dialog.Root
        open={true}
        onOpenChange={(open) => { if (!open) onBackdropClick?.(); }}
    >
        <Dialog.Portal>
            <Dialog.Overlay class="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm" />
            <Dialog.Content
                escapeKeydownBehavior={onBackdropClick ? "close" : "ignore"}
                interactOutsideBehavior={onBackdropClick ? "close" : "ignore"}
                class="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[91]
                       bg-[var(--surface-panel)] border border-[var(--stroke)] rounded-xl shadow-2xl p-0
                       w-[calc(100vw-2rem)] {width}{contentMaxHeight
                    ? ' flex flex-col max-h-[95vh] overflow-hidden'
                    : ''}"
            >
                {#if contentMaxHeight}
                    <div class="px-5 pt-5 pb-3 shrink-0">
                        <h2 class="text-sm font-semibold text-[var(--text)]">{title}</h2>
                    </div>
                    <div
                        class="px-5 pb-4 min-h-0 overflow-y-auto overflow-x-hidden"
                        style="max-height: {contentMaxHeight}"
                    >
                        {@render children()}
                    </div>
                    <div
                        class="px-5 pb-4 flex gap-2 justify-end border-t border-[var(--stroke)] pt-3 overflow-visible shrink-0"
                    >
                        {@render footer()}
                    </div>
                {:else}
                    <div class="px-5 pt-5 pb-4">
                        <h2 class="text-sm font-semibold text-[var(--text)] mb-3">{title}</h2>
                        {@render children()}
                    </div>
                    <div class="px-5 pb-4 flex gap-2 justify-end border-t border-[var(--stroke)] pt-3 overflow-visible">
                        {@render footer()}
                    </div>
                {/if}
            </Dialog.Content>
        </Dialog.Portal>
    </Dialog.Root>
{/if}
