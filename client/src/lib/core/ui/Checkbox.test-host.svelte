<script lang="ts">
import Checkbox from "./Checkbox.svelte";

interface Props {
    variant?: "plain" | "label" | "nested";
    disabled?: boolean;
    checked?: boolean;
}

let { variant = "plain", disabled = false, checked = $bindable(false) }: Props = $props();

let parentClicks = $state(0);

export function setCheckedFromParent(value: boolean) {
    checked = value;
}
</script>

<div data-testid="host" data-checked={checked} data-parent-clicks={parentClicks}>
    {#if variant === "label"}
        <label data-testid="label">
            Colour
            <Checkbox bind:checked {disabled} />
        </label>
    {:else if variant === "nested"}
        <!-- The VirtualFiles pattern: the parent and the checkbox both toggle the same state. -->
        <div
            data-testid="parent"
            role="button"
            tabindex="0"
            onclick={() => {
                parentClicks += 1;
                checked = !checked;
            }}
            onkeydown={(e) => {
                if (e.key === "Enter") {
                    parentClicks += 1;
                    checked = !checked;
                }
            }}
        >
            <Checkbox {checked} {disabled} onCheckedChange={() => (checked = !checked)} />
        </div>
    {:else}
        <Checkbox bind:checked {disabled} />
    {/if}
</div>
