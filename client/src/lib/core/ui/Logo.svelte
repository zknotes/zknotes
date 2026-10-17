<script lang="ts">
let { class: className = "" } = $props<{ class?: string }>();
</script>

<div class="flex items-center gap-2 shrink-0 {className}">
	<span class="shrink-0 w-7 h-7 rounded-md bg-[var(--surface-raised)] flex items-center justify-center">
		<img src="/zknotes-icon-v2.svg" width="20" height="20" alt="ZKnotes Logo" />
	</span>
	<div class="flex-1 min-w-0">
		<div class="text-sm font-mono tracking-tight truncate leading-none">
			<span class="font-extrabold text-[var(--text)]">ZK</span><span class="font-light text-sky-400">notes</span>
		</div>
	</div>
</div>
