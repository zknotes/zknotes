<script lang="ts">
import type { LucideIcon } from "$lib/core/types/icons";

interface Props {
    icon: LucideIcon;
    title: string;
    subtitle?: string;
}

let { icon: Icon, title, subtitle }: Props = $props();
</script>

<div class="flex flex-col items-center justify-center py-24 text-center">
    <div class="w-12 h-12 rounded-xl bg-[var(--surface-panel)] border border-[var(--stroke)] flex items-center justify-center text-[var(--text-muted)] mb-4">
        <Icon class="w-5 h-5" />
    </div>
    <div class="text-[var(--text-sub)] text-sm font-medium mb-1">{title}</div>
    {#if subtitle}
        <div class="text-[var(--text-dim)] text-xs max-w-xs">{subtitle}</div>
    {/if}
</div>