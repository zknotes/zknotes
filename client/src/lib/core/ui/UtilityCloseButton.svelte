<script lang="ts">
import { X } from "lucide-svelte";
import { quickViewForPath } from "$lib/core/constants/views";
import { utilityReturnStore } from "$lib/core/stores/utility-return.svelte";
import Button from "./Button.svelte";

interface Props {
    /** Overrides the tooltip; the default depends on the return target. */
    title?: string;
    class?: string;
}

let { title, class: extraClass = "" }: Props = $props();

let closeTitle = $derived.by(() => {
    if (title) return title;
    const target = utilityReturnStore.peekCloseTarget();
    if (target.startsWith("/note/")) return "Close and return to note";
    if (target === "/") return "Close";
    if (target.startsWith("/settings")) return "Close and return to settings";
    if (target.startsWith("/help")) return "Close and return to help";
    const view = quickViewForPath(target);
    if (view) return `Close and return to ${view.label.toLowerCase()}`;
    return "Close";
});
</script>

<Button
    variant="ghost"
    size="icon"
    class="shrink-0 {extraClass}"
    title={closeTitle}
    aria-label={closeTitle}
    onclick={() => utilityReturnStore.close()}
>
    <X class="w-4 h-4" />
</Button>
