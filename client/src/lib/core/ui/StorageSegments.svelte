<script lang="ts">
// The one storage bar: each segment is a share of the quota, capped at 100 % so an over-quota account
// still draws inside the track. Files, Trash and Settings → Storage all render it; the colours and
// the arithmetic live here, the callers only say what the segments are.
import { humanSizeShort } from "$lib/core/utils/format";
import type { StorageSegment } from "$lib/core/utils/storage-display";

interface Props {
    segments: StorageSegment[];
    quota: number;
    /** `sm` is the thin page bar, `md` the settings bar. */
    height?: "sm" | "md";
    overLimit?: boolean;
    /** The 2×2 legend under the bar (settings). */
    legend?: boolean;
    class?: string;
}

let {
    segments,
    quota,
    height = "sm",
    overLimit = false,
    legend = false,
    class: className = "",
}: Props = $props();

function pct(bytes: number): number {
    return quota > 0 ? Math.min(100, (bytes / quota) * 100) : 0;
}
</script>

<div
    class="w-full rounded-full overflow-hidden flex {height === 'sm'
        ? 'h-1.5 bg-[var(--surface-raised)]'
        : 'h-3 bg-[var(--stroke)]'} {className}"
    data-testid="storage-segments"
>
    {#each segments as segment (segment.label)}
        <div
            class="h-full transition-all {overLimit && !segment.keepColor
                ? 'bg-[var(--danger)]'
                : segment.className}"
            style="width: {pct(segment.bytes)}%"
            title="{segment.label}: {humanSizeShort(segment.bytes)}"
            data-segment={segment.label}
        ></div>
    {/each}
</div>

{#if legend}
    <div class="grid grid-cols-2 gap-y-3 gap-x-4 text-sm mt-4">
        {#each segments as segment (segment.label)}
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                    <div class="w-3 h-3 rounded-full {segment.className}"></div>
                    <span class="text-[var(--text-muted)]">{segment.label}</span>
                </div>
                <span class="font-mono">{humanSizeShort(segment.bytes)}</span>
            </div>
        {/each}
    </div>
{/if}
