<script lang="ts">
import type { PopoverMenus } from "$lib/modules/editor/PopoverMenus.svelte";
import type { TableUiController } from "$lib/modules/editor/TableUiController.svelte";
import TableToolbar from "./TableToolbar.svelte";
import TableEdgeHandles from "./TableEdgeHandles.svelte";

/**
 * The floating controls over a hovered table: the toolbar + the edge handles for resizing.
 */
let { tableUi, menus }: { tableUi: TableUiController; menus: PopoverMenus } = $props();
</script>

{#if tableUi.showControls && tableUi.activeRect}
	<!--
		During a native HTML5 drag (`isDragging`, the grip moving the table) the controls are hidden
		through opacity ALONE — they are not unmounted and they do not get `pointer-events: none`: the
		grip has to stay attached to the DOM and hit-testable (proven — `pointer-events-none` on the
		wrapper during a CDP-simulated drag causes an immediate `dragend`, most likely because Chromium
		uses the hit test on every mousemove to track the drop target). Without this, our frozen toolbar
		(whose position deliberately does not refresh while the gesture lasts) and the edge handles
		overlap the browser's semi-transparent drag ghost of the table, so the top of the toolbar looks
		"cut off".
	-->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		role="presentation"
		class={tableUi.isDragging ? "opacity-0" : ""}
		onmouseenter={() => (tableUi.isHoveringControls = true)}
		onmouseleave={() => {
			tableUi.isHoveringControls = false;
		}}
	>
		<TableToolbar {tableUi} {menus} editor={tableUi.editor} />
		{#if !tableUi.isDragging}
			<TableEdgeHandles {tableUi} />
		{/if}
	</div>
{/if}
