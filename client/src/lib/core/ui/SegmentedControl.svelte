<script lang="ts">
import Button from "./Button.svelte";

interface Props {
    options: { id: string; label: string }[];
    value: string;
    onChange: (id: string) => void;
}

let { options, value, onChange }: Props = $props();
</script>

<div class="flex items-center gap-0.5 bg-[var(--surface-panel)] border border-[var(--stroke)] rounded-md p-0.5">
    {#each options as option (option.id)}
        <Button
            variant="ghost"
            size="sm"
            active={value === option.id}
            onclick={() => onChange(option.id)}
        >{option.label}</Button>
    {/each}
</div>