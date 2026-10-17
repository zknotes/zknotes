import type { Editor } from "@tiptap/core";
import { globalToasts } from "$lib/core/stores/toast.svelte";
import { FileService } from "./file-service";
import { LOCAL_PREFIX } from "./refs";
import { abandonRemovedUpload, holdRemovedUpload } from "./removed-uploads";

/**
 * The grace period before a file goes into the trash — and before an upload whose node was removed
 * is aborted.
 */
export const PENDING_TRASH_GRACE_MS = 5000;

type PendingEntry = {
    timer: ReturnType<typeof setTimeout>;
    noteId: string;
    editor: Editor;
};

type CommitOptions = {
    /** Replace the UNDO toast with a message carrying no undo button (a navigation away from the note page). */
    navigateAway?: boolean;
};

class PendingTrashManager {
    #pending = new Map<string, PendingEntry>();
    #toastId: string | null = null;
    #commitListeners = new Set<() => void>();

    get pendingFileIds(): string[] {
        return [...this.#pending.keys()];
    }

    isPending(fileId: string): boolean {
        return this.#pending.has(fileId);
    }

    onCommit(listener: () => void): () => void {
        this.#commitListeners.add(listener);
        return () => this.#commitListeners.delete(listener);
    }

    schedule(fileId: string, noteId: string, editor: Editor): void {
        // A `local:` node is an upload still running: the same grace and the same toast, and the
        // upload is aborted when the grace runs out.
        if (fileId.startsWith(LOCAL_PREFIX)) holdRemovedUpload(fileId.slice(LOCAL_PREFIX.length));

        this.cancel(fileId);

        const timer = setTimeout(() => {
            void this.#commitOne(fileId);
        }, PENDING_TRASH_GRACE_MS);

        this.#pending.set(fileId, { timer, noteId, editor });
        this.#syncToast();
    }

    cancel(fileId: string): void {
        const entry = this.#pending.get(fileId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.#pending.delete(fileId);
        this.#syncToast();
    }

    cancelAll(): void {
        for (const id of [...this.#pending.keys()]) {
            this.cancel(id);
        }
    }

    async commitAll(opts: CommitOptions = {}): Promise<void> {
        const ids = [...this.#pending.keys()];
        if (ids.length === 0) return;

        for (const id of ids) {
            const entry = this.#pending.get(id);
            if (entry) clearTimeout(entry.timer);
        }
        this.#clearToast();

        if (opts.navigateAway) {
            // An aborted upload never reaches the Trash, so it is not said to have gone there.
            const toTrash = ids.every((id) => !id.startsWith(LOCAL_PREFIX));
            globalToasts.add({
                variant: "info",
                message:
                    ids.length === 1
                        ? toTrash
                            ? "File moved to trash."
                            : "File removed."
                        : toTrash
                          ? `${ids.length} files moved to trash.`
                          : `${ids.length} files removed.`,
                durationMs: PENDING_TRASH_GRACE_MS,
            });
        }

        await Promise.all(
            ids.map(async (id) => {
                try {
                    await this.#commitRemoval(id);
                } catch (err) {
                    console.error("Failed to trash item", err);
                } finally {
                    this.#pending.delete(id);
                }
            }),
        );
        this.#notifyCommit();
    }

    async #commitOne(fileId: string): Promise<void> {
        const entry = this.#pending.get(fileId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.#pending.delete(fileId);

        try {
            await this.#commitRemoval(fileId);
        } catch (err) {
            console.error("Failed to trash item", err);
        }

        this.#syncToast();
        if (this.#pending.size === 0) {
            this.#notifyCommit();
        }
    }

    /**
     * A removal whose grace ran out: a file goes to the Trash. An upload that finished inside the
     * grace goes there too; one that still runs is aborted — its row, staging and server session —
     * and the editor is left alone, since the node is gone already.
     */
    async #commitRemoval(fileId: string): Promise<void> {
        if (!fileId.startsWith(LOCAL_PREFIX)) {
            await FileService.trash(fileId);
            return;
        }
        const localId = fileId.slice(LOCAL_PREFIX.length);
        // Synchronous, before any await: an upload that finishes from here on sees the mark.
        const finished = abandonRemovedUpload(localId);
        if (finished) {
            await FileService.trash(finished);
            return;
        }
        const { abortRemovedUpload } = await import("./upload-manager");
        await abortRemovedUpload(localId);
    }

    #notifyCommit(): void {
        for (const fn of this.#commitListeners) fn();
    }

    #clearToast(): void {
        if (this.#toastId) {
            globalToasts.remove(this.#toastId);
            this.#toastId = null;
        }
    }

    #syncToast(): void {
        const count = this.#pending.size;

        if (count === 0) {
            this.#clearToast();
            return;
        }

        // The pending entries may belong to different notes (the user deleted a file from note A, then
        // moved to note B and deleted another file before the first timer expired) — an Undo has to
        // revert the transaction in EVERY editor holding a pending delete, not only in the one opened
        // last, or else the deletion from note A stays permanently applied while the wrong note, B, is
        // undone.
        const editors = new Set([...this.#pending.values()].map((e) => e.editor));

        const message = count === 1 ? "File removed." : `${count} files removed.`;
        const action = {
            label: "Undo",
            onClick: () => {
                const ids = [...this.#pending.keys()];
                for (const id of ids) {
                    this.cancel(id);
                }
                for (const editor of editors) {
                    if (!editor.isDestroyed) editor.commands.undo();
                }
                // An undo that took back more than the removal — the insertion too, when the two fell
                // within the history's grouping delay — did not bring the node back: that removal
                // stands, so no READY file is left without an embed.
                for (const id of ids) {
                    if (![...editors].some((editor) => docHasFile(editor, id))) {
                        void this.#commitRemoval(id);
                    }
                }
            },
        };

        this.#toastId = globalToasts.add({
            variant: "info",
            message,
            action,
            durationMs: PENDING_TRASH_GRACE_MS,
        });
    }
}

/** Whether an open editor still shows the file (a destroyed one shows nothing). */
function docHasFile(editor: Editor, fileId: string): boolean {
    if (editor.isDestroyed) return false;
    let found = false;
    editor.state.doc.descendants((node) => {
        if (node.type.name === "encFile" && node.attrs.fileId === fileId) found = true;
        return !found;
    });
    return found;
}

export const pendingTrashManager = new PendingTrashManager();

/** The file ids whose removal from the editor must not start a pending trash (a move, for instance). */
export const skipPendingTrashFileIds = new Set<string>();
