<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
    class?: string;
    children: Snippet;
    [key: string]: any;
}

let { class: className = "", children, ...rest }: Props = $props();
</script>

<kbd class="font-mono text-2xs text-[var(--text-dim)] border border-[var(--stroke)] rounded px-1.5 py-0.5 {className}" {...rest}>
    {@render children()}
</kbd>
