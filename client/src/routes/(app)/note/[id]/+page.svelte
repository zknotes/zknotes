<script lang="ts">
import { createQuery, keepPreviousData, useQueryClient } from "@tanstack/svelte-query";
import { PenLine, RefreshCw } from "lucide-svelte";
import { untrack } from "svelte";
import { beforeNavigate, goto } from "$app/navigation";
import { page } from "$app/state";
import { APP_EVENTS } from "$lib/core/constants/events";
import { QUERY_KEYS } from "$lib/core/constants/query-keys";
import { treeItemsQueryOptions } from "$lib/core/data/item-queries";
import type { DecryptedItemMeta } from "$lib/core/data/items";
import { ItemService } from "$lib/core/services/item-service";
import { recentNotesStore } from "$lib/core/stores/recent-notes.svelte";
import Button from "$lib/core/ui/Button.svelte";
import Toast from "$lib/core/ui/Toast.svelte";
import { globalToasts } from "$lib/core/stores/toast.svelte";
import { devLog } from "$lib/core/utils/dev-log";
import { devNoteDebugStore } from "$lib/core/ui/dev/dev-store.svelte";
import {
    loadPersisted,
    rawStringSerde,
    savePersisted,
    STORAGE_KEYS,
} from "$lib/core/utils/persisted";
import { buildBreadcrumb } from "$lib/core/utils/tree";
import { EditorController } from "$lib/modules/editor/EditorController.svelte";
import { handleEmptySpacePointer } from "$lib/modules/editor/editor-empty-space-click";
import EditorHeader from "$lib/modules/editor/EditorHeader.svelte";
import EditorOutline from "$lib/modules/editor/EditorOutline.svelte";
import EditorToolbar from "$lib/modules/editor/EditorToolbar.svelte";
import { EmojiPickerState } from "$lib/modules/editor/EmojiPickerState.svelte";
import { PopoverMenus } from "$lib/modules/editor/PopoverMenus.svelte";
import ColorPopover from "$lib/modules/editor/popovers/ColorPopover.svelte";
import EmojiPickerPopover from "$lib/modules/editor/popovers/EmojiPickerPopover.svelte";
import FontFamilyPopover from "$lib/modules/editor/popovers/FontFamilyPopover.svelte";
import FontSizePopover from "$lib/modules/editor/popovers/FontSizePopover.svelte";
import HeadingPopover from "$lib/modules/editor/popovers/HeadingPopover.svelte";
import HighlightPopover from "$lib/modules/editor/popovers/HighlightPopover.svelte";
import ImagePopover from "$lib/modules/editor/popovers/ImagePopover.svelte";
import LinkPopover from "$lib/modules/editor/popovers/LinkPopover.svelte";
import ShortcutsPopover from "$lib/modules/editor/popovers/ShortcutsPopover.svelte";
import TableMenu from "$lib/modules/editor/popovers/TableMenu.svelte";
import TablePicker from "$lib/modules/editor/popovers/TablePicker.svelte";
import TextAlignPopover from "$lib/modules/editor/popovers/TextAlignPopover.svelte";
import TableControls from "$lib/modules/editor/TableControls.svelte";
import TablePropertiesDialog from "$lib/modules/editor/TablePropertiesDialog.svelte";
import { TableUiController } from "$lib/modules/editor/TableUiController.svelte";
import CropModal from "$lib/modules/files/CropModal.svelte";
import {
    insertAndStartUpload,
    insertAndStartUploads,
    preparePendingUpload,
    resumePendingUploads,
} from "$lib/modules/files/editor-images";
import FileDetailPanel from "$lib/modules/files/FileDetailPanel.svelte";
import { NoteFileEvents } from "$lib/modules/files/NoteFileEvents.svelte";
import { pendingTrashManager } from "$lib/modules/files/pending-trash";
import {
    cancelPromoteForNote,
    promoteRemoteImagesInEditor,
    rewriteDataImagesInHtml,
    stagePromotedImages,
} from "$lib/modules/files/promote-inline-images";
import {
    countInlineExternalImages,
    countInlineExternalImagesFromDoc,
    extractFileRefsFromDoc,
    mergeAttachmentFileIds,
    replaceHugeDataImageTags,
} from "$lib/modules/files/refs";
import { swapFileId } from "$lib/modules/files/upload-manager";
import HistoryPanel from "$lib/modules/notes/HistoryPanel.svelte";
import { NoteAutosave } from "$lib/modules/notes/NoteAutosave.svelte";
import ShareDialog from "$lib/modules/share/ShareDialog.svelte";

let editor = $state<import("@tiptap/core").Editor | undefined>(undefined);
let proseScrollEl = $state<HTMLElement | undefined>(undefined);
let currentNoteId = $state(page.params.id);
let resumedForNote: string | undefined; // guards the one-shot pending-upload resume per note
const menus = new PopoverMenus();
const emojiState = new EmojiPickerState();
const fileEvents = new NoteFileEvents();
const tableUi = new TableUiController(
    menus,
    () => editor,
    () => proseScrollEl,
);

