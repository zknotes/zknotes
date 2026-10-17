<script lang="ts">
import { Search } from "lucide-svelte";

interface Props {
    value: string;
    placeholder?: string;
    class?: string;
}

let { value = $bindable(), placeholder = "Search…", class: className = "" }: Props = $props();
</script>

<div class="flex items-center bg-[var(--surface-panel)] border border-[var(--stroke)] rounded-md px-2 py-1 {className}">
    <Search class="w-3.5 h-3.5 text-[var(--text-dim)] mr-1.5" />
    <input
        type="text"
        bind:value
        {placeholder}
        class="bg-transparent text-xs text-[var(--text-sub)] outline-none w-36 placeholder:text-[var(--text-dim)]"
    />
</div>