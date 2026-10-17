<script lang="ts">
import type { Snippet } from "svelte";
import type { LucideIcon } from "$lib/core/types/icons";
import Button from "$lib/core/ui/Button.svelte";
import { cn } from "$lib/core/utils/cn";

/**
 * A single dropdown-menu entry: an icon + a label (+ an optional shortcut on the right).
 *
 * Deliberately generic — it knows nothing about the editor — so `ItemContextMenu` and `VirtualFiles`
 * can adopt it without an API change (see the UX-DEBT comments in those files).
 * It is built on `Button`, so it passes `scripts/check-button-ux.sh` without an exception.
 */
interface Props {
    /** A Lucide icon as a component; for anything else use `iconSnippet`. */
    icon?: LucideIcon;
    iconSnippet?: Snippet;
    label: string;
    /** Shown on the right, muted ("Tab", for instance). */
    shortcut?: string;
    disabled?: boolean;
    /** A destructive action — it maps onto the `danger-ghost` variant. */
    danger?: boolean;
    onclick?: (e: MouseEvent) => void;
    class?: string;
}

const {
    icon: Icon,
    iconSnippet,
    label,
    shortcut,
    disabled = false,
    danger = false,
    onclick,
    class: extraClass = "",
}: Props = $props();
</script>

<Button
	variant={danger ? "danger-ghost" : "ghost"}
	{disabled}
	{onclick}
	role="menuitem"
	aria-label={label}
	tabindex={-1}
	onmousedown={(e: MouseEvent) => e.preventDefault()}
	class={cn("w-full justify-start h-8 px-2 gap-2 rounded-md text-sm font-normal", extraClass)}
>
	{#if iconSnippet}
		{@render iconSnippet()}
	{:else if Icon}
		<Icon class="w-3.5 h-3.5 shrink-0" />
	{:else}
		<span class="w-3.5 shrink-0"></span>
	{/if}
	<span class="flex-1 text-left truncate">{label}</span>
	{#if shortcut}
		<span class="text-2xs font-mono text-[var(--text-dim)] shrink-0">{shortcut}</span>
	{/if}
</Button>