let isTogglingStar = $state(false);
let showHistory = $state(false);
let shareDialogOpen = $state(false);

// The sync flash banner — shown briefly when content arrives from another device (a pull).
let syncFlash = $state(false);
let syncFlashTimer: ReturnType<typeof setTimeout> | undefined;
function triggerSyncFlash() {
    syncFlash = false; // restart the animation if two pulls arrive in quick succession
    requestAnimationFrame(() => {
        syncFlash = true;
    });
    clearTimeout(syncFlashTimer);
    syncFlashTimer = setTimeout(() => {
        syncFlash = false;
    }, 2600);
}

const queryClient = useQueryClient();

const autosave = new NoteAutosave(
    queryClient,
    () => editor,
    () => currentNoteId,
);

const editorCtrl = new EditorController({
    menus,
    tableUi,
    autosave,
    getCurrentNoteId: () => currentNoteId,
    isSwitchInFlight: () => switchFlushInFlight,
    getAttachmentFiles: () => attachmentFiles,
    getItems: () => treeItemsQuery.data ?? [],
    onUpdate: () => refreshAttachments(),
    onFileError: (msg) => fileEvents.showSizeError(msg),
    onInstanceChange: (e) => {
        editor = e;
    },
});

// A reactive alias — the same name as before, so the template needs no change at all.
const activeFormats = editorCtrl.activeFormats;

let noteId = $derived(page.params.id);

let noteQuery = createQuery(() => ({
    queryKey: QUERY_KEYS.note(noteId ?? ""),
    queryFn: () => {
        const id = noteId;
        if (!id) throw new Error("Note id required");
        return ItemService.getDecryptedItem(id);
    },
    placeholderData: keepPreviousData,
    enabled: !!noteId,
}));

// The files attached to this note (parent_id === noteId, type === "file").
let treeItemsQuery = createQuery(() => treeItemsQueryOptions());

// DEV: the server version / localRev in the DevPanel (taken out of the note header).
$effect(() => {
    if (!import.meta.env.DEV) return;
    const id = currentNoteId;
    if (!id) {
        devNoteDebugStore.clear();
        return;
    }
    const item = (treeItemsQuery.data ?? []).find((i) => i.id === id);
    devNoteDebugStore.set({
        noteId: id,
        version: item?.version ?? 1,
        localRev: item?.localRev,
        conflictOf: item?.conflict_of,
    });
});
// Clear the context only when the note page unmounts, not on every version bump.
$effect(() => {
    return () => {
        if (import.meta.env.DEV) devNoteDebugStore.clear();
    };
});

let attachmentIds = $state<string[]>([]); // the editor's HTML refs — for change detection only
/** The live count of TipTap image nodes (not the vault) — debounced out of the doc. */
let liveInlineImageCount = $state(0);
let promotingRemote = $state(false);
// The selected file's ID; $derived follows fresh query data automatically, with no need to re-sync
// stale data by hand in onChanged (which used to reset the panel's drafts).
let selectedFileId = $state<string | null>(null);
const selectedFile = $derived(
    selectedFileId !== null
        ? ((treeItemsQuery.data ?? []).find((i) => i.id === selectedFileId) ?? null)
        : null,
);
let attachmentFiles = $derived.by<DecryptedItemMeta[]>(() => {
    // Resolve through the encFile refs — never through parent_id (the old, forbidden model).
    const payloadContent = noteQuery.data?.payload?.content ?? "";
    const ids = mergeAttachmentFileIds(attachmentIds, payloadContent);
    const refSet = new Set(ids);
    return refSet.size > 0
        ? (treeItemsQuery.data ?? []).filter((i) => refSet.has(i.id) && i.type === "file")
        : [];
});
// Prefer the live doc count; the payload is the fallback before mount (an exact N, not 0/1).
let inlineExternalImageCount = $derived(
    liveInlineImageCount > 0
        ? liveInlineImageCount
        : countInlineExternalImages(noteQuery.data?.payload?.content ?? ""),
);

/**
 * Mousedown-to-focus for the empty area around the editor (the pt-4 sm:pt-6 lg:pt-8 / pb-8 padding,
 * and the side margin). A click above the content → the start (an empty line plus a visible cursor
 * before the first image); below → the end. A side click clamps into the content box and resolves the
 * position — not `focus('end')` (which teleports to the bottom).
 *
 * It has to be `mousedown`, not `click`: after a drag-select, `click.target` is the common ancestor
 * (the wrapper, or the `.ProseMirror` root itself when dragging across a heading and a paragraph), so
 * the handler would collapse the highlight. Events inside PM — the root and the
 */
