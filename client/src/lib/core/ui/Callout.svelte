<script lang="ts">
// The one shape for an inline notice: a box tinted in the colour of what it says. Pages used to
// hand-roll these with ad-hoc palette colours (red-500, amber-500, rose-300); keeping them on the
// theme tokens puts every notice on the same palette as the buttons and inputs.
import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-svelte";
import type { Snippet } from "svelte";
import type { LucideIcon } from "$lib/core/types/icons";
import { cn } from "$lib/core/utils/cn";

type Variant = "danger" | "warning" | "success";

interface Props {
    variant?: Variant;
    /** `tinted` colours the text too (a short message); `plain` keeps the body neutral (longer prose). */
    tone?: "tinted" | "plain";
    size?: "sm" | "md";
    /** Lead with the variant's icon. */
    icon?: boolean;
    class?: string;
    children: Snippet;
    [key: string]: any;
}

let {
    variant = "danger",
    tone = "tinted",
    size = "md",
    icon = false,
    class: className = "",
    children,
    ...rest
}: Props = $props();

const BOX: Record<Variant, string> = {
    danger: "bg-[var(--danger)]/10 border-[var(--danger)]/20",
    warning: "bg-[var(--warning)]/10 border-[var(--warning)]/20",
    success: "bg-brand0/10 border-brand0/20",
};
const TEXT: Record<Variant, string> = {
    danger: "text-[var(--danger)]",
    warning: "text-[var(--warning)]",
    success: "text-brand0",
};
const ICON: Record<Variant, LucideIcon> = {
    danger: CircleAlert,
    warning: TriangleAlert,
    success: CircleCheck,
};
const Icon = $derived(ICON[variant]);
</script>

<div
    class={cn(
        "text-sm rounded-xl border",
        size === "sm" ? "p-3" : "p-4",
        BOX[variant],
        tone === "tinted" ? TEXT[variant] : "text-[var(--text)]",
        icon && "flex items-start gap-3",
        className,
    )}
    {...rest}
>
    {#if icon}
        <Icon class={cn("w-4 h-4 mt-0.5 shrink-0", TEXT[variant])} />
        <div class="flex-1 min-w-0">{@render children()}</div>
    {:else}
        {@render children()}
    {/if}
</div>
