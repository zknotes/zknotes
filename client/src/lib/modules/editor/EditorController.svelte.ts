import MathExtension from "@aarkue/tiptap-math-extension";
import { Editor } from "@tiptap/core";
import Color from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import Link from "@tiptap/extension-link";
import Mention from "@tiptap/extension-mention";
import Placeholder from "@tiptap/extension-placeholder";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import TextAlign from "@tiptap/extension-text-align";
import { FontFamily, FontSize, TextStyle } from "@tiptap/extension-text-style";
import Underline from "@tiptap/extension-underline";
import { EditorState, Selection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import "katex/dist/katex.min.css";
import { mount, unmount, untrack } from "svelte";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { goto } from "$app/navigation";
import type { DecryptedItemMeta } from "$lib/core/data/items";
import { devLog } from "$lib/core/utils/dev-log";
import { handleEditorImageFiles } from "$lib/modules/files/editor-images";
import {
    rewriteDataImagesInHtml,
    stagePromotedImages,
} from "$lib/modules/files/promote-inline-images";
import { extractFileRefs, replaceHugeDataImageTags } from "$lib/modules/files/refs";
import type { NoteAutosave } from "$lib/modules/notes/NoteAutosave.svelte";
import {
    applyEmptySpaceFocus,
    emptySpaceFocusFromY,
    visualEdgeRect,
} from "./editor-empty-space-click";
import { EncFile } from "./encrypted-file/enc-file-node";
import { applyTableWidths, Table, ZkTableView } from "./extensions/table";
import { TableRow } from "./extensions/table-row";
import { ImageResize } from "./image-resize";
import NoteMentionsList from "./NoteMentionsList.svelte";
import { filterLinkableNotes } from "./note-mentions";
import { type PopoverMenus, TABLE_MENU_IDS } from "./PopoverMenus.svelte";
import {
    changedBlockRanges,
    SyncHighlight,
    syncHighlightKey,
    topBlockTexts,
} from "./sync-highlight";
import type { TableUiController } from "./TableUiController.svelte";

// How long changed blocks stay highlighted — it has to follow the `.sync-flash-highlight` CSS animation.
const SYNC_FLASH_MS = 2400;

const CustomMention = Mention.extend({
    addAttributes() {
        return {
            ...this.parent?.(),
            isBroken: {
                default: false,
                parseHTML: (element) => element.getAttribute("data-broken") === "true",
                renderHTML: (attributes) => {
                    if (!attributes.isBroken) return {};
                    return { "data-broken": "true" };
                },
            },
        };
    },
    parseHTML() {
        return [
            { tag: `a[data-type="${this.name}"]`, priority: 100 },
            { tag: `span[data-type="${this.name}"]`, priority: 100 },
            { tag: `a[data-note-id]`, priority: 100 },
        ];
    },
});

export interface EditorControllerOpts {
    menus: PopoverMenus;
    tableUi: TableUiController;
    autosave: NoteAutosave;
    getCurrentNoteId: () => string | undefined;
    /**
     * true while a switch to another note is under way (the old one is still being flushed under ITS
     * OWN id). While it is true, the teardown must not flush by itself — `getCurrentNoteId()` already
     * points at the new note, while the editor still holds the old one's content.
     */
    isSwitchInFlight?: () => boolean;
    getAttachmentFiles: () => DecryptedItemMeta[];
    getItems?: () => DecryptedItemMeta[];
    onUpdate: () => void;
    onFileError: (msg: string) => void;
    // Called whenever an editor instance is created or destroyed.
    // Used to keep a reactive variable in sync without circular dependencies.
    onInstanceChange: (e: Editor | undefined) => void;
}

export class EditorController {
    instance = $state<Editor | undefined>(undefined);

    activeFormats = $state({
        bold: false,
        italic: false,
        underline: false,
        strike: false,
        h1: false,
        h2: false,
        h3: false,
        h4: false,
        bulletList: false,
        orderedList: false,
        taskList: false,
        blockquote: false,
        codeBlock: false,
        code: false,
        link: false,
        subscript: false,
        superscript: false,
        table: false,
        fontFamily: "",
        fontSize: "",
        color: "",
        highlightColor: "",
        textAlign: "left",
    });

    // Set to true around editor.commands.setContent() to suppress the dirty marking.
    isProgrammaticUpdate = false;

    #syncFlashTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(private opts: EditorControllerOpts) {}

    // Load the note's content and CLEAR the undo/redo history.
    // TipTap's setContent leaves the undo/redo stack alone, so without this reset a redo after
    // switching to another note brings back steps from the previous one (a cross-note leak).
    // EditorState.create reinitialises the plugins (the undo/redo history included) from the new
    // doc, which clears the stack without destroying the editor instance.
    //
    // `highlightChanges`: when content arrives from another device (a pull, not the first
    // navigation), briefly highlight the changed blocks so the user sees at once what changed.
    loadContent(content: string, highlightChanges = false): void {
        const editor = this.instance;
        if (!editor || editor.isDestroyed) return;
        // Capture the blocks' text BEFORE the replacement — a diff against the new blocks says what to highlight.
        const beforeTexts = highlightChanges ? topBlockTexts(editor.state.doc) : null;
        // An external update (a pull) arrives while the user is reading or editing the same note —
        // remember where the cursor is, so EditorState.create (which resets the selection to the start
        // of the doc) does not throw it to the top. On the first navigation (highlightChanges=false)
        // resetting to the start is CORRECT.
        const prevSelection = highlightChanges ? editor.state.selection.from : null;
        this.isProgrammaticUpdate = true;
        try {
            editor.commands.setContent(content);
            const freshState = EditorState.create({
                doc: editor.state.doc,
                plugins: editor.state.plugins,
                schema: editor.schema,
            });
            editor.view.updateState(freshState);
            if (prevSelection !== null) this.#restoreSelection(editor, prevSelection);
        } finally {
            // It HAS to be finally: if setContent/EditorState.create throws, the flag would stay true
            // for the rest of the instance's life → onUpdate skips markDirty forever (silent data loss).
            this.isProgrammaticUpdate = false;
        }
        if (beforeTexts) this.#flashChangedBlocks(editor, beforeTexts);
    }

    // Return the cursor to its (clamped) previous position after the content is replaced.
    // Selection.near finds the nearest VALID position — after a pull the doc may be shorter, or that
    // position may hold an atom node (an encFile or a table) where a TextSelection is not allowed.
    #restoreSelection(editor: Editor, from: number): void {
        try {
            const size = editor.state.doc.content.size;
            const target = editor.state.doc.resolve(Math.min(from, size));
            const tr = editor.state.tr.setSelection(Selection.near(target));
            tr.setMeta("addToHistory", false);
            editor.view.dispatch(tr);
        } catch (_) {
            // An invalid position in the new doc — leave the default (the start).
        }
    }

    // Highlight the changed blocks through the decoration plugin (it touches neither the doc, nor
    // dirty, nor undo) and clear them after SYNC_FLASH_MS. The updateState above already
    // reinitialised the plugin (DecorationSet.empty), so the decorations are applied only now, onto a
    // fresh state.
    #flashChangedBlocks(editor: Editor, beforeTexts: string[]): void {
        const ranges = changedBlockRanges(editor.state.doc, beforeTexts);
        if (ranges.length === 0) return;
        const decos = ranges.map(([from, to]) =>
            Decoration.inline(from, to, { class: "sync-flash-highlight" }),
        );
        const set = DecorationSet.create(editor.state.doc, decos);
        const tr = editor.state.tr.setMeta(syncHighlightKey, { decorations: set });
        tr.setMeta("addToHistory", false);
        editor.view.dispatch(tr);

        clearTimeout(this.#syncFlashTimer);
        this.#syncFlashTimer = setTimeout(() => {
            const e = this.instance;
            if (!e || e.isDestroyed) return;
            const clearTr = e.state.tr.setMeta(syncHighlightKey, {
                decorations: DecorationSet.empty,
            });
            clearTr.setMeta("addToHistory", false);
            e.view.dispatch(clearTr);
        }, SYNC_FLASH_MS);
    }

    // A Svelte action — use it as `use:editorCtrl.attach` on the prose container div.
    // An arrow function, so `this` is always the class instance when Svelte calls it.
    attach = (node: HTMLElement): { destroy(): void } => {
        const {
            menus,
            tableUi,
            autosave,
            getCurrentNoteId,
            getAttachmentFiles,
            getItems,
            onUpdate,
            onFileError,
        } = this.opts;

        this.instance = new Editor({
            element: node,
            extensions: [
                // StarterKit v3 already bundles Link and Underline; disable them here so the standalone
                // configured versions below do not register duplicate names.
                StarterKit.configure({ link: false, underline: false }),
                SyncHighlight,
                TextStyle,
                FontFamily,
                FontSize,
                Color,
                Underline,
                Highlight.configure({ multicolor: true }),
                Link.configure({
                    openOnClick: false,
                    autolink: true,
                    HTMLAttributes: { rel: "noopener" },
                }),
                ImageResize.configure({ inline: false, allowBase64: true }),
                EncFile,
                TextAlign.configure({ types: ["heading", "paragraph", "encFile"] }),
                TaskList,
                TaskItem.configure({ nested: true }),
                Subscript,
                Superscript,
                // `resizable: false` turns off the built-in `columnResizing` — our own
                // control layer takes over the column boundaries so the resize is `preservetable`.
                // TableView (and with it `.tableWrapper` and `<colgroup>`) stays: `addNodeView` returns
                // it precisely when resizable is NOT enabled.
                Table.configure({ resizable: false, View: ZkTableView }),
                TableRow,
                TableHeader,
                TableCell,
                MathExtension.configure({ evaluation: false }),
                Placeholder.configure({
                    placeholder: "Write something… Type @ to link another note",
                }),
                CustomMention.configure({
                    HTMLAttributes: {
                        class: "note-link",
                    },
                    renderHTML({ options, node }) {
                        const isBroken = node.attrs.isBroken;
                        const baseClass = options.HTMLAttributes.class || "note-link";
                        return [
                            "a",
                            {
                                href: isBroken ? undefined : `/note/${node.attrs.id}`,
                                "data-type": "mention",
                                "data-id": node.attrs.id,
                                "data-label": node.attrs.label,
                                "data-note-id": node.attrs.id,
                                "data-broken": isBroken ? "true" : undefined,
                                class: isBroken ? `${baseClass} broken-note-link` : baseClass,
                                contenteditable: "false",
                            },
                            `@${node.attrs.label ?? node.attrs.id}`,
                        ];
                    },
                    suggestion: {
                        char: "@",
                        items: ({ query }) => {
                            const all = getItems ? getItems() : [];
                            return filterLinkableNotes(all, getCurrentNoteId(), query);
                        },
                        render: () => {
                            type MentionListItem = {
                                id: string;
                                title: string;
                                icon?: string;
                                color?: string;
                            };
                            let component:
                                | { onKeyDown?: (props: { event: KeyboardEvent }) => boolean }
                                | undefined;
                            let popup: TippyInstance | undefined;
                            const props = $state({
                                items: [] as MentionListItem[],
                                command: ((_item: { id: string; label: string }) => {}) as (item: {
                                    id: string;
                                    label: string;
                                }) => void,
                            });

                            return {
                                onStart: (propsData) => {
                                    const container = document.createElement("div");
                                    props.items = propsData.items;
                                    props.command = propsData.command;

                                    component = mount(NoteMentionsList, {
                                        target: container,
                                        props: props,
                                    });

                                    if (!propsData.clientRect) return;

                                    popup = tippy(document.body, {
                                        getReferenceClientRect:
                                            propsData.clientRect as () => DOMRect,
                                        appendTo: () => document.body,
                                        content: container,
                                        showOnCreate: true,
                                        interactive: true,
                                        trigger: "manual",
                                        placement: "bottom-start",
                                    });
                                },
                                onUpdate: (propsData) => {
                                    props.items = propsData.items;
                                    props.command = propsData.command;

                                    if (!propsData.clientRect) return;

                                    popup?.setProps({
                                        getReferenceClientRect:
                                            propsData.clientRect as () => DOMRect,
                                    });
                                },
                                onKeyDown: (propsData) => {
                                    if (propsData.event.key === "Escape") {
                                        popup?.hide();
                                        return true;
                                    }
                                    return (
                                        component?.onKeyDown?.({ event: propsData.event }) ?? false
                                    );
                                },
                                onExit: () => {
                                    if (popup && !popup.state.isDestroyed) {
                                        popup.destroy();
                                    }
                                    popup = undefined;
                                    if (component) {
                                        unmount(component);
                                        component = undefined;
                                    }
                                },
                            };
                        },
                    },
                }),
            ],
            editorProps: {
                attributes: {
                    class: "prose prose-sm sm:prose-base dark:prose-invert focus:outline-none max-w-none",
                },
                handleDOMEvents: {
                    // Internal note links (/note/…) navigate in the app (Ctrl/Cmd+click: a new tab);
                    // Ctrl/Cmd+click on any other link opens it in a new tab (the usual editor
                    // behaviour). Mention nodes are handled by handleClickOn.
                    click: (_view, event) => {
                        const me = event as MouseEvent;
                        const anchor = (me.target as HTMLElement | null)?.closest("a");
                        const href = anchor?.getAttribute("href");

                        if (href && href.startsWith("/note/")) {
                            // The link text is a title suggestion for creating a missing note. It
                            // travels in history state, never in the URL: a URL ends up in server
                            // access logs and in the Referer header of later requests.
                            if (me.ctrlKey || me.metaKey) {
                                // A new tab cannot carry history state, so it gets the bare href.
                                me.preventDefault();
                                window.open(href, "_blank", "noopener,noreferrer");
                                return true;
                            } else {
                                const text = anchor?.textContent?.trim() || "Untitled";
                                me.preventDefault();
                                void goto(href, { state: { linkTitle: text } });
                                return true;
                            }
                        }

                        if (!me.ctrlKey && !me.metaKey) return false;
                        if (!href) return false;
                        me.preventDefault();
                        window.open(href, "_blank", "noopener,noreferrer");
                        return true;
                    },
                    // ProseMirror checks editorProps before the plugins' handleDOMEvents, so this
                    // fires before TipTap's pasteRulesPlugin drop handler. That plugin has a 10 ms
                    // setTimeout calling `dragFromOtherEditor.commands.deleteRange()` whenever it
                    // believes a cross-editor drag happened. For OS file drops (Nautilus, Finder)
                    // The module-level `tiptapDragFromOtherEditor` may still be set from a previous
                    // in-editor drag, so the timeout crashes if the editor has been destroyed by then.
                    // Dispatching a synthetic dragend clears that variable synchronously, before the
                    // paste-rules handler reads it.
                    drop: (_view, event) => {
                        if ((event as DragEvent).dataTransfer?.files.length) {
                            window.dispatchEvent(new DragEvent("dragend"));
                        }
                        return false; // let handleDrop and the other handlers carry on
                    },
                    // The bare ProseMirror root (an image's margin, the gap between blocks, the space
                    // to the right of a narrow table). The default posAtCoords often gets it wrong — a
                    // teleport to the end, or nothing at all. We fix that: (1) above or below the
                    // content → start/end (an empty line plus the cursor before the first image),
                    // (2) to the right of a table → the cell.
                    mousedown: (view, event) => {
                        const me = event as MouseEvent;
                        // `.tableWrapper` (overflow-x:auto → a new block formatting context) absorbs
                        // the table's own `margin: 1.2em 0` into ITS OWN rect instead of collapsing it
                        // outwards, so a click in that "empty" zone above or below the table lands on
                        // the wrapper rather than on `view.dom` — hence containment rather than
                        // identity.
                        if (!view.dom.contains(me.target as Node)) return false;
                        if (!this.instance) return false;

                        const first = view.dom.firstElementChild as HTMLElement | null;
                        const last = view.dom.lastElementChild as HTMLElement | null;
                        if (first && last) {
                            const edge = emptySpaceFocusFromY(
                                me.clientY,
                                visualEdgeRect(first).top,
                                visualEdgeRect(last).bottom,
                            );
                            if (edge) {
                                me.preventDefault();
                                applyEmptySpaceFocus(this.instance, edge);
                                return true;
                            }
                        }

                        const wrappers = view.dom.querySelectorAll<HTMLElement>(".tableWrapper");
                        for (const w of wrappers) {
                            const r = w.getBoundingClientRect();
                            if (
                                me.clientY < r.top ||
                                me.clientY > r.bottom ||
                                me.clientX <= r.right
                            ) {
                                continue;
                            }
                            const inside = view.posAtCoords({
                                left: r.right - 8,
                                top: me.clientY,
                            });
                            if (!inside) continue;
                            me.preventDefault();
                            this.instance.chain().setTextSelection(inside.pos).focus().run();
                            return true;
                        }
                        return false;
                    },
                },
                handleClickOn: (_view, _pos, node, _nodePos, event, _direct) => {
                    if (node.type.name === "mention") {
                        const noteId = node.attrs.id;
                        const label = node.attrs.label || "Untitled";
                        if (noteId) {
                            if (node.attrs.isBroken) {
                                event.preventDefault();
                                return true;
                            }
                            event.preventDefault();
                            // The label travels in history state, never in the URL (access logs,
                            // Referer headers).
                            void goto(`/note/${noteId}`, { state: { linkTitle: label } });
                            return true;
                        }
                    }
                    return false;
                },
                // Images go into a note as encrypted file attachments, never as base64. An HTML
                // paste may carry several data:image entries: take all of them, and keep the text
                // (not only the first image).
                handlePaste: (_view, event) => {
                    // With no note id there is nowhere to upload to (a file has to get a parent
                    // note) — an early return rather than a non-null assertion that would pass
                    // `undefined` further down.
                    const noteId = getCurrentNoteId();
                    const files = Array.from((event as ClipboardEvent).clipboardData?.files ?? []);
                    if (files.length > 0) {
                        if (!noteId) return false;
                        if (this.instance)
                            void handleEditorImageFiles(this.instance, files, noteId, null);
                        return true;
                    }
                    const html =
                        (event as ClipboardEvent).clipboardData?.getData("text/html") ?? "";
                    // Multi data:image → sync rewrite + huge safety net, then an async stage.
                    if (html.includes("data:image") && this.instance && noteId) {
                        const { html: rewritten, jobs } = rewriteDataImagesInHtml(html);
                        const safe = replaceHugeDataImageTags(rewritten);
                        this.instance.chain().focus().insertContent(safe).run();
                        if (jobs.length > 0) {
                            void stagePromotedImages(this.instance, jobs, noteId, null);
                        }
                        return true;
                    }
                    // Block pasting any in-app encFile node (copying files is not supported).
                    if (html) {
                        const pastedIds = extractFileRefs(html);
                        if (pastedIds.length > 0) {
                            const ownedIds = new Set(getAttachmentFiles().map((f) => f.id));
                            if (pastedIds.some((id) => !ownedIds.has(id))) {
                                onFileError("Copying files isn't supported — use Move instead.");
                                return true;
                            }
                        }
                    }
                    return false;
                },
                handleDrop: (_view, event, _slice, _moved) => {
                    const dragEvent = event as DragEvent;

                    // Nested tables are structurally ALLOWED by the schema (the tableCell/tableHeader
                    // content is "block+", and a table carries the group "block") — reshaping the
                    // schema to forbid that would touch doc/blockquote/listItem content everywhere.
                    // Instead: while the grip moves the WHOLE table (`view.dragging.node` is a
                    // NodeSelection over the table node — only this one place sets that, in
                    // `TableUiController.onDragStart`),
                    // reject any drop whose target lies inside a table.
                    const dragging = _view.dragging as
                        | { node?: { node?: { type?: { name?: string } } } }
                        | null
                        | undefined;
                    if (dragging?.node?.node?.type?.name === "table") {
                        const pos = _view.posAtCoords({
                            left: dragEvent.clientX,
                            top: dragEvent.clientY,
                        });
                        if (pos) {
                            const resolved = _view.state.doc.resolve(pos.pos);
                            let insideTable = false;
                            for (let d = resolved.depth; d > 0; d--) {
                                if (resolved.node(d).type.name === "table") {
                                    insideTable = true;
                                    break;
                                }
                            }
                            if (insideTable) {
                                event.preventDefault();
                                return true;
                            }
                        }
                    }

                    const all = getItems ? getItems() : [];

                    const noteId = dragEvent.dataTransfer?.getData("application/x-note-id");
                    if (noteId) {
                        event.preventDefault();
                        const note = all.find((n) => n.id === noteId);
                        const label = note?.title ?? noteId;
                        const pos = _view.posAtCoords({
                            left: dragEvent.clientX,
                            top: dragEvent.clientY,
                        });
                        if (this.instance && pos) {
                            this.instance
                                .chain()
                                .focus()
                                .insertContentAt(pos.pos, {
                                    type: "mention",
                                    attrs: { id: noteId, label },
                                })
                                .run();
                        }
                        return true;
                    }

                    const folderId = dragEvent.dataTransfer?.getData("application/x-folder-id");
                    if (folderId) {
                        event.preventDefault();
                        const folder = all.find((n) => n.id === folderId);
                        const childNotes = all.filter(
                            (n) => n.type === "note" && n.parent_id === folderId,
                        );
                        if (childNotes.length === 0) {
                            onFileError("That folder has no notes to link.");
                            return true;
                        }
                        const pos = _view.posAtCoords({
                            left: dragEvent.clientX,
                            top: dragEvent.clientY,
                        });
                        if (this.instance && pos) {
                            this.instance
                                .chain()
                                .focus()
                                .insertContentAt(pos.pos, [
                                    {
                                        type: "heading",
                                        attrs: { level: 3 },
                                        content: [
                                            { type: "text", text: folder?.title ?? folderId },
                                        ],
                                    },
                                    {
                                        type: "bulletList",
                                        content: childNotes.map((n) => ({
                                            type: "listItem",
                                            content: [
                                                {
                                                    type: "paragraph",
                                                    content: [
                                                        {
                                                            type: "mention",
                                                            attrs: { id: n.id, label: n.title },
                                                        },
                                                    ],
                                                },
                                            ],
                                        })),
                                    },
                                ])
                                .run();
                        }
                        return true;
                    }
                    const files = Array.from(dragEvent.dataTransfer?.files ?? []);
                    if (files.length === 0) return false;
                    // See handlePaste: with no note id an upload has no parent — let the default handling run.
                    const currentNoteId = getCurrentNoteId();
                    if (!currentNoteId) return false;
                    devLog(
                        "upload",
                        "handleDrop: received",
                        files.length,
                        "file(s):",
                        files.map((f) => f.name),
                    );
                    event.preventDefault();
                    if (this.instance)
                        void handleEditorImageFiles(this.instance, files, currentNoteId, null);
                    return true;
                },
            },
            onCreate: ({ editor: e }) => {
                if (!tableUi.isResizing) applyTableWidths(e);
            },
            onUpdate: ({ editor: e, transaction }) => {
                // Table widths: only when the doc really changed (not selection-only) and
                // there is at least one table — otherwise the O(n) walk on every keystroke is
                // wasted.
                if (transaction.docChanged) {
                    if (!tableUi.isResizing) applyTableWidths(e);
                }
                // Hide the floating table controls if their table has just been deleted (untrack: this
                // runs inside a ProseMirror dispatch — see onTransaction below).
                untrack(() => tableUi.revalidateActive());
                // The attachments strip: a debounced doc walk on the note page (not getHTML).
                onUpdate();
                if (this.isProgrammaticUpdate) return;
                autosave.markDirty();
            },
            onTransaction: ({ editor: e }) => {
                // untrack: TipTap fires this inside a ProseMirror dispatch, which Svelte 5 may
                // detect as a reactive tracking context — mutating $state here without untrack throws
                // state_unsafe_mutation.
                untrack(() => {
                    this.activeFormats.bold = e.isActive("bold");
                    this.activeFormats.italic = e.isActive("italic");
                    this.activeFormats.underline = e.isActive("underline");
                    this.activeFormats.strike = e.isActive("strike");
                    this.activeFormats.h1 = e.isActive("heading", { level: 1 });
                    this.activeFormats.h2 = e.isActive("heading", { level: 2 });
                    this.activeFormats.h3 = e.isActive("heading", { level: 3 });
                    this.activeFormats.h4 = e.isActive("heading", { level: 4 });
                    this.activeFormats.bulletList = e.isActive("bulletList");
                    this.activeFormats.orderedList = e.isActive("orderedList");
                    this.activeFormats.taskList = e.isActive("taskList");
                    this.activeFormats.blockquote = e.isActive("blockquote");
                    this.activeFormats.codeBlock = e.isActive("codeBlock");
                    this.activeFormats.code = e.isActive("code");
                    this.activeFormats.link = e.isActive("link");
                    this.activeFormats.subscript = e.isActive("subscript");
                    this.activeFormats.superscript = e.isActive("superscript");
                    this.activeFormats.table = e.isActive("table");
                    const textStyle = e.getAttributes("textStyle");
                    this.activeFormats.fontFamily = (textStyle.fontFamily as string) ?? "";
                    this.activeFormats.fontSize = (textStyle.fontSize as string) ?? "";
                    this.activeFormats.color = (textStyle.color as string) ?? "";
                    this.activeFormats.highlightColor =
                        (e.getAttributes("highlight").color as string) ?? "";
                    this.activeFormats.textAlign = e.isActive({ textAlign: "center" })
                        ? "center"
                        : e.isActive({ textAlign: "right" })
                          ? "right"
                          : e.isActive({ textAlign: "justify" })
                            ? "justify"
                            : "left";
                    if (!this.activeFormats.table) {
                        for (const id of TABLE_MENU_IDS) menus.close(id);
                    }
                    tableUi.syncSelection(e);
                });
            },
        });

        this.opts.onInstanceChange(this.instance);

        const cleanupTableListeners = tableUi.attachListeners();

        return {
            destroy: () => {
                const noteId = getCurrentNoteId();
                // The editor is ONE shared instance; on a switch getCurrentNoteId() already points at
                // the NEW note while editor.getHTML() still returns the OLD one's content. A flush in
                // that window would save the wrong content under this id — the same reason +page.svelte
                // gates every save path on `switchFlushInFlight`. The old note is flushed by
                // autosave.onNoteSwitch().
                if (noteId && !this.opts.isSwitchInFlight?.()) autosave.flush(noteId);
                autosave.cancelAutosave();
                clearTimeout(this.#syncFlashTimer);
                this.#syncFlashTimer = undefined;
                cleanupTableListeners();
                this.instance?.destroy();
                this.instance = undefined;
                this.#resetActiveFormats();
                this.opts.onInstanceChange(undefined);
            },
        };
    };

    // onTransaction does not fire after the teardown, so the toolbar would keep its active states (bold, heading,
    // table) from the previous context until the user clicks into the new document.
    #resetActiveFormats(): void {
        for (const key of Object.keys(this.activeFormats) as Array<
            keyof typeof this.activeFormats
        >) {
            const current = this.activeFormats[key];
            if (typeof current === "boolean") (this.activeFormats[key] as boolean) = false;
            else (this.activeFormats[key] as string) = "";
        }
    }

    // Patches mention nodes whose stored label no longer matches the note's current title.
    // Returns true when at least one label was updated (the caller can react).
    //
    // This is a PROGRAMMATIC write — triggered by someone else's titles changing (the treeItems
    // query), not by the user:
    //  - `addToHistory: false` → Ctrl+Z does not undo the label sync instead of the user's own edit
    //  - `isProgrammaticUpdate` → the note is not marked "unsaved" (and beforeunload does not ask for
    //    confirmation) merely because a mentioned note was renamed elsewhere
    // The new HTML still reaches disk on the next real save (getHTML reads the live doc).
    syncMentionLabels(notes: DecryptedItemMeta[]): boolean {
        const editor = this.instance;
        if (!editor) return false;
        const byId = new Map(notes.map((n) => [n.id, n.title]));
        let changed = false;
        const tr = editor.state.tr;
        editor.state.doc.descendants((node, pos) => {
            if (node.type.name !== "mention") return true;
            const fresh = byId.get(node.attrs.id as string);
            if (fresh !== undefined) {
                if (fresh !== node.attrs.label || node.attrs.isBroken) {
                    tr.setNodeMarkup(pos, undefined, {
                        ...node.attrs,
                        label: fresh,
                        isBroken: false,
                    });
                    changed = true;
                }
            } else {
                if (!node.attrs.isBroken) {
                    tr.setNodeMarkup(pos, undefined, { ...node.attrs, isBroken: true });
                    changed = true;
                }
            }
            return true;
        });
        if (changed) {
            tr.setMeta("addToHistory", false);
            this.isProgrammaticUpdate = true;
            try {
                editor.view.dispatch(tr);
            } finally {
                this.isProgrammaticUpdate = false;
            }
        }
        return changed;
    }
}