function focusEditorAtPointer(e: MouseEvent) {
    if (!editor) return;
    handleEmptySpacePointer(editor, e);
}

/**
 * Recompute the list of referenced files from the live ProseMirror doc (not getHTML —
 * serialising on every keystroke freezes the UI on notes with embeds).
 * The debounce keeps a burst of typing from firing the tree invalidation in a loop; an encFile
 * insert or delete is still seen within ~150 ms.
 */
let attachRefreshTimer: ReturnType<typeof setTimeout> | undefined;
const ATTACH_REFRESH_MS = 150;

function refreshAttachments() {
    if (!editor || editor.isDestroyed) return;
    clearTimeout(attachRefreshTimer);
    attachRefreshTimer = setTimeout(() => {
        attachRefreshTimer = undefined;
        refreshAttachmentsNow();
    }, ATTACH_REFRESH_MS);
}

function refreshAttachmentsNow() {
    if (!editor || editor.isDestroyed) return;
    let next: string[] = [];
    let inlineCount = 0;
    try {
        next = extractFileRefsFromDoc(editor.state.doc);
        inlineCount = countInlineExternalImagesFromDoc(editor.state.doc);
    } catch {
        return;
    }
    liveInlineImageCount = inlineCount;
    if (next.length !== attachmentIds.length || next.some((id, i) => id !== attachmentIds[i])) {
        attachmentIds = next;
        // A newly-swapped real id may not be in the cached tree yet — refresh metas.
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
    }
}

async function onPromoteInlineImages() {
    if (!editor || editor.isDestroyed || !currentNoteId || promotingRemote) return;
    promotingRemote = true;
    try {
        await promoteRemoteImagesInEditor(editor, currentNoteId, null);
        refreshAttachmentsNow();
    } finally {
        promotingRemote = false;
    }
}

$effect(() => {
    const handleFileDelete = (e: Event) => {
        const { fileId } = (e as CustomEvent).detail as { fileId: string };
        attachmentIds = attachmentIds.filter((id) => id !== fileId);
    };
    document.addEventListener(APP_EVENTS.encfileDelete, handleFileDelete);
    return () => document.removeEventListener(APP_EVENTS.encfileDelete, handleFileDelete);
});

let breadcrumb = $derived(
    page.params.id ? buildBreadcrumb(page.params.id, treeItemsQuery.data ?? []) : [],
);

let autoRename = $derived(page.url.searchParams.has("new"));

let loadedNoteId = $state<string | null>(null);
// True while the editor DOM still shows the PREVIOUS note's content (loadContent for the new
// currentNoteId has not been called yet — keepPreviousData on noteQuery keeps the old query.data
// visible until the new one is decrypted). Without this the user briefly sees the old content and
// then a hard swap to the new one (perceived as a "flash", more noticeable on longer notes because
// decryption and reflow take longer). We blur the content instead of a jarring swap.
let isSwitchingNoteContent = $derived(!!currentNoteId && loadedNoteId !== currentNoteId);
/** The server `version` of the last applied state — used to spot a genuine cross-device pull. */
let loadedVersion = $state<number | null>(null);
/**
 * The payload `content` of the last applied state. An external update requires this string to
 * CHANGE, rather than a comparison against the live editor HTML (TipTap normalisation / a mention /
 * an encFile alt easily make the editor differ from the payload). A local metadata write (star, icon,
 * outline…) re-encrypts
 * the same content and raises the version after a push — without this comparison a false-positive banner would flash.
 */
let loadedContent = $state<string | null>(null);
/**
 * true after a conflict resolve / a multi-tab abort — loadContent may then overwrite a dirty editor
 * (the user explicitly chose the server or IDB version, or their changes went into a conflict copy).
 */
let forceContentReload = $state(false);
// True between detecting a note switch and autosave.onNoteSwitch() finishing the old note's flush.
// The editor is ONE shared instance (the content is swapped through loadContent rather than the
// editor being remounted per note) — while this is true, editor.getHTML() still returns the PREVIOUS
// note's content even though currentNoteId already points at the new one. Any save that read the
// editor's content in that window would write someone else's content (the bug: an image or text
// "copied" into several notes after fast navigation). This flag gates loadContent AND every
// save path outside the timer, until the old note has definitely been flushed under ITS OWN id.
let switchFlushInFlight = $state(false);

beforeNavigate(() => {
    if (pendingTrashManager.pendingFileIds.length > 0) {
        void pendingTrashManager.commitAll({ navigateAway: true });
    }
});

$effect(() => {
    const onTrashCommitted = () => {
        const id = currentNoteId;
        // See the comment on switchFlushInFlight — without this guard a commit arriving mid-switch
        // would call executeSave(id) with the NEW id but the OLD editor content.
        if (id && autosave.isDirty && !switchFlushInFlight) autosave.executeSave(id);
    };
    return pendingTrashManager.onCommit(onTrashCommitted);
});

