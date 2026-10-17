<script lang="ts">
import { ChevronDown, GripHorizontal } from "lucide-svelte";
import Button from "$lib/core/ui/Button.svelte";
import type { PopoverMenus } from "$lib/modules/editor/PopoverMenus.svelte";
import {
    TABLE_TOOLBAR_GAP,
    type TableUiController,
} from "$lib/modules/editor/TableUiController.svelte";
import type { Editor } from "@tiptap/core";

let {
    tableUi,
    menus,
    editor,
}: { tableUi: TableUiController; menus: PopoverMenus; editor: Editor | undefined } = $props();

function stopAll(e: Event) {
    e.stopPropagation();
}
</script>

<div
	class="absolute z-[150] bg-[var(--surface-raised)] border border-[var(--stroke)] shadow-[var(--float-shadow)] rounded-md flex items-center p-0.5"
	style="top: {tableUi.toolbarPos.top}px; left: {tableUi.toolbarPos.left}px;{tableUi.toolbarPlacement ===
	'north'
		? ` transform: translateY(calc(-100% - ${TABLE_TOOLBAR_GAP}px));`
		: ''}"
	data-testid="table-toolbar"
	data-placement={tableUi.toolbarPlacement}
>
	<!--
		The grip: a click selects the table, a drag moves it.

		Deliberately WITHOUT `onmousedown preventDefault` (unlike `MenuItem` and the buttons in
		`EditorToolbar`): with it, Chromium never starts the HTML5 drag, so the table cannot be moved.
		The editor's focus is restored in `onDragStart` / `selectTable`, so nothing is lost.
	-->
	<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
	<div
		class="w-6 h-6 ml-0.5 mr-1 text-[var(--text-muted)] hover:text-[var(--text)] flex items-center justify-center cursor-move rounded hover:bg-[var(--row-hover)] transition-colors"
		draggable="true"
		data-testid="table-grip"
		title="Move table"
		ondragstart={(e) => tableUi.onDragStart(e)}
		ondragend={() => tableUi.onDragEnd()}
		onclick={(e) => {
			stopAll(e);
			tableUi.selectTable();
		}}
	>
		<!-- pointer-events-none: the mousedown has to land on the draggable div. Chromium does not
		     start an HTML5 drag when the target is an inline <svg> (an SVGElement has no HTML
		     `draggable`), which is how the grip with its lucide icon stopped being movable. -->
		<GripHorizontal class="w-3.5 h-3.5 pointer-events-none" />
	</div>

	<div class="w-px h-4 bg-[var(--stroke)] mx-1"></div>

	<Button variant="ghost" size="sm" class="h-6 px-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)] data-[state=open]:bg-[var(--row-hover)]" data-state={menus.isOpen("tableTable") ? "open" : "closed"} onclick={(e) => menus.toggle("tableTable", e.currentTarget as HTMLElement)}>
		Table <ChevronDown class="w-3 h-3 ml-1" />
	</Button>
	<Button variant="ghost" size="sm" class="h-6 px-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)] data-[state=open]:bg-[var(--row-hover)]" data-state={menus.isOpen("tableRow") ? "open" : "closed"} onclick={(e) => menus.toggle("tableRow", e.currentTarget as HTMLElement)}>
		Row <ChevronDown class="w-3 h-3 ml-1" />
	</Button>
	<Button variant="ghost" size="sm" class="h-6 px-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)] data-[state=open]:bg-[var(--row-hover)]" data-state={menus.isOpen("tableColumn") ? "open" : "closed"} onclick={(e) => menus.toggle("tableColumn", e.currentTarget as HTMLElement)}>
		Column <ChevronDown class="w-3 h-3 ml-1" />
	</Button>
	<Button variant="ghost" size="sm" class="h-6 px-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)] data-[state=open]:bg-[var(--row-hover)]" data-state={menus.isOpen("tableCell") ? "open" : "closed"} onclick={(e) => menus.toggle("tableCell", e.currentTarget as HTMLElement)}>
		Cell <ChevronDown class="w-3 h-3 ml-1" />
	</Button>
</div>
