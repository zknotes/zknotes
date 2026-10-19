<script lang="ts">
// The "where it lives" line under a note title: a home or branch icon and the truncated folder path.
import { CornerDownRight, Home } from "lucide-svelte";
import MetaText from "./MetaText.svelte";

interface Props {
    /** The folder path label; `root` draws the home icon instead of the branch. */
    label: string;
    root: boolean;
    class?: string;
}

let { label, root, class: className = "" }: Props = $props();
</script>

<MetaText
    class="flex items-center gap-1 font-mono mt-0.5 min-w-0 max-w-full truncate {className}"
    title={label}
>
    {#if root}
        <Home class="w-[0.625rem] h-[0.625rem] flex-shrink-0" />
    {:else}
        <CornerDownRight class="w-[0.625rem] h-[0.625rem] flex-shrink-0" />
    {/if}
    <span class="truncate">{label}</span>
</MetaText>
