<script lang="ts">
// A generic settings section — a header (icon + title + description) and arbitrary content.
// The style is "divider": no card outline; sections are separated by a thin line when several of them
// share a `divide-y divide-[var(--stroke)]` container. The first section has no top spacing.
import type { Snippet } from "svelte";

type Tone = "primary" | "brand" | "secondary" | "destructive";

interface Props {
    /** The header's icon (optional) — pass it as `{#snippet icon()}`. */
    icon?: Snippet;
    title: string;
    description?: string;
    /** The icon's colour; match it to what the section means. */
    tone?: Tone;
    class?: string;
    /** For marketing shots / the E2E — it lands on the root `<section>`. */
    testId?: string;
    children: Snippet;
}

const {
    icon,
    title,
    description,
    tone = "primary",
    class: extraClass = "",
    testId,
    children,
}: Props = $props();

const TONE: Record<Tone, string> = {
    primary: "bg-[var(--accent-color)]/10 text-[var(--accent-color)]",
    brand: "bg-brand0/10 text-brand0",
    secondary: "bg-[var(--surface-raised)] text-[var(--text)]",
    destructive: "bg-[var(--danger)]/10 text-[var(--danger)]",
};
</script>

<section class="py-8 first:pt-0 {extraClass}" data-testid={testId}>
    <div class="flex items-center gap-4 mb-6">
        {#if icon}
            <div class="p-3 rounded-xl shrink-0 {TONE[tone]}">
                {@render icon()}
            </div>
        {/if}
        <div>
            <h2 class="text-lg font-semibold text-[var(--text)]">{title}</h2>
            {#if description}
                <p class="text-sm text-[var(--text-muted)] mt-1">{description}</p>
            {/if}
        </div>
    </div>
    {@render children()}
</section>
