<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
    class?: string;
    children: Snippet;
    [key: string]: any;
}

let { class: className = "", children, ...rest }: Props = $props();
</script>

<div class="text-xs text-[var(--danger)] {className}" {...rest}>
    {@render children()}
</div>
