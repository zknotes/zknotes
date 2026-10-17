<script lang="ts">
import Input from "./Input.svelte";

let { value = $bindable("") }: { value?: string } = $props();

export function setValueFromParent(next: string) {
    value = next;
}
</script>

<div data-testid="host" data-value={value}>
    <Input bind:value />
</div>
