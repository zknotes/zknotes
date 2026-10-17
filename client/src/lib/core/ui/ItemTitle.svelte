<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
    size?: "sm" | "xs";
    weight?: "medium" | "semibold";
    as?: string;
    class?: string;
    children: Snippet;
    [key: string]: any;
}

let {
    size = "sm",
    weight = "medium",
    as = "span",
    class: className = "",
    children,
    ...rest
}: Props = $props();
</script>

<svelte:element this={as} class="text-{size} font-{weight} truncate {className}" {...rest}>
    {@render children()}
</svelte:element>
