<script lang="ts">
// The state of one seal at a glance. "Pending" is never styled like a finished proof.
import { Clock, ShieldAlert, ShieldCheck } from "lucide-svelte";

interface Props {
    state: "pending" | "confirmed" | "stalled";
}
const { state }: Props = $props();

const LABEL = { pending: "Pending", confirmed: "Sealed", stalled: "Not confirmed" } as const;
const TONE = {
    pending: "bg-[var(--surface-panel)] text-[var(--text-sub)] border-[var(--stroke)]",
    confirmed: "bg-brand0/10 text-brand-fg border-brand0/30",
    stalled: "bg-[var(--surface-panel)] text-[var(--text-dim)] border-[var(--stroke)]",
} as const;
</script>

<span
    class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium {TONE[state]}"
    data-testid="seal-badge"
    data-state={state}
>
    {#if state === "confirmed"}
        <ShieldCheck class="w-3 h-3" />
    {:else if state === "pending"}
        <Clock class="w-3 h-3" />
    {:else}
        <ShieldAlert class="w-3 h-3" />
    {/if}
    {LABEL[state]}
</span>
