<script lang="ts">
import { Search } from "lucide-svelte";
import { searchOpenStore } from "$lib/core/stores/search-open.svelte";
import Button from "./Button.svelte";
</script>

<div class="px-3 pb-2">
    <Button
        variant="ghost"
        onclick={() => searchOpenStore.show()}
        class="w-full !h-auto !justify-start gap-2 !px-2.5 !py-1.5
               bg-[color-mix(in_srgb,var(--surface-app)_60%,transparent)]
               border border-[var(--stroke)]
               hover:border-[color-mix(in_srgb,var(--accent-color)_35%,var(--stroke))]"
    >
        <Search class="w-[0.8125rem] h-[0.8125rem] text-[var(--text-dim)] shrink-0" />
        <span class="text-xs text-[var(--text-dim)] flex-1 min-w-0 truncate text-left">Search vault…</span>
        <kbd class="font-mono text-2xs text-[var(--text-dim)] border border-[var(--stroke)] rounded px-1 py-px bg-[var(--surface-panel)] pointer-events-none shrink-0">⌘K</kbd>
    </Button>
</div>