$effect(() => {
    // If the note changed (a click in the toolbar)
    if (currentNoteId !== page.params.id) {
        const prevNoteId = currentNoteId;
        currentNoteId = page.params.id;
        attachmentIds = [];
        showHistory = false;
        loadedVersion = null;
        loadedContent = null;
        if (prevNoteId) {
            // Cancel the pending autosave timer AT ONCE, synchronously — otherwise the old timer
            // (scheduled while prevNoteId was open) can fire mid-transition and save the current,
            // not-yet-replaced editor content under the NEW currentNoteId (see switchFlushInFlight).
            autosave.cancelAutosave();
            switchFlushInFlight = true;
            void pendingTrashManager.commitAll({ navigateAway: true }).then(() => {
                // A forced flush first (restoring data: if staging is still running), then abort the rest.
                autosave.onNoteSwitch(prevNoteId);
                cancelPromoteForNote(prevNoteId);
                switchFlushInFlight = false;
            });
        }
    }

    if (
        editor &&
        !editor.isDestroyed &&
        !switchFlushInFlight &&
        noteQuery.data &&
        currentNoteId === page.params.id &&
        noteQuery.data.id === currentNoteId
    ) {
        const isFirstLoad = loadedNoteId !== currentNoteId;
        const serverVersion = noteQuery.data.version;
        const payloadContent = noteQuery.data.payload.content || "";
        // Our own content save: compare the saved HTML, not the version (a push bumps the version
        // before the note query gets to refetch — lastSavedVersion would lie).
        const isAckedLocalSave =
            autosave.lastSavedContent !== null && payloadContent === autosave.lastSavedContent;
        // A real content change since the last applied payload — not the live editor HTML.
        const contentChangedFromLoaded = loadedContent !== null && payloadContent !== loadedContent;

        // An external update = a pull from another device while the note is open and clean: a newer
        // version AND different content. A metadata-only local write (star/icon/outline/title)
        // re-encrypts the same content, so the version rises after the push — that is NOT an external
        // content update.
        // forceContentReload: a conflict resolve / multi-tab — it may overwrite a dirty editor.
        const isExternalUpdate =
            !isAckedLocalSave &&
            !isFirstLoad &&
            (!autosave.isDirty || forceContentReload) &&
            loadedVersion !== null &&
            serverVersion > loadedVersion &&
            contentChangedFromLoaded;
        const shouldForceLoad =
            forceContentReload && !isAckedLocalSave && !isFirstLoad && contentChangedFromLoaded;
        if (isAckedLocalSave) {
            loadedNoteId = currentNoteId ?? null;
            loadedVersion = serverVersion;
            loadedContent = payloadContent;
            autosave.lastSavedContent = null;
            autosave.setBaseContent(payloadContent);
            forceContentReload = false;
        } else if (isFirstLoad || isExternalUpdate || shouldForceLoad) {
            // Cancel an in-flight promote before the re-load (an external pull / a force).
            if (currentNoteId && (isExternalUpdate || shouldForceLoad)) {
                cancelPromoteForNote(currentNoteId);
            }

            // Sync the rewrite data:image → local: encFile, then a broad safety net (no base64 into TipTap).
            let promoteJobs: import("$lib/modules/files/promote-inline-images").PromoteJob[] = [];
            let htmlForEditor = payloadContent;
            if (
                typeof payloadContent === "string" &&
                payloadContent.includes("<img") &&
                payloadContent.includes("data:image")
            ) {
                const rewritten = rewriteDataImagesInHtml(payloadContent);
                htmlForEditor = rewritten.html;
                promoteJobs = rewritten.jobs;
            }
            const safeContent = replaceHugeDataImageTags(htmlForEditor);

            loadedNoteId = currentNoteId ?? null;
            loadedVersion = serverVersion;
            // The baseline is what is really in the editor, not the original base64 payload.
            loadedContent = safeContent;
            autosave.setBaseContent(safeContent);
            autosave.isDirty = false;
            autosave.cancelAutosave();
            forceContentReload = false;
            // loadContent sets the content and clears the undo/redo history so a redo does not bring
            // back steps from the previously open note. The highlight fires only on an external
            // update — not on a first navigation (where everything would count as "new").
            editorCtrl.loadContent(safeContent, isExternalUpdate || shouldForceLoad);
            if (isExternalUpdate && !shouldForceLoad) triggerSyncFlash();

            // Async staging of promoted data: images (their ids are already in the doc).
            if (promoteJobs.length > 0 && currentNoteId && editor && !editor.isDestroyed) {
                const stageNoteId = currentNoteId;
                void stagePromotedImages(editor, promoteJobs, stageNoteId, null).then(() => {
                    if (currentNoteId === stageNoteId) refreshAttachmentsNow();
                });
            } else {
                refreshAttachmentsNow();
            }

            // Sync the mention labels after the content loads — treeItemsQuery may already hold fresh
            // titles if a note was renamed before this one was opened.
            untrack(() => {
                const notes = (treeItemsQuery.data ?? []).filter((i) => i.type === "note");
                if (notes.length > 0) editorCtrl.syncMentionLabels(notes);
            });
        } else if (serverVersion > (loadedVersion ?? 0)) {
            // A version bump with no content change (a local star/push ack, remote metadata…):
            // only align the version — without loadContent, which would clear undo/redo.
            loadedVersion = serverVersion;
            if (forceContentReload) forceContentReload = false;
        } else if (forceContentReload) {
            // A forced reload but the content is unchanged — only clear dirty
            autosave.isDirty = false;
            autosave.cancelAutosave();
            autosave.setBaseContent(payloadContent);
            loadedContent = payloadContent;
            forceContentReload = false;
        }

        // Resume the editor-image uploads interrupted for this note — once,
        // once the note loads, after the content is in place so the local: nodes exist to be swapped.
        if (resumedForNote !== currentNoteId && currentNoteId) {
            resumedForNote = currentNoteId;
            void resumePendingUploads(editor, currentNoteId);
        }
    }
});

