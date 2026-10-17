import type { Editor } from "@tiptap/core";
import { fixTables } from "@tiptap/pm/tables";
import {
    ArrowDownToLine,
    ArrowLeftToLine,
    ArrowRightToLine,
    ArrowUpToLine,
    Combine,
    Heading,
    PanelLeft,
    PanelTop,
    Settings2,
    Split,
    Trash2,
    Wrench,
    MousePointer2,
    Maximize,
    Table as TableIcon,
} from "lucide-svelte";
import type { LucideIcon } from "$lib/core/types/icons";
import type { TableUiController } from "./TableUiController.svelte";

export type TableMenuEntryItem = {
    kind: "item";
    label: string;
    icon: LucideIcon;
    danger?: boolean;
    disabled?: boolean;
    action: () => void;
};

export type TableMenuEntryAlign = {
    kind: "align";
};

export type TableMenuEntry = TableMenuEntryItem | TableMenuEntryAlign;

export type TableMenuGroup = {
    id: "table" | "row" | "column" | "cell";
    label: string;
    items: TableMenuEntry[];
};

function chain(editor: Editor) {
    return editor.chain().focus(undefined, { scrollIntoView: false });
}

export function tableMenuGroups(
    editor: Editor | undefined,
    tableUi: TableUiController,
): TableMenuGroup[] {
    if (!editor) return [];

    const canSplit = (() => {
        try {
            return editor.can().splitCell() ?? false;
        } catch (_) {
            return false;
        }
    })();

    const canFix = (() => {
        try {
            return fixTables(editor.state) !== undefined;
        } catch (_) {
            return false;
        }
    })();

    return [
        {
            id: "table",
            label: "Table",
            items: [
                {
                    kind: "item",
                    label: "Select table",
                    icon: TableIcon,
                    action: () => tableUi.selectTable(),
                },
                {
                    kind: "item",
                    label: "Reset width",
                    icon: Maximize,
                    action: () => tableUi.resetWidth(),
                },
                {
                    kind: "item",
                    label: "Table properties…",
                    icon: Settings2,
                    action: () => {
                        tableUi.propertiesOpen = true;
                    },
                },
                {
                    kind: "item",
                    label: "Fix table",
                    icon: Wrench,
                    disabled: !canFix,
                    action: () => {
                        const tr = fixTables(editor.state);
                        if (tr) editor.view.dispatch(tr);
                    },
                },
                {
                    kind: "item",
                    label: "Delete table",
                    icon: Trash2,
                    danger: true,
                    action: () => chain(editor).deleteTable().run(),
                },
            ],
        },
        {
            id: "row",
            label: "Row",
            items: [
                {
                    kind: "item",
                    label: "Insert row above",
                    icon: ArrowUpToLine,
                    action: () => chain(editor).addRowBefore().run(),
                },
                {
                    kind: "item",
                    label: "Insert row below",
                    icon: ArrowDownToLine,
                    action: () => chain(editor).addRowAfter().run(),
                },
                {
                    kind: "item",
                    label: "Select row",
                    icon: MousePointer2,
                    action: () => tableUi.selectRowAtCaret(),
                },
                {
                    kind: "item",
                    label: "Toggle header row",
                    icon: PanelTop,
                    action: () => chain(editor).toggleHeaderRow().run(),
                },
                {
                    kind: "item",
                    label: "Delete row",
                    icon: Trash2,
                    danger: true,
                    action: () => chain(editor).deleteRow().run(),
                },
            ],
        },
        {
            id: "column",
            label: "Column",
            items: [
                {
                    kind: "item",
                    label: "Insert column left",
                    icon: ArrowLeftToLine,
                    action: () => chain(editor).addColumnBefore().run(),
                },
                {
                    kind: "item",
                    label: "Insert column right",
                    icon: ArrowRightToLine,
                    action: () => chain(editor).addColumnAfter().run(),
                },
                {
                    kind: "item",
                    label: "Select column",
                    icon: MousePointer2,
                    action: () => tableUi.selectColumnAtCaret(),
                },
                {
                    kind: "item",
                    label: "Toggle header column",
                    icon: PanelLeft,
                    action: () => chain(editor).toggleHeaderColumn().run(),
                },
                {
                    kind: "item",
                    label: "Delete column",
                    icon: Trash2,
                    danger: true,
                    action: () => chain(editor).deleteColumn().run(),
                },
            ],
        },
        {
            id: "cell",
            label: "Cell",
            items: [
                {
                    kind: "item",
                    label: "Merge cells",
                    icon: Combine,
                    action: () => chain(editor).mergeCells().run(),
                },
                {
                    kind: "item",
                    label: "Split cell",
                    icon: Split,
                    disabled: !canSplit,
                    action: () => chain(editor).splitCell().run(),
                },
                {
                    kind: "item",
                    label: "Toggle header cell",
                    icon: Heading,
                    action: () => chain(editor).toggleHeaderCell().run(),
                },
                {
                    kind: "align",
                },
            ],
        },
    ];
}
