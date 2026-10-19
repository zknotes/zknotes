<script lang="ts">
// The title block that opens every settings section — one shape, so the sections cannot drift apart.
interface Props {
    title: string;
    description: string;
}

let { title, description }: Props = $props();
</script>

<div class="mb-8">
    <h1 class="text-2xl font-bold text-[var(--text)]">{title}</h1>
    <p class="text-[var(--text-muted)] mt-1 text-sm">{description}</p>
</div>
