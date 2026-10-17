<script lang="ts">
import type { Editor } from "@tiptap/core";
import Button from "$lib/core/ui/Button.svelte";
import { Checkbox } from "$lib/core/ui";
import Dialog from "$lib/core/ui/Dialog.svelte";
import DialogActions from "$lib/core/ui/DialogActions.svelte";
import Input from "$lib/core/ui/Input.svelte";
import {
    type TableBorderStyle,
    tableBorderStyle,
    tableCaptionText,
    tableColor,
} from "$lib/modules/editor/extensions/table";
import type { TableUiController } from "$lib/modules/editor/TableUiController.svelte";

/**
 * Table properties — the border, the background, the cell padding and the caption, all at
 * table level. The cells inherit through custom properties; this only collects the values.
 */
let {
    open,
    editor,
    tableUi,
    onclose,
}: {
    open: boolean;
    editor: Editor | undefined;
    tableUi: TableUiController;
    onclose: () => void;
} = $props();

const BORDER_STYLES: TableBorderStyle[] = ["solid", "dashed", "dotted", "double", "none"];
const DEFAULT_BORDER_COLOR = "#c9ced6";
const DEFAULT_BG = "#ffffff";

let borderWidth = $state("");
let borderStyle = $state("");
let borderColor = $state("");
let useBorderColor = $state(false);
let background = $state("");
let useBackground = $state(false);
let cellPadding = $state("");
let caption = $state("");

/** Pre-fills the fields from the active table's attributes every time the dialog opens. */
$effect(() => {
    if (!open) return;
    const attrs = tableUi.activeTableAttrs();
    borderWidth = attrs?.borderWidth != null ? String(attrs.borderWidth) : "";
    borderStyle = tableBorderStyle(attrs?.borderStyle) ?? "";
    const bc = tableColor(attrs?.borderColor);
    useBorderColor = bc !== null;
    borderColor = bc ?? DEFAULT_BORDER_COLOR;
    const bg = tableColor(attrs?.background);
    useBackground = bg !== null;
    background = bg ?? DEFAULT_BG;
    cellPadding = attrs?.cellPadding != null ? String(attrs.cellPadding) : "";
    caption = tableCaptionText(attrs?.caption) ?? "";
});

function apply() {
    const width = borderWidth.trim();
    const pad = cellPadding.trim();
    tableUi.setTableProps({
        borderWidth: width === "" ? null : Number.parseInt(width, 10),
        borderStyle: borderStyle === "" ? null : tableBorderStyle(borderStyle),
        borderColor: useBorderColor ? tableColor(borderColor) : null,
        background: useBackground ? tableColor(background) : null,
        cellPadding: pad === "" ? null : Number.parseInt(pad, 10),
        caption: tableCaptionText(caption),
    });
    editor?.commands.focus(undefined, { scrollIntoView: false });
    onclose();
}
</script>

{#if open}
	<Dialog title="Table properties" width="max-w-md" onBackdropClick={onclose}>
		<div class="flex flex-col gap-5">
			<div class="flex flex-col gap-2.5">
				<span class="text-xs font-medium text-[var(--text-muted)]">Border</span>
				<div class="flex items-center gap-3">
					<label class="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
						Width
						<Input
							type="number"
							min="0"
							max="10"
							class="w-16"
							placeholder="1"
							value={borderWidth}
							oninput={(e) => (borderWidth = e.currentTarget.value)}
						/>
					</label>
					<label class="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
						Style
						<select
							class="input input-sm w-28"
							bind:value={borderStyle}
							aria-label="Border style"
						>
							<option value="">Default</option>
							{#each BORDER_STYLES as s (s)}
								<option value={s}>{s}</option>
							{/each}
						</select>
					</label>
				</div>
				<div class="flex items-center gap-2">
					<label
						class="flex items-center gap-2 px-1.5 py-1 text-xs font-normal text-[var(--text-muted)] cursor-pointer select-none"
					>
						<Checkbox bind:checked={useBorderColor} />
						Colour
					</label>
					<input
						type="color"
						class="h-7 w-9 rounded-md border border-[var(--stroke)] bg-transparent
							{useBorderColor ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}"
						bind:value={borderColor}
						disabled={!useBorderColor}
						oninput={() => (useBorderColor = true)}
						aria-label="Border colour"
					/>
				</div>
			</div>

			<div class="flex items-center gap-6">
				<div class="flex items-center gap-2">
					<label
						class="flex items-center gap-2 px-1.5 py-1 text-xs font-normal text-[var(--text-muted)] cursor-pointer select-none"
					>
						<Checkbox bind:checked={useBackground} />
						Background
					</label>
					<input
						type="color"
						class="h-7 w-9 rounded-md border border-[var(--stroke)] bg-transparent
							{useBackground ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}"
						bind:value={background}
						disabled={!useBackground}
						oninput={() => (useBackground = true)}
						aria-label="Background colour"
					/>
				</div>
				<label class="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
					Cell padding
					<Input
						type="number"
						min="0"
						max="40"
						class="w-16"
						placeholder="8"
						value={cellPadding}
						oninput={(e) => (cellPadding = e.currentTarget.value)}
					/>
				</label>
			</div>

			<label class="flex flex-col gap-1.5 text-xs text-[var(--text-muted)]">
				Caption
				<Input
					type="text"
					maxlength={200}
					placeholder="Table title"
					value={caption}
					oninput={(e) => (caption = e.currentTarget.value)}
				/>
			</label>
		</div>

		{#snippet footer()}
			<DialogActions>
				<Button variant="ghost" onclick={onclose}>Cancel</Button>
				<Button variant="primary" onclick={apply}>Apply</Button>
			</DialogActions>
		{/snippet}
	</Dialog>
{/if}
