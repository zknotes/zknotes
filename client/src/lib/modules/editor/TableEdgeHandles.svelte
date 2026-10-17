<script lang="ts">
import type { Corner, TableUiController } from "$lib/modules/editor/TableUiController.svelte";

let { tableUi }: { tableUi: TableUiController } = $props();

/**
 * The handles for a table's size:
 * - the edge bars left and right — the whole table's width,
 * - the column boundaries — a `preservetable` resize of two adjacent columns,
 * - the row boundaries — the row's height,
 * - the corners — width and height in one gesture.
 *
 * The hit boxes sit outside or across the boundaries, while the indicator is always drawn exactly on the boundary.
 */
const CORNERS: { id: Corner; cursor: string }[] = [
    { id: "nw", cursor: "nwse-resize" },
    { id: "ne", cursor: "nesw-resize" },
    { id: "sw", cursor: "nesw-resize" },
    { id: "se", cursor: "nwse-resize" },
];

function cornerLeft(id: Corner): number {
    const g = tableUi.gridPos;
    return (id === "nw" || id === "sw" ? g.left : g.left + g.width) - 4;
}

function cornerTop(id: Corner): number {
    const g = tableUi.gridPos;
    return (id === "nw" || id === "ne" ? g.top : g.top + g.height) - 4;
}
</script>

{#if tableUi.edgePos.height > 0}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="absolute z-[145] cursor-ew-resize group hover:bg-transparent"
		style="top: {tableUi.edgePos.top}px; left: {tableUi.edgePos.leftStart}px; width: 8px; height: {tableUi.edgePos.height}px;"
		data-testid="table-edge-left"
		onmousedown={(e) => tableUi.onEdgeMouseDown("left", e)}
	>
		<!--
			The hit box sits OUTSIDE the table (a click in an edge cell has to stay a
			click), but the indicator is drawn exactly over the table's edge — 2 px centred on a 1 px
			border. The bar starts 10 px left of the edge and is 8 px wide, so the edge is at
			`right: -3px`.
		-->
		<div class="absolute right-[-3px] top-0 bottom-0 w-[2px] bg-[var(--accent-color)] opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" class:opacity-100={tableUi.isResizing}></div>
	</div>

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="absolute z-[145] cursor-ew-resize group hover:bg-transparent"
		style="top: {tableUi.edgePos.top}px; left: {tableUi.edgePos.rightStart}px; width: 8px; height: {tableUi.edgePos.height}px;"
		data-testid="table-edge-right"
		onmousedown={(e) => tableUi.onEdgeMouseDown("right", e)}
	>
		<!-- The bar starts 2 px right of the table's edge → the edge is at `left: -3px`. -->
		<div class="absolute left-[-3px] top-0 bottom-0 w-[2px] bg-[var(--accent-color)] opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" class:opacity-100={tableUi.isResizing}></div>
	</div>

	<!-- The column boundaries: the hitbox is centred ON the boundary (inside the table), 7 px as in HugeRTE. -->
	{#each tableUi.colBounds as x, i (i)}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="absolute z-[146] cursor-col-resize group"
			style="top: {tableUi.gridPos.top}px; left: {x - 3.5}px; width: 7px; height: {tableUi.gridPos.height}px;"
			data-testid="table-col-bound-{i}"
			onmousedown={(e) => tableUi.onColumnBoundaryMouseDown(i, e)}
		>
			<div class="absolute left-[2.75px] top-0 bottom-0 w-[1.5px] bg-[var(--accent-color)] opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"></div>
		</div>
	{/each}

	<!-- Row borders. -->
	{#each tableUi.rowBounds as y, i (i)}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="absolute z-[146] cursor-row-resize group"
			style="top: {y - 3.5}px; left: {tableUi.gridPos.left}px; width: {tableUi.gridPos.width}px; height: 7px;"
			data-testid="table-row-bound-{i}"
			onmousedown={(e) => tableUi.onRowBoundaryMouseDown(i, e)}
		>
			<div class="absolute top-[2.75px] left-0 right-0 h-[1.5px] bg-[var(--accent-color)] opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"></div>
		</div>
	{/each}

	<!-- The outline of the table's future size while a corner is dragged. -->
	{#if tableUi.dragOutline}
		{@const o = tableUi.dragOutline}
		<div
			class="absolute z-[148] border-2 border-dashed border-[var(--accent-color)] rounded-[2px] pointer-events-none"
			style="top: {o.top}px; left: {o.left}px; width: {o.width}px; height: {o.height}px;"
			data-testid="table-drag-outline"
		></div>
	{/if}

	<!-- The guide following the cursor while a boundary resize lasts (without it the gesture is invisible). -->
	{#if tableUi.dragGuide}
		{@const g = tableUi.dragGuide}
		<div
			class="absolute z-[149] bg-[var(--accent-color)] pointer-events-none"
			style={g.axis === "col"
				? `top: ${tableUi.gridPos.top}px; left: ${g.pos - 1}px; width: 2px; height: ${tableUi.gridPos.height}px;`
				: `top: ${g.pos - 1}px; left: ${tableUi.gridPos.left}px; width: ${tableUi.gridPos.width}px; height: 2px;`}
			data-testid="table-drag-guide"
		></div>
	{/if}

	<!-- The corners: an 8×8 square centred on the table's corner. -->
	{#each CORNERS as c (c.id)}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="absolute z-[147] w-2 h-2 rounded-[1px] border border-[var(--surface-panel)] bg-[var(--accent-color)] opacity-70 hover:opacity-100 transition-opacity"
			style="top: {cornerTop(c.id)}px; left: {cornerLeft(c.id)}px; cursor: {c.cursor};"
			data-testid="table-corner-{c.id}"
			onmousedown={(e) => tableUi.onCornerMouseDown(c.id, e)}
		></div>
	{/each}
{/if}
