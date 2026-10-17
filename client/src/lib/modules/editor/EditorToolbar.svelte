<script lang="ts">
import type { Editor } from "@tiptap/core";
import {
    Bold,
    ChevronDown,
    Code,
    Heading1,
    Highlighter,
    ImageIcon,
    Import,
    Italic,
    Keyboard,
    Link2,
    List,
    ListChecks,
    ListOrdered,
    Minus,
    Palette,
    PanelLeft,
    Paperclip,
    Quote,
    Redo2,
    RemoveFormatting,
    Smile,
    SquareCode,
    Strikethrough,
    Subscript as SubscriptIcon,
    Superscript as SuperscriptIcon,
    Table as TableIcon,
    Type,
    Underline as UnderlineIcon,
    Undo2,
    AlignLeft,
    AlignCenter,
    AlignRight,
    AlignJustify,
} from "lucide-svelte";
import { fontSizeDisplayLabel } from "$lib/core/constants/fonts";
import { outlineStore } from "$lib/core/stores/outline.svelte";
import type { EmojiPickerState } from "$lib/modules/editor/EmojiPickerState.svelte";
// biome-ignore lint/style/useImportType: PopoverMenus is used as value (static methods) in template
import { PopoverMenus } from "$lib/modules/editor/PopoverMenus.svelte";
import Button from "$lib/core/ui/Button.svelte";
import ToolbarButton from "$lib/modules/editor/ToolbarButton.svelte";
import { handleEditorImageFiles } from "$lib/modules/files/editor-images";
import InsertPopover from "./popovers/InsertPopover.svelte";
import InsertMarkdownModal from "./InsertMarkdownModal.svelte";

let {
    editor,
    activeFormats,
    menus,
    emojiState,
    currentNoteId,
}: {
    editor: Editor | undefined;
    activeFormats: {
        bold: boolean;
        italic: boolean;
        underline: boolean;
        strike: boolean;
        h1: boolean;
        h2: boolean;
        h3: boolean;
        h4: boolean;
        bulletList: boolean;
        orderedList: boolean;
        taskList: boolean;
        blockquote: boolean;
        codeBlock: boolean;
        code: boolean;
        link: boolean;
        subscript: boolean;
        superscript: boolean;
        table: boolean;
        fontFamily: string;
        fontSize: string;
        textAlign: string;
    };
    menus: PopoverMenus;
    emojiState: EmojiPickerState;
    currentNoteId: string | undefined;
} = $props();

let fileInputEl: HTMLInputElement | undefined = $state(undefined);
let markdownModalOpen = $state(false);

const headingActive = $derived(
    activeFormats.h1 || activeFormats.h2 || activeFormats.h3 || activeFormats.h4,
);
const sizeLabel = $derived(fontSizeDisplayLabel(activeFormats.fontSize));

function onFileChange() {
    if (!fileInputEl || !editor || !currentNoteId) return;
    const files = Array.from(fileInputEl.files ?? []);
    fileInputEl.value = "";
    if (files.length > 0) void handleEditorImageFiles(editor, files, currentNoteId, null);
}
</script>

<!-- ONE mounting point: every other editor popover lives in note/[id]/+page.svelte alongside the
     `menus` instance that holds them. Only those whose state lives in this component are here
     (`markdownModalOpen`) — mounting one twice gives two DOMs on the same anchor and two
     $effects. -->
<InsertPopover {menus} onInsertMarkdown={() => (markdownModalOpen = true)} />
<InsertMarkdownModal bind:open={markdownModalOpen} {editor} />

<!-- It wraps onto several rows at md+ (narrow screens scroll horizontally — see the <style> below).
     The number of rows may depend ONLY on the window's width, never on the cursor's position: the
     labels and the contextual buttons below have space reserved, or the toolbar crosses the wrap
     threshold when the note changes and the whole document jumps. -->
