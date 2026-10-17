<script lang="ts">
import type { Editor } from "@tiptap/core";
import { Check, FileText, Trash2 } from "lucide-svelte";
import type { DecryptedItemMeta } from "$lib/core/data/items";
import type { PopoverMenus } from "$lib/modules/editor/PopoverMenus.svelte";
import { filterLinkableNotes, insertNoteMention } from "$lib/modules/editor/note-mentions";
import ToolbarPopover from "$lib/modules/editor/ToolbarPopover.svelte";
import Button from "$lib/core/ui/Button.svelte";
import { EmptyState, ItemTitle } from "$lib/core/ui";

let {
    menus,
    editor,
    notes = [],
    currentNoteId,
}: {
    menus: PopoverMenus;
    editor: Editor | undefined;
    notes?: DecryptedItemMeta[];
    currentNoteId?: string;
} = $props();

const open = $derived(menus.isOpen("link"));
const hasLink = $derived(editor?.isActive("link") ?? false);

let url = $state("");
let noteSearch = $state("");
let urlInputEl: HTMLInputElement | undefined = $state();
let noteSearchEl: HTMLInputElement | undefined = $state();
let wasOpen = false;

const filteredNotes = $derived(filterLinkableNotes(notes, currentNoteId, noteSearch, 20));

// On open: prefill URL, reset note search, focus URL input.
$effect(() => {
    if (open && !wasOpen) {
        url = (editor?.getAttributes("link").href as string | undefined) ?? "";
        noteSearch = "";
        queueMicrotask(() => {
            urlInputEl?.focus();
            urlInputEl?.select();
        });
    }
    wasOpen = open;
});

function applyUrl() {
    if (!editor) return;
    const href = url.trim();
    if (href === "") {
        editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else {
        editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
    menus.close("link");
}

function removeUrl() {
    editor?.chain().focus().extendMarkRange("link").unsetLink().run();
    menus.close("link");
}

function selectNote(note: DecryptedItemMeta) {
    if (!editor) return;
    insertNoteMention(editor, { id: note.id, label: note.title });
    menus.close("link");
}

function onUrlKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
        e.preventDefault();
        applyUrl();
    } else if (e.key === "Escape") {
        e.preventDefault();
        menus.close("link");
    }
}

function onNoteSearchKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && filteredNotes[0]) {
        e.preventDefault();
        selectNote(filteredNotes[0]);
    } else if (e.key === "Escape") {
        e.preventDefault();
        menus.close("link");
    }
}
</script>

<ToolbarPopover {open} anchor={menus.anchor("link")} onclose={() => menus.close("link")}>
    <div
        class="bg-[var(--surface-raised)] rounded-lg shadow-[0_12px_32px_rgba(0,0,0,0.7)] border border-[var(--stroke)] p-2 w-[300px] flex flex-col gap-2"
    >
        <div class="text-2xs font-mono font-bold text-[var(--text-dim)] uppercase tracking-wider px-0.5">
            External link
        </div>
        <div class="flex items-center gap-1.5">
            <input
                bind:this={urlInputEl}
                bind:value={url}
                onkeydown={onUrlKeydown}
                type="url"
                placeholder="https://example.com"
                class="flex-1 min-w-0 bg-[var(--surface-panel)] border border-[var(--stroke)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] placeholder:text-[var(--text-dim)] outline-none focus:border-brand0/60"
            />
            {#if hasLink}
                <Button
                    type="button"
                    variant="danger-ghost"
                    size="icon"
                    onclick={removeUrl}
                    title="Remove link"
                    class="shrink-0"
                >
                    <Trash2 class="w-4 h-4" />
                </Button>
            {/if}
            <Button
                type="button"
                variant="primary"
                size="icon"
                onclick={applyUrl}
                title="Apply"
                class="shrink-0"
            >
                <Check class="w-4 h-4" />
            </Button>
        </div>

        <div class="h-px bg-[var(--stroke)]"></div>

        <div class="text-2xs font-mono font-bold text-[var(--text-dim)] uppercase tracking-wider px-0.5">
            Link to note
        </div>
        <input
            bind:this={noteSearchEl}
            bind:value={noteSearch}
            onkeydown={onNoteSearchKeydown}
            type="search"
            placeholder="Search notes…"
            class="w-full bg-[var(--surface-panel)] border border-[var(--stroke)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] placeholder:text-[var(--text-dim)] outline-none focus:border-brand0/60"
        />
        <div class="max-h-[200px] overflow-y-auto rounded-md border border-[var(--stroke)] bg-[var(--surface-panel)] py-1">
            {#if filteredNotes.length > 0}
                {#each filteredNotes as note}
                    <Button
                        variant="ghost"
                        class="w-full !justify-start gap-2 px-3 py-1.5 text-sm select-none"
                        onclick={() => selectNote(note)}
                    >
                        <span class="flex-shrink-0 flex items-center justify-center w-4 h-4 text-[var(--text-dim)]">
                            {#if note.icon}
                                <span class="emoji-icon text-xs">{note.icon}</span>
                            {:else}
                                <FileText class="w-3.5 h-3.5" />
                            {/if}
                        </span>
                        <ItemTitle
                            class="flex-1 min-w-0 !font-normal"
                            style={note.color ? `color: ${note.color}` : ""}
                        >
                            {note.title}
                        </ItemTitle>
                    </Button>
                {/each}
            {:else}
                <EmptyState class="px-3 py-2 italic text-left">No notes found</EmptyState>
            {/if}
        </div>
        <p class="text-2xs text-[var(--text-dim)] px-0.5 leading-relaxed">
            Or type <span class="font-mono text-[var(--text-muted)]">@</span> in the editor to link a note.
        </p>
    </div>
</ToolbarPopover>