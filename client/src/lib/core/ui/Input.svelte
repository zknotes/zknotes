<script lang="ts">
import type { HTMLInputAttributes } from "svelte/elements";
import { cn } from "$lib/core/utils/cn";

interface Props extends Omit<HTMLInputAttributes, "class"> {
    class?: string;
}

let { class: className = "", value = $bindable(), ...rest }: Props = $props();
</script>

<input class={cn("input", className)} {...rest} bind:value />
