<script lang="ts">
interface Props {
    count?: number;
}

let { count = 5 }: Props = $props();
</script>

<div class="space-y-2">
    {#each Array(count) as _}
        <div class="h-12 bg-[var(--surface-raised)] rounded-lg animate-pulse"></div>
    {/each}
</div>