<div class="border-b border-[var(--stroke)] min-h-10 py-1 flex items-center px-2 gap-0.5 flex-nowrap overflow-x-auto md:flex-wrap md:overflow-visible shrink-0 bg-[var(--surface-app)] editor-toolbar">
    <!-- The outline toggle -->
    <ToolbarButton active={outlineStore.visible} title="Toggle outline (headings)" onclick={() => outlineStore.toggle()}><PanelLeft class="w-3.5 h-3.5" /></ToolbarButton>

    <div class="w-px h-4 bg-[var(--surface-raised)] mx-0.5"></div>

    <!-- Headings: Lucide's Heading1 (H1) + ▾ — the level (H2…) is chosen in the popover. -->
    <Button
        variant="ghost"
        active={headingActive}
        class="!h-[1.75rem] !px-1 !py-1 gap-0"
        onmousedown={(e: MouseEvent) => e.preventDefault()}
        onclick={(e) => { e.stopPropagation(); menus.toggle("heading", e.currentTarget as HTMLElement); }}
        title="Headings (Ctrl+Alt+1…4)"
        aria-label="Headings"
        aria-haspopup="listbox"
    >
        <Heading1 class="w-3.5 h-3.5 shrink-0" />
        <ChevronDown class="w-3 h-3 opacity-70 shrink-0" />
    </Button>

    <div class="w-px h-4 bg-[var(--surface-raised)] mx-0.5"></div>

    <!-- The font family: only T + ▾ (like H and size) — the font's name is in the popover. -->
    <Button
        variant="ghost"
        active={!!activeFormats.fontFamily}
        class="!h-[1.75rem] !px-1 !py-1 gap-0"
        onmousedown={(e: MouseEvent) => e.preventDefault()}
        onclick={(e) => { e.stopPropagation(); menus.toggle("fontFamily", e.currentTarget as HTMLElement); }}
        title="Font"
        aria-label="Font"
        aria-haspopup="listbox"
    >
        <Type class="w-3.5 h-3.5 shrink-0" />
        <ChevronDown class="w-3 h-3 opacity-70 shrink-0" />
    </Button>

    <!-- The font size: a number plus ▾; −, the size, and + in a small popover. -->
    <Button
        variant="ghost"
        active={!!activeFormats.fontSize || menus.isOpen("fontSize")}
        class="!h-[1.75rem] !px-1 !py-1 gap-0 text-xs font-medium tabular-nums"
        onmousedown={(e: MouseEvent) => e.preventDefault()}
        onclick={(e) => {
            e.stopPropagation();
            menus.toggle("fontSize", e.currentTarget as HTMLElement);
        }}
        title="Font size"
        aria-label="Font size"
        aria-haspopup="dialog"
        aria-expanded={menus.isOpen("fontSize")}
    >
        <span class="w-5 text-center">{sizeLabel}</span>
        <ChevronDown class="w-3 h-3 opacity-70 shrink-0" />
    </Button>

    <div class="w-px h-4 bg-[var(--surface-raised)] mx-0.5"></div>

    <!-- Inline formatting — the shortcuts are TipTap's defaults (Mod = Ctrl on Win/Linux, ⌘ on Mac) -->
    <ToolbarButton active={activeFormats.bold} title="Bold (Ctrl+B)" onclick={() => editor?.chain().focus().toggleBold().run()}><Bold class="w-3.5 h-3.5" /></ToolbarButton>
    <ToolbarButton active={activeFormats.italic} title="Italic (Ctrl+I)" onclick={() => editor?.chain().focus().toggleItalic().run()}><Italic class="w-3.5 h-3.5" /></ToolbarButton>
    <ToolbarButton active={activeFormats.underline} title="Underline (Ctrl+U)" onclick={() => editor?.chain().focus().toggleUnderline().run()}><UnderlineIcon class="w-3.5 h-3.5" /></ToolbarButton>
    <ToolbarButton active={activeFormats.strike} title="Strikethrough (Ctrl+Shift+S)" onclick={() => editor?.chain().focus().toggleStrike().run()}><Strikethrough class="w-3.5 h-3.5" /></ToolbarButton>
    <ToolbarButton active={activeFormats.superscript} title="Superscript (Ctrl+.)" onclick={() => editor?.chain().focus().toggleSuperscript().run()}><SuperscriptIcon class="w-3.5 h-3.5" /></ToolbarButton>
    <ToolbarButton active={activeFormats.subscript} title="Subscript (Ctrl+,)" onclick={() => editor?.chain().focus().toggleSubscript().run()}><SubscriptIcon class="w-3.5 h-3.5" /></ToolbarButton>
    <ToolbarButton title="Clear Formatting" onclick={() => {
        if (!editor) return;
        editor.chain().focus().unsetAllMarks().clearNodes().command(({ tr, dispatch }) => {
            if (!dispatch) return true;
            
            const { from, to } = tr.selection;
            const positions: {pos: number, type: 'newline'|'hardBreak'}[] = [];
            
            tr.doc.nodesBetween(from, to, (node, pos) => {
                if (node.isBlock) {
                    let childPos = pos + 1;
                    node.forEach((child) => {
                        if (child.isText && child.text?.includes('\n')) {
                            let offset = 0;
                            while (true) {
                                const idx = child.text.indexOf('\n', offset);
                                if (idx === -1) break;
                                positions.push({ pos: childPos + idx, type: 'newline' });
                                offset = idx + 1;
                            }
                        } else if (child.type.name === 'hardBreak') {
                            positions.push({ pos: childPos, type: 'hardBreak' });
                        }
                        childPos += child.nodeSize;
                    });
                }
            });

            positions.sort((a, b) => b.pos - a.pos);
            for (const item of positions) {
                tr.delete(item.pos, item.pos + 1);
                tr.split(item.pos);
            }
            return true;
        }).run();
    }}><RemoveFormatting class="w-3.5 h-3.5" /></ToolbarButton>

    <div class="w-px h-4 bg-[var(--surface-raised)] mx-0.5"></div>

    <!-- The colours -->
    <ToolbarButton title="Text Color" onclick={(e) => { e.stopPropagation(); menus.toggle("color", e.currentTarget as HTMLElement); }}><Palette class="w-3.5 h-3.5" /></ToolbarButton>
    <ToolbarButton title="Highlight" onclick={(e) => { e.stopPropagation(); menus.toggle("highlight", e.currentTarget as HTMLElement); }}><Highlighter class="w-3.5 h-3.5" /></ToolbarButton>

    <div class="w-px h-4 bg-[var(--surface-raised)] mx-0.5"></div>

    <!-- Inline elements and the code block -->
    <ToolbarButton active={activeFormats.code} title="Inline Code (Ctrl+E)" onclick={() => editor?.chain().focus().toggleCode().run()}><Code class="w-3.5 h-3.5" /></ToolbarButton>
    <ToolbarButton active={activeFormats.codeBlock} title="Code Block (Ctrl+Alt+C)" onclick={() => editor?.chain().focus().toggleCodeBlock().run()}><SquareCode class="w-3.5 h-3.5" /></ToolbarButton>

    <div class="w-px h-4 bg-[var(--surface-raised)] mx-0.5"></div>

    <!-- Block elements -->
    <ToolbarButton active={activeFormats.bulletList} title="Bullet List (Ctrl+Shift+8)" onclick={() => editor?.chain().focus().toggleBulletList().run()}><List class="w-3.5 h-3.5" /></ToolbarButton>
    <ToolbarButton active={activeFormats.orderedList} title="Numbered List (Ctrl+Shift+7)" onclick={() => editor?.chain().focus().toggleOrderedList().run()}><ListOrdered class="w-3.5 h-3.5" /></ToolbarButton>
    <ToolbarButton active={activeFormats.taskList} title="Task List (Ctrl+Shift+9)" onclick={() => editor?.chain().focus().toggleTaskList().run()}><ListChecks class="w-3.5 h-3.5" /></ToolbarButton>
    <ToolbarButton active={activeFormats.blockquote} title="Blockquote (Ctrl+Shift+B)" onclick={() => editor?.chain().focus().toggleBlockquote().run()}><Quote class="w-3.5 h-3.5" /></ToolbarButton>

    <div class="w-px h-4 bg-[var(--surface-raised)] mx-0.5"></div>

    <!-- Alignment -->
    <Button
        variant="ghost"
        active={menus.isOpen("textAlign")}
        class="!h-[1.75rem] !px-1 !py-1 gap-0"
        onmousedown={(e: MouseEvent) => e.preventDefault()}
        onclick={(e) => { e.stopPropagation(); menus.toggle("textAlign", e.currentTarget as HTMLElement); }}
        title="Text Alignment"
    >
        {#if activeFormats.textAlign === 'center'}
            <AlignCenter class="w-3.5 h-3.5 shrink-0" />
        {:else if activeFormats.textAlign === 'right'}
            <AlignRight class="w-3.5 h-3.5 shrink-0" />
        {:else if activeFormats.textAlign === 'justify'}
            <AlignJustify class="w-3.5 h-3.5 shrink-0" />
        {:else}
            <AlignLeft class="w-3.5 h-3.5 shrink-0" />
        {/if}
        <ChevronDown class="w-3 h-3 opacity-70 shrink-0" />
    </Button>

    <div class="w-px h-4 bg-[var(--surface-raised)] mx-0.5"></div>

    <!-- Insert -->
    <ToolbarButton active={menus.isOpen('image')} title="Insert Image" onclick={(e) => { e.stopPropagation(); menus.toggle("image", e.currentTarget as HTMLElement); }}><ImageIcon class="w-3.5 h-3.5" /></ToolbarButton>
    <ToolbarButton active={activeFormats.link || menus.isOpen('link')} title="Link (URL or link to note)" onclick={(e) => { e.stopPropagation(); menus.toggle("link", e.currentTarget as HTMLElement); }}><Link2 class="w-3.5 h-3.5" /></ToolbarButton>
    <ToolbarButton title="Upload File" onclick={() => fileInputEl?.click()}><Paperclip class="w-3.5 h-3.5" /></ToolbarButton>
    <ToolbarButton
        title="Insert Table"
        onclick={(e) => { e.stopPropagation(); menus.toggle("tablePicker", e.currentTarget as HTMLElement); }}
    >
        <TableIcon class="w-3.5 h-3.5" />
    </ToolbarButton>
    <!-- Contextual (inside a table only), but it always takes up its place: `invisible` hides it
         and out of the tab order without changing the toolbar's width. -->
    <Button
        variant="ghost"
        active={activeFormats.table}
        class="!h-[1.75rem] !px-2 !py-1 gap-0.5 text-xs font-medium {activeFormats.table ? '' : 'invisible'}"
        onmousedown={(e: MouseEvent) => e.preventDefault()}
        onclick={(e) => { e.stopPropagation(); menus.toggle("table", e.currentTarget as HTMLElement); }}
        title="Table options"
    >
        Table <ChevronDown class="w-3 h-3" />
    </Button>
    <ToolbarButton title="Divider" onclick={() => editor?.chain().focus().setHorizontalRule().run()}><Minus class="w-3.5 h-3.5" /></ToolbarButton>
    <ToolbarButton
        title="Insert Emoji"
        onclick={(e) => {
            e.stopPropagation();
            if (!menus.isOpen("emoji")) emojiState.load();
            menus.toggle("emoji", e.currentTarget as HTMLElement);
        }}
    ><Smile class="w-3.5 h-3.5" /></ToolbarButton>
    <ToolbarButton
        title="Import / Insert"
        onclick={(e) => { e.stopPropagation(); menus.toggle("insert", e.currentTarget as HTMLElement); }}
    ><Import class="w-3.5 h-3.5" /></ToolbarButton>

    <div class="flex-1"></div>
    <ToolbarButton title="Undo (Ctrl+Z)" onclick={() => editor?.chain().focus().undo().run()}><Undo2 class="w-3.5 h-3.5" /></ToolbarButton>
    <ToolbarButton title="Redo (Ctrl+Y)" onclick={() => editor?.chain().focus().redo().run()}><Redo2 class="w-3.5 h-3.5" /></ToolbarButton>

    <div class="w-px h-4 bg-[var(--surface-raised)] mx-0.5"></div>

    <ToolbarButton
        title="Keyboard Shortcuts"
        onclick={(e) => { e.stopPropagation(); menus.toggle("shortcuts", e.currentTarget as HTMLElement); }}
    ><Keyboard class="w-3.5 h-3.5" /></ToolbarButton>
</div>

<input type="file" multiple bind:this={fileInputEl} onchange={onFileChange} class="hidden" />

<style>
    /* Below md: one row that scrolls horizontally — wrapping there used to eat up to a third
       of the screen's height with formatting tools. At md+ it wraps normally. */
    .editor-toolbar > :global(*) {
        flex-shrink: 0;
    }
</style>
