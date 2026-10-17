<script lang="ts">
import type { Snippet } from "svelte";
import Button from "$lib/core/ui/Button.svelte";

type Props = {
    active?: boolean;
    title?: string;
    onclick?: (e: MouseEvent) => void;
    children: Snippet;
};

let { active = false, title, onclick, children }: Props = $props();
</script>

<Button
    variant="ghost"
    size="icon"
    {active}
    {title}
    {onclick}
>
    {@render children()}
</Button>
