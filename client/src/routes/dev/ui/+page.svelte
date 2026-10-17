<script lang="ts">
/**
 * Thin loader for Dev UI Gallery.
 * Heavy content is dynamically imported ONLY in dev to keep the prod route chunk minimal.
 */
import { browser } from "$app/environment";
import type { Component } from "svelte";

let GalleryComponent = $state<Component | null>(null);
const isDev = import.meta.env.DEV;

$effect(() => {
    if (browser && isDev) {
        import("./_ui-gallery.svelte").then((m) => {
            GalleryComponent = m.default;
        });
    }
});
</script>

{#if isDev && GalleryComponent}
	<GalleryComponent />
{:else}
	<div class="min-h-screen flex items-center justify-center p-8 text-center text-[var(--text-dim)] bg-[var(--surface-app)]">
		<div>
			<p class="font-mono text-sm">UI Gallery is only available in development mode.</p>
			<p class="text-xs mt-2">Run <code>bun run dev</code> from client</p>
		</div>
	</div>
{/if}