$effect(() => autosave.mount());

// A conflict resolution or a multi-tab abort: forces a content reload from the query even when dirty.
$effect(() => {
    const onForceReload = (e: Event) => {
        const noteId = (e as CustomEvent<{ noteId?: string }>).detail?.noteId;
        if (!noteId || noteId !== currentNoteId) return;
        forceContentReload = true;
        autosave.isDirty = false;
        autosave.cancelAutosave();
        autosave.lastSavedContent = null;
        void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.note(noteId) });
        void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
    };
    window.addEventListener(APP_EVENTS.noteForceReload, onForceReload);
    return () => window.removeEventListener(APP_EVENTS.noteForceReload, onForceReload);
});

$effect(() => {
    const onUploadComplete = (e: Event) => {
        const ce = e as CustomEvent;
        // A stored note repointed after the fact names its note (upload-manager's
        // repointStoredNote) — one that is not open here is none of this page's business.
        if (ce.detail?.noteId && ce.detail.noteId !== currentNoteId) return;
        if (ce.detail) {
            const { localId, fileId } = ce.detail;
            let updated = attachmentIds.map((id) => (id === localId ? fileId : id));
            if (!updated.includes(fileId)) updated = [...updated, fileId];
            attachmentIds = updated;
            // The upload may have finished with no editor reference (a retry from the Sync panel while
            // THIS note is open — retryUpload(null, id) has no access to the live instance). If so,
            // runPendingUpload patched storage only; the live ProseMirror doc still holds local:<id>.
            // Without this swap, the executeSave below would immediately write that correct storage
            // patch back to the old local: ref (the node in the document is still the old one) — the
            // no-op is safe if the node has already been swapped, or if the event does not belong to
            // this note at all (the fileId simply is not found).
            if (editor) swapFileId(editor, localId, fileId);
        }
        // Always persist after an upload: the local:→real id swap has to reach storage even if the user
        // already pressed Ctrl+S while the node still carried a pending ref.
        if (currentNoteId) autosave.executeSave(currentNoteId);
    };
    window.addEventListener(APP_EVENTS.uploadComplete, onUploadComplete);

    return () => {
        window.removeEventListener(APP_EVENTS.uploadComplete, onUploadComplete);
    };
});

// Register the encFile event listeners again whenever the editor or currentNoteId changes, so the
// handlers always reference the latest values.
$effect(() => fileEvents.mount(editor, currentNoteId, () => editorCtrl.isProgrammaticUpdate));

// Keeps the mention labels in sync: when treeItemsQuery updates (a mentioned note was renamed, say),
// patch the stale @labels in the open editor so both the display and the saved HTML stay current.
$effect(() => {
    const notes = (treeItemsQuery.data ?? []).filter((i: DecryptedItemMeta) => i.type === "note");
    if (notes.length > 0) editorCtrl.syncMentionLabels(notes);
});

// A one-off tip about @ linking — only on the first empty note, and only when at least one other note exists.
let noteLinkTipQueued = false;
$effect(() => {
    if (noteLinkTipQueued) return;
    if (loadPersisted(STORAGE_KEYS.noteLinkTipSeen, "", rawStringSerde) === "true") return;
    if (!editor || editor.isDestroyed || switchFlushInFlight) return;
    if (!loadedNoteId || loadedNoteId !== currentNoteId) return;
    if ((treeItemsQuery.data ?? []).filter((i) => i.type === "note").length < 2) return;
    if (!editor.isEmpty) return;

    noteLinkTipQueued = true;
    savePersisted(STORAGE_KEYS.noteLinkTipSeen, "true", rawStringSerde);
    globalToasts.add({
        variant: "info",
        message: "Tip: type @ to link to another note, or use the Link button in the toolbar.",
        durationMs: 8000,
    });
});

function getSourceHtml(): string | null {
    if (!editor || editor.isDestroyed || switchFlushInFlight) return null;
    if (!loadedNoteId || loadedNoteId !== currentNoteId) return null;
    return editor.getHTML();
}

const sourceReady = $derived(
    !!editor && !editor.isDestroyed && !switchFlushInFlight && loadedNoteId === currentNoteId,
);

async function toggleStar() {
    const note = noteQuery.data;
    if (note?.type !== "note" || isTogglingStar) return;

    const nextStarred = !note.payload?.starred;
    isTogglingStar = true;

    type DecryptedNote = NonNullable<Awaited<ReturnType<typeof ItemService.getDecryptedItem>>>;

    queryClient.setQueryData(QUERY_KEYS.note(note.id), (old: DecryptedNote | undefined) => {
        if (!old) return old;
        return {
            ...old,
            payload: {
                ...old.payload,
                starred: nextStarred,
            },
        };
    });

    queryClient.setQueryData(QUERY_KEYS.treeItems, (old: DecryptedItemMeta[] | undefined) => {
        if (!old) return old;
        return old.map((item) => (item.id === note.id ? { ...item, starred: nextStarred } : item));
    });

    try {
        await ItemService.updateItemStarred(note.id, nextStarred);
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
        queryClient.invalidateQueries({
            queryKey: QUERY_KEYS.note(note.id),
        });
    } catch (e) {
        console.error("Star toggle failed", e);
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
        queryClient.invalidateQueries({
            queryKey: QUERY_KEYS.note(note.id),
        });
    } finally {
        isTogglingStar = false;
    }
}

async function handleCommitRename(noteId: string, title: string) {
    try {
        await ItemService.updateItemTitle(noteId, title);
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
        queryClient.invalidateQueries({
            queryKey: QUERY_KEYS.note(noteId),
        });
    } catch (e) {
        console.error("Rename failed", e);
    }
}

// Track the recently opened note
$effect(() => {
    const id = page.params.id;
    if (id) {
        recentNotesStore.push(id);
    }
});

// Open the FileDetailPanel when the Info button on an encFile node is clicked.
$effect(() => {
    const id = fileEvents.openInfoFileId;
    if (!id) return;
    const file = attachmentFiles.find((f) => f.id === id) ?? null;
    if (file) {
        selectedFileId = file.id;
        fileEvents.openInfoFileId = null;
    }
});

let isCreating = $state(false);

async function createNote() {
    if (isCreating) return;
    isCreating = true;
    try {
        const linkTitle = page.state.linkTitle;
        const payloadTitle = noteQuery.data?.payload?.title;
        const titleToUse = linkTitle || payloadTitle || "Untitled";

        const item = await ItemService.createItem("note", null, titleToUse);
        await queryClient.invalidateQueries({
            queryKey: QUERY_KEYS.treeItems,
        });
        await goto(`/note/${item.id}?new=1`);
    } catch (e) {
        console.error("Failed to create note", e);
    } finally {
        isCreating = false;
    }
}
</script>

<svelte:window
    onkeydown={(e) => autosave.handleKeyDown(e)}
    onpointerdown={() => menus.closeAll()}
/>

<div
    class="h-full flex flex-col bg-[var(--surface-panel)]"
    style="--history-panel-w: 17rem"
>
    {#if noteQuery.isLoading}
        <div class="flex-1 flex flex-col fade-in justify-center px-6">
            <div class="animate-pulse space-y-4 max-w-3xl mx-auto py-8 w-full">
                <div class="h-8 bg-[var(--surface-raised)] rounded w-1/3"></div>
                <div
                    class="h-4 bg-[var(--surface-raised)] rounded w-full"
                ></div>
                <div class="h-4 bg-[var(--surface-raised)] rounded w-5/6"></div>
                <div class="h-4 bg-[var(--surface-raised)] rounded w-4/6"></div>
            </div>
        </div>
    {:else if noteQuery.isError || !noteQuery.data || noteQuery.data.deleted_at}
        <div
            class="flex-1 flex flex-col items-center justify-center text-center p-8 relative overflow-hidden fade-in"
        >
            <div class="relative z-10 flex flex-col items-center">
                <div
                    class="w-16 h-16 rounded-2xl bg-[var(--surface-raised)] border border-[var(--stroke)] flex items-center justify-center mb-4 shadow-sm text-[var(--text-dim)]"
                >
                    <svg
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        ><path
                            d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"
                        /><polyline points="14 2 14 8 20 8" /><line
                            x1="9.5"
                            y1="12.5"
                            x2="14.5"
                            y2="17.5"
                        /><line x1="14.5" y1="12.5" x2="9.5" y2="17.5" /></svg
                    >
                </div>
                <h2 class="text-lg font-medium text-[var(--text-sub)] mb-1.5">
                    Note not found
                </h2>
                <p class="text-[var(--text-dim)] max-w-sm text-sm mb-6">
                    This note has been deleted or does not exist. Would you like
                    to create a new one instead?
                </p>
                <Button variant="normal" onclick={createNote} disabled={isCreating} loading={isCreating}>
                    <PenLine class="w-4 h-4" />
                    Create new note
                </Button>
            </div>
        </div>
    {:else}
        <EditorHeader
            {breadcrumb}
            {autosave}
            noteId={currentNoteId!}
            attachmentCount={attachmentFiles.length}
            inlineExternalImageCount={inlineExternalImageCount}
            promotingInline={promotingRemote}
            starred={noteQuery.data?.payload?.starred ?? false}
            isTogglingStar={isTogglingStar ||
                !noteQuery.data ||
                noteQuery.data.type !== "note"}
            {autoRename}
            {showHistory}
            version={(treeItemsQuery.data ?? []).find(
                (i) => i.id === currentNoteId,
            )?.version ?? 1}
            onStar={toggleStar}
            onCommitRename={handleCommitRename}
            onToggleHistory={() => (showHistory = !showHistory)}
            onShare={() => (shareDialogOpen = true)}
            onPromoteInlineImages={onPromoteInlineImages}
            {getSourceHtml}
            {sourceReady}
        />

        <ShareDialog
            bind:open={shareDialogOpen}
            noteId={currentNoteId!}
            noteContent={noteQuery.data?.payload?.content ?? ""}
            attachmentFileIds={attachmentFiles.map((f) => f.id)}
        />

        <!-- The main layout: the editor is always full width -->
        <div class="flex-1 flex flex-col fade-in" style="min-height:0">
            <div class="flex-1 flex flex-col min-h-0">
                {#if editor}
                    <EditorToolbar
                        {editor}
                        {activeFormats}
                        {menus}
                        {emojiState}
                        {currentNoteId}
                    />
                {/if}
                <!-- The sync flash bar — directly below the toolbar, above the editor content. A static
                     element (not absolutely positioned), so it does not cover the text, and it animates
                     in and out. -->
                {#if syncFlash}
                    <div
                        class="sync-flash-banner pointer-events-none flex items-center justify-center gap-2 px-4 py-1.5 bg-brand0/10 border-b border-brand0/25 text-brand-fg text-xs font-medium"
                    >
                        <RefreshCw class="w-3 h-3 flex-shrink-0" />
                        Updated from another device
                    </div>
                {/if}
                <!-- The outline sidebar plus the prose scroll area -->
                <div class="flex-1 flex min-h-0 relative">
                    {#if editor}
                        <EditorOutline {editor} scrollEl={proseScrollEl} />
                    {/if}
                    <div
                        class="flex-1 overflow-y-auto bg-[var(--surface-panel)] relative flex flex-col"
                        bind:this={proseScrollEl}
                    >
                        <!-- svelte-ignore a11y_no_static_element_interactions -->
                        <div
                            class="w-full cursor-text flex-1 px-6 md:px-8 pt-4 sm:pt-6 lg:pt-8 pb-8 transition-opacity duration-150 {isSwitchingNoteContent
                                ? 'opacity-0 pointer-events-none'
                                : 'opacity-100'}"
                            onmousedown={focusEditorAtPointer}
                        >
                            <div class="w-full" use:editorCtrl.attach></div>
                        </div>

                        <TableControls {tableUi} {menus} />
                    </div>
                </div>
            </div>
        </div>

        <!-- The history fixed drawer — an overlay on the right; it does not squeeze the editor.
             The backdrop z-35: above EditorHeader (z-30), below the panel and the app sidebar (z-40). -->
        {#if showHistory}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
                data-testid="history-backdrop"
                class="fixed inset-0 z-[35]"
                role="presentation"
                onclick={() => (showHistory = false)}
            ></div>
            <div
                data-testid="history-panel"
                class="fixed inset-y-0 right-0 z-40 flex flex-col border-l border-[var(--stroke)] bg-[var(--surface-panel)] shadow-2xl"
                style="width: var(--history-panel-w, 17rem)"
            >
                <HistoryPanel
                    noteId={currentNoteId!}
                    {editor}
                    {autosave}
                    visible={showHistory}
                    onRestored={() => (showHistory = false)}
                />
            </div>
        {/if}
    {/if}
</div>

{#if selectedFile}
    <FileDetailPanel
        file={selectedFile}
        onClose={() => (selectedFileId = null)}
        onChanged={() => {
            // selected is $derived from treeItemsQuery.data — it refreshes automatically when the query refetches.
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
        }}
    />
{/if}

{#if fileEvents.confirmQueue.length > 0}
    {@const queue = fileEvents.confirmQueue}
    {@const count = queue.length}
    <div
        class="fixed inset-x-0 bottom-6 z-[65] flex justify-center px-4 pointer-events-none"
    >
        <div
            class="pointer-events-auto flex items-center gap-3 bg-[var(--surface-panel)] border border-[var(--stroke)] rounded-xl px-4 py-3 shadow-[var(--float-shadow)] max-w-sm w-full"
        >
            <div class="flex-1 min-w-0">
                {#if count === 1}
                    {@const f = queue[0].file}
                    {@const sizeStr =
                        f.size < 1024 * 1024
                            ? `${Math.round(f.size / 1024)} KB`
                            : `${(f.size / (1024 * 1024)).toFixed(1)} MB`}
                    <div
                        class="text-sm font-medium text-[var(--text)] truncate"
                    >
                        {f.name}
                    </div>
                    <div class="text-xs text-[var(--text-dim)]">
                        {sizeStr} — upload to this note?
                    </div>
                {:else}
                    <div class="text-sm font-medium text-[var(--text)]">
                        {count} files — upload to this note?
                    </div>
                    <div
                        class="text-xs text-[var(--text-muted)] mt-1 space-y-0.5 max-h-20 overflow-y-auto"
                    >
                        {#each queue as q}
                            <div class="truncate">{q.file.name}</div>
                        {/each}
                    </div>
                {/if}
            </div>
            <Button onclick={() => (fileEvents.confirmQueue = [])}
                >Cancel</Button
            >
            <Button
                variant="primary"
                onclick={async () => {
                    // splice(0) atomically clears the reactive array AND returns a plain JS
                    // array — avoids iterating a Svelte proxy after the source is reassigned.
                    const items = fileEvents.confirmQueue.splice(0);
                    const ed = editor;
                    devLog(
                        "upload",
                        "confirm click: items=",
                        items.length,
                        items.map((i) => i.file.name),
                        "editor=",
                        !!ed,
                    );
                    if (!ed) return;
                    // Phase 1 — store all blobs to IDB in parallel (async, awaited together).
                    // Keeping all awaits BEFORE the insertions means no Svelte reactive effect
                    // can fire between individual insertions and overwrite the editor content.
                    const pendings = await Promise.all(
                        items.map((item) =>
                            preparePendingUpload(
                                item.file,
                                item.noteId,
                                item.parentId,
                            ).catch((e) => {
                                console.error(
                                    "[upload] prepare failed:",
                                    item.file.name,
                                    e,
                                );
                                return null;
                            }),
                        ),
                    );
                    // Phase 2 — insert all nodes synchronously (no awaits between calls).
                    const validPendings = pendings.filter(
                        (p): p is NonNullable<typeof p> => p !== null,
                    );
                    if (validPendings.length > 0)
                        insertAndStartUploads(ed, validPendings);
                }}>{count === 1 ? "Upload" : `Upload ${count}`}</Button
            >
        </div>
    </div>
{/if}

<div class="toast-stack z-[65]">
    {#if fileEvents.sizeErrorMsg}
        <Toast
            variant="error"
            message={fileEvents.sizeErrorMsg}
            onDismiss={() => (fileEvents.sizeErrorMsg = null)}
        />
    {/if}

</div>

{#if fileEvents.cropTarget}
    <CropModal
        file={fileEvents.cropTarget.blob}
        filename={fileEvents.cropTarget.name}
        onCancel={() => (fileEvents.cropTarget = null)}
        onResult={async (blob) => {
            if (editor)
                await fileEvents.handleCropResult(blob, editor, currentNoteId);
        }}
    />
{/if}

<HeadingPopover {menus} {editor} {activeFormats} />
<FontFamilyPopover {menus} {editor} {activeFormats} />
<FontSizePopover {menus} {editor} {activeFormats} />
<ColorPopover {menus} {editor} activeColor={activeFormats.color || undefined} />
<HighlightPopover
    {menus}
    {editor}
    activeColor={activeFormats.highlightColor || undefined}
/>
<LinkPopover {menus} {editor} notes={treeItemsQuery.data ?? []} {currentNoteId} />
<ImagePopover {menus} {editor} {currentNoteId} />
<TextAlignPopover {menus} {editor} activeAlign={editorCtrl.activeFormats.textAlign} />
<TableMenu {menus} {editor} {tableUi} />
<TablePropertiesDialog
    open={tableUi.propertiesOpen}
    {editor}
    {tableUi}
    onclose={() => (tableUi.propertiesOpen = false)}
/>
<TablePicker {menus} {editor} />
<EmojiPickerPopover {menus} {emojiState} {editor} />
<ShortcutsPopover {menus} />
