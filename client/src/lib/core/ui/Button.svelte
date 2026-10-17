<script lang="ts">
import type { Snippet } from "svelte";
import { cn } from "$lib/core/utils/cn";
import { Loader2 } from "lucide-svelte";

type Variant =
    | "primary"
    | "normal"
    | "danger"
    | "danger-ghost"
    | "warning"
    | "info"
    | "success"
    | "ghost";
type Size = "sm" | "md" | "lg" | "icon";

interface Props {
    variant?: Variant;
    size?: Size;
    type?: "button" | "submit" | "reset";
    disabled?: boolean;
    loading?: boolean;
    active?: boolean;
    title?: string;
    href?: string;
    onclick?: (e: MouseEvent) => void;
    class?: string;
    children?: Snippet;
    [key: string]: any; // rest props
}

const {
    variant = "normal",
    size = "md",
    type = "button",
    disabled = false,
    loading = false,
    active = false,
    title,
    href,
    onclick,
    class: extraClass = "",
    children,
    ...rest
}: Props = $props();

const isDisabled = $derived(disabled || loading);

const VARIANT: Record<Variant, string> = {
    primary: "btn-solid v-primary",
    normal: "btn-neutral",
    danger: "btn-solid v-danger",
    "danger-ghost": "btn-soft v-danger",
    warning: "btn-solid v-warning",
    info: "btn-solid v-info",
    success: "btn-solid v-success",
    ghost: "btn-ghost",
};

const SIZE: Record<Size, string> = {
    sm: "h-6 px-2.5 text-xs rounded",
    md: "h-7 px-3 text-sm rounded-md",
    lg: "h-9 px-4 text-base rounded-md",
    icon: "w-7 h-7 p-0 rounded-md", // Default icon size. For smaller use class="w-6 h-6" via cn
};
</script>

{#if href}
	<a
		{href}
		{title}
		aria-disabled={isDisabled}
		data-active={active ? "true" : undefined}
		class={cn(
			"btn-base inline-flex items-center justify-center gap-1.5 font-medium transition-colors select-none whitespace-nowrap",
			isDisabled ? "btn-cursor-disabled opacity-50 pointer-events-none" : "btn-cursor-pointer",
			VARIANT[variant],
			SIZE[size],
			extraClass
		)}
		{...rest}
	>
		{#if loading}<Loader2 class="w-4 h-4 animate-spin" />{/if}
		{#if children}
			{@render children()}
		{/if}
	</a>
{:else}
	<button
		{type}
		disabled={isDisabled}
		{title}
		{onclick}
		aria-disabled={isDisabled}
		data-active={active ? "true" : undefined}
		class={cn(
			"btn-base inline-flex items-center justify-center gap-1.5 font-medium transition-colors disabled:opacity-50 select-none whitespace-nowrap",
			isDisabled ? "btn-cursor-disabled" : "btn-cursor-pointer",
			VARIANT[variant],
			SIZE[size],
			extraClass
		)}
		{...rest}
	>
		{#if loading}<Loader2 class="w-4 h-4 animate-spin" />{/if}
		{#if children}
			{@render children()}
		{/if}
	</button>
{/if}

