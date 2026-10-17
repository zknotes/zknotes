<script lang="ts">
import type { HTMLInputAttributes } from "svelte/elements";
import { cn } from "$lib/core/utils/cn";

// `onclick` / `onkeydown` are deliberately excluded: the component uses them for stopPropagation.
// Were they allowed, `{...rest}` would take them in and our own handlers below would
// silently overwrite them — TypeScript would not report it.
interface Props
    extends Omit<
        HTMLInputAttributes,
        "type" | "class" | "onchange" | "checked" | "onclick" | "onkeydown"
    > {
    class?: string;
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
}

let {
    class: className = "",
    checked = $bindable(false),
    onCheckedChange,
    ...rest
}: Props = $props();
</script>

<input
    {...rest}
    type="checkbox"
    class={cn("checkbox", className)}
    bind:checked
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
    onchange={() => onCheckedChange?.(checked)}
/>
