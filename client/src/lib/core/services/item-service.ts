import { createsCycle, type FolderPayload, type NotePayload } from "@zknotes/shared";
import type { IDBPObjectStore, IDBPTransaction } from "idb";
import { uuidv7 } from "uuidv7";
import { APP_EVENTS } from "$lib/core/constants/events";
import { decryptItemPayload, encryptItemPayloadToBase64 } from "$lib/core/crypto/item-codec";
import { isVaultSessionCurrent } from "$lib/core/crypto/session-key";
import { getDB, type LocalItem, type ZKnotesDBSchema } from "$lib/core/db";
import { fileBridge } from "$lib/core/events/file-bridge";
import { evictChunkSet } from "$lib/core/files/chunk-loader";
import { addOrUpdateDoc, removeDoc } from "$lib/core/search";
import { conflictStore } from "$lib/core/stores/conflict-store.svelte";
import { globalToasts } from "$lib/core/stores/toast.svelte";
import { enqueueMutation, pushDeletes, pushItem } from "$lib/core/sync";
import {
    createLocalConflictCopyFromPayload,
    replaceConflictCopyContent,
} from "$lib/core/sync/conflict";
import { toBase64 } from "$lib/core/utils/base64";
import { FileLifecycle } from "$lib/core/utils/file-lifecycle";
import { extractPlainText } from "$lib/core/utils/tiptap-text";
import { collectDescendants } from "$lib/core/utils/tree";
import { encryptPayloadWithNewKeyTask } from "$lib/core/workers/crypto-rpc";
import { stripAllFileRefsFromHtml } from "$lib/modules/files/refs";

/**
 * Serialises concurrent reencryptAndSave calls for the same item id, in call order rather than in
 * completion order. Without it, two "fire-and-forget" writes to the same note (autosave.flush() as
 * the user leaves a note, say, plus a File Manager move that strips an embed out of that same note)
 * each do a read-modify-write against a stale snapshot and overwrite one another — the write that
 * started later but finished sooner silently loses the change of the one that began first. Chaining
 * by id means every call reads a state that already includes the previous write.
 */
const itemWriteLocks = new Map<string, Promise<unknown>>();

function withItemWriteLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const runChained = (): Promise<T> => {
        const prev = itemWriteLocks.get(id) ?? Promise.resolve();
        const settled = prev.then(fn, fn);
        itemWriteLocks.set(
            id,
            settled.then(
                () => undefined,
                () => undefined,
            ),
        );
        return settled;
    };
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks?.request) return runChained();
    return locks.request(`zknotes-item-${id}`, () => runChained());
}

/** The SearchDoc that reencryptAndSave sends to the index after a successful save. */
export interface ReindexDoc {
    id: string;
    type: "note" | "folder" | "file";
    title: string;
    content?: string;
}

/**
 * The item's row vanished from under an active edit — deleted or purged on another device, and the
 * pull removed it locally. Kept separate from "cannot be decrypted" so the caller (autosave) can
 * react gracefully, with a clear toast, instead of silently losing the change behind a raw console
 * error.
 */
export class ItemGoneError extends Error {
    constructor(public itemId: string) {
        super(`Item ${itemId} no longer exists`);
        this.name = "ItemGoneError";
    }
}

/**
 * The session generation was rotated out from under this tab (another user signed in to this browser
 * while this tab stayed open) between the last UI render and this call. Fail closed:
 * refuse to create the row BEFORE generating an Item Key and writing to IDB — otherwise the row
 * could reach the server under someone else's cookie (content leaking to the new user in the
 * SharedWorker topology, or a permanently unreadable row in the Dedicated one).
 */
export class SessionExpiredError extends Error {
    constructor() {
        super(
            "Vault session is no longer current — refusing to create item under a different user's session",
        );
        this.name = "SessionExpiredError";
    }
}

/**
 * The save was refused because IDB already held divergent content (another tab, or a race).
 * The user's changes are preserved as a conflict copy; the original was not overwritten.
 * The caller should clear dirty and force-reload the editor (noteForceReload is already dispatched).
 */
export class ConcurrentEditConflictError extends Error {
    constructor(public itemId: string) {
        super(`Concurrent edit on item ${itemId} — edits saved as conflict copy`);
        this.name = "ConcurrentEditConflictError";
    }
}

/**
 * The original (IDB) stays; our changes → a conflict copy, the inbox, and a force reload.
 *
 * `intoCopyId`: a push 409 has already made a conflict copy from this editor, and the
 * editor is settling it (NoteAutosave). Our content goes into THAT copy, and the toast and the reload
 * are left to the editor, which shows them once. If the copy is no longer there, fall back to a new
 * one — the text is never dropped.
 */
async function saveAsConcurrentConflictCopy(
    baseItem: LocalItem,
    ourPayload: Record<string, unknown>,
    intoCopyId?: string,
): Promise<void> {
    if (intoCopyId && baseItem.type === "note" && typeof ourPayload.content === "string") {
        const written = await replaceConflictCopyContent(
            intoCopyId,
            baseItem.id,
            (ourPayload.contentTitle as string) || "Untitled",
            ourPayload.content,
        );
        if (written !== "unavailable") {
            if (typeof window !== "undefined") {
                window.dispatchEvent(new CustomEvent(APP_EVENTS.vaultItemsChanged));
            }
            return;
        }
    }
    const { item: conflictCopy, title } = await createLocalConflictCopyFromPayload(
        baseItem,
        ourPayload,
    );
    const db = await getDB();
    await db.put("items", conflictCopy);
    await enqueueMutation(conflictCopy.id, "upsert");
    conflictStore.add({
        id: conflictCopy.id,
        title,
        type: conflictCopy.type,
        at: Math.floor(Date.now() / 1000),
    });
    globalToasts.add({
        variant: "info",
        message:
            "This note was updated elsewhere — your edits were saved as a conflict copy. Open Conflict Inbox to choose a version.",
    });
    if (typeof window !== "undefined") {
        window.dispatchEvent(
            new CustomEvent(APP_EVENTS.noteForceReload, {
                detail: { noteId: baseItem.id },
            }),
        );
        window.dispatchEvent(new CustomEvent(APP_EVENTS.vaultItemsChanged));
    }
}

// biome-ignore lint/complexity/noStaticOnlyClass: the same convention as FileService.
export class ItemService {
    /**
     * The shared core of every payload mutation: decrypt → mutate → encrypt →
     * dirty/localRev/updated_at → an IDB put → (reindex) → push. Previously copied across seven
     * methods (update Payload/Color/Title/Icon/Starred/FileMeta, appendFileToNote).
     *
     * `required: true` throws when the item does not exist or cannot be decrypted; otherwise the
     * method silently does nothing (the semantics of UI toggles such as colour).
     *
     * `mutate` returning null means there is nothing to change: no write, no push, and the item comes
     * back as it is. The decision is made on the payload read inside the write lock.
     */
    static async reencryptAndSave(
        id: string,
        mutate: (payload: Record<string, unknown>) => Record<string, unknown> | null,
        opts: {
            required?: boolean;
            /** Return the doc for reindexing, or undefined when no reindex is needed. */
            reindex?: (payload: Record<string, unknown>, item: LocalItem) => ReindexDoc;
            /**
             * The content baseline the editor started from (the last load or successful save).
             * If IDB holds different content meanwhile (another tab), make a conflict copy of that
             * version before writing — this prevents a silent multi-tab clobber without a 409.
             * The getter is evaluated inside the item write lock, after earlier same-tab writes (a
             * file-ref strip, say) have finished and moved the baseline.
             */
            basedOnContent?: string | (() => string | undefined);
            /**
             * The conflict copy a push 409 already made from this editor: on a conflict,
             * write our payload into it rather than into a new copy. Read at the moment of the
             * conflict, inside the item write lock.
             */
            intoConflictCopy?: () => string | undefined;
        } = {},
    ): Promise<LocalItem | null> {
        return withItemWriteLock(id, async () => {
            const db = await getDB();
            const existing = await db.get("items", id);
            if (!existing) {
                // The row does not exist at all — distinguish this from a failed decrypt (ItemGoneError).
                if (opts.required) throw new ItemGoneError(id);
                return null;
            }

            // A CAS on the row — it catches a concurrent write (multi-tab, or an overlapping
            // save) that basedOnContent does not cover (a title/star/move, or a TOCTOU after the decrypt).
            // Two fields, localRev and the ciphertext. The ciphertext is what the payload below is
            // derived from: every content write moves it (a fresh nonce), a server overwrite included
            // (where localRev was once reset to undefined), so while it is unchanged the decrypt is
            // not stale. `version` is deliberately NOT compared: the only write that moves
            // it alone is the ack of a push of the same content (applySucceeded), and treating that
            // as someone else's edit made a false conflict copy of this tab's own quick second change.
            // The write below takes the row's current version, so the next push matches the server.
            const startLocalRev = existing.localRev ?? 0;
            const startCiphertext = existing.encrypted_payload;
            const writtenMeanwhile = (row: LocalItem): boolean =>
                (row.localRev ?? 0) !== startLocalRev || row.encrypted_payload !== startCiphertext;
            const intoCopyId = (): string | undefined => opts.intoConflictCopy?.();

            let currentPayload: Record<string, unknown>;
            try {
                currentPayload = await decryptItemPayload<Record<string, unknown>>(existing);
            } catch {
                if (opts.required) throw new Error("Item cannot be decrypted");
                return null;
            }

            const newPayload = mutate({ ...currentPayload });
            if (newPayload === null) return existing;

            // A multi-tab or concurrent content write: IDB already holds content that is neither our
            // baseline nor what we are about to write. As on the sync 409 path:
            //   the original (IDB) = the "server" / the other side → do NOT touch it
            //   the conflict copy = OUR changes (offline) → the inbox, as "Offline Version"
            const basedOnContent =
                typeof opts.basedOnContent === "function"
                    ? opts.basedOnContent()
                    : opts.basedOnContent;
            if (
                basedOnContent !== undefined &&
                existing.type === "note" &&
                typeof currentPayload.content === "string"
            ) {
                const stored = currentPayload.content;
                const next = typeof newPayload.content === "string" ? newPayload.content : stored;
                if (stored !== basedOnContent && stored !== next) {
                    try {
                        await saveAsConcurrentConflictCopy(existing, newPayload, intoCopyId());
                        throw new ConcurrentEditConflictError(id);
                    } catch (e) {
                        if (e instanceof ConcurrentEditConflictError) throw e;
                        // Fail closed — never overwrite someone else's content without a conflict
                        // copy
                        console.error("Failed to create multi-tab conflict copy for", id, e);
                        throw e instanceof Error
                            ? e
                            : new Error("Concurrent edit conflict unresolved");
                    }
                }
            }

            // Re-read a fresh row immediately before encrypting and writing — this minimises the
            // staleness window around the worker await (the decrypt above). The row may have
            // disappeared meanwhile (a pull purge).
            const rawItem = await db.get("items", id);
            if (!rawItem) {
                if (opts.required) throw new ItemGoneError(id);
                return null;
            }

            // The CAS: someone wrote meanwhile (localRev or ciphertext moved) — do not clobber.
            if (writtenMeanwhile(rawItem)) {
                try {
                    await saveAsConcurrentConflictCopy(rawItem, newPayload, intoCopyId());
                    throw new ConcurrentEditConflictError(id);
                } catch (e) {
                    if (e instanceof ConcurrentEditConflictError) throw e;
                    console.error("Failed localRev-CAS conflict copy for", id, e);
                    throw e instanceof Error ? e : new Error("Concurrent edit conflict unresolved");
                }
            }

            // The version stays unchanged (the server increments it on the push); it does not enter
            // the AAD, which binds only the id.
            const { encrypted_payload, payload_nonce } = await encryptItemPayloadToBase64(
                id,
                rawItem.version,
                newPayload,
            );

            // Final CAS + write in one readwrite transaction so two tabs cannot both pass a
            // stale readonly get and both put (last-writer-wins clobber). No worker await inside.
            const tx = db.transaction("items", "readwrite");
            const store = tx.objectStore("items");
            const fresh = await store.get(id);
            if (!fresh) {
                await tx.done;
                if (opts.required) throw new ItemGoneError(id);
                return null;
            }
            if (writtenMeanwhile(fresh)) {
                await tx.done;
                try {
                    await saveAsConcurrentConflictCopy(fresh, newPayload, intoCopyId());
                    throw new ConcurrentEditConflictError(id);
                } catch (e) {
                    if (e instanceof ConcurrentEditConflictError) throw e;
                    throw e instanceof Error ? e : new Error("Concurrent edit conflict unresolved");
                }
            }

            fresh.encrypted_payload = encrypted_payload;
            fresh.payload_nonce = payload_nonce;
            fresh.dirty = true;
            fresh.localRev = (fresh.localRev || 0) + 1;
            fresh.updated_at = Math.floor(Date.now() / 1000);

            await store.put(fresh);
            await tx.done;

            const doc = opts.reindex?.(newPayload, fresh);
            if (doc) {
                void addOrUpdateDoc(doc).catch((e) =>
                    console.warn("Failed to re-index after update", e),
                );
            }

            // A same-tab content write (stripping embeds, an append, an autosave…): move the
            // multi-tab baseline (keyed by noteId) to the HTML just written. Without this, trashing a
            // file overwrites the IDB content while the baseline stays old → the next save falsely
            // sees "updated elsewhere".
            if (
                typeof window !== "undefined" &&
                fresh.type === "note" &&
                typeof newPayload.content === "string"
            ) {
                window.dispatchEvent(
                    new CustomEvent(APP_EVENTS.noteContentWritten, {
                        detail: { noteId: id, content: newPayload.content },
                    }),
                );
            }

            // A fire-and-forget push (nothing waits on it)
            pushItem(fresh).catch(() => enqueueMutation(id, "upsert"));
            return fresh;
        });
    }

    static async saveLocalMutationAndPush(
        item: LocalItem,
        store: IDBPObjectStore<ZKnotesDBSchema, ["items"], "items", "readwrite">,
        tx: IDBPTransaction<ZKnotesDBSchema, ["items"], "readwrite">,
    ) {
        item.dirty = true;
        item.localRev = (item.localRev || 0) + 1;
        item.updated_at = Math.floor(Date.now() / 1000);
        await store.put(item);
        await tx.done;
        pushItem(item).catch(() => enqueueMutation(item.id, "upsert"));
    }

    /**
     * The shared "dirty mutation plus push" epilogue outside an open transaction
     * (`saveLocalMutationAndPush` is the in-transaction variant): bump `dirty`/`localRev`/
     * `updated_at`, `db.put`, then a fire-and-forget push with a mutation-queue fallback. Shared by
     * ItemService and FileService (modules→core) — one place of truth for the localRev/updated_at
     * convention.
     */
    static async markDirtyAndPush(item: LocalItem): Promise<void> {
        item.dirty = true;
        item.localRev = (item.localRev || 0) + 1;
        item.updated_at = Math.floor(Date.now() / 1000);
        const db = await getDB();
        await db.put("items", item);
        pushItem(item).catch(() => enqueueMutation(item.id, "upsert"));
    }

    static async createItem(
        type: "note" | "folder",
        parentId: string | null = null,
        title: string = "Untitled",
        sortOrder?: string,
    ) {
        // The session-generation belt: if another user signed in to this browser after this tab was
        // opened, the session generation has rotated and this tab must not create a new row — not
        // even before the cross-tab broadcast arrives, or if it never does.
        if (!isVaultSessionCurrent()) {
            throw new SessionExpiredError();
        }

        const id = uuidv7();

        // Generate the item key and encrypt the payload atomically, in one call — this prevents the
        // race between GENERATE_ITEM_KEY and ENCRYPT_PAYLOAD where a parallel tree load
        // (ADD_ITEM_KEY for the same id) or an eviction could overwrite the cache and untie the
        // payload from its key ("invalid tag").
        // A folder has no content or contentTitle in FolderPayload — writing them here would be dead
        // junk inside the ciphertext that a backup round trip cannot reproduce.
        const payload: NotePayload | FolderPayload =
            type === "note"
                ? { title, contentTitle: title, content: "", starred: false }
                : { title, starred: false };
        // A new item has version=1; the version does not enter the AAD, which binds only the id.
        const { encryptedItemKey, itemKeyNonce, ciphertext, nonce } =
            await encryptPayloadWithNewKeyTask(id, payload, 1);

        // 3. Assemble the LocalItem
        const item: LocalItem = {
            id,
            parent_id: parentId,
            type,
            encrypted_payload: toBase64(new Uint8Array(ciphertext)),
            payload_nonce: toBase64(new Uint8Array(nonce)),
            encrypted_item_key: toBase64(new Uint8Array(encryptedItemKey)),
            item_key_nonce: toBase64(new Uint8Array(itemKeyNonce)),
            sort_order: sortOrder || id, // use the given sort order, or fall back to the uuidv7
            version: 1, // a new item — the server stores it as version=1
            dirty: true,
            localRev: 0,
            // Local placeholder timestamps; the server overwrites them on the first sync.
            created_at: Math.floor(Date.now() / 1000),
            updated_at: Math.floor(Date.now() / 1000),
        };

        // 4. Save into IndexedDB
        const db = await getDB();
        await db.put("items", item);

        // 5. Index it for search (a folder = the title only; a note = the title + the plaintext content)
        void addOrUpdateDoc({ id, type, title }).catch((e) =>
            console.warn("Failed to index new item", e),
        );

        // 6. Fire-and-forget push to the server
        pushItem(item).catch(() => enqueueMutation(item.id, "upsert"));

        return item;
    }

    /**
     * A client-side cycle check before the local write (the server still enforces it in the
     * batch). The map is built outside the write transaction so we do not hold one across getAll.
     */
    static async #assertNoFolderCycle(itemId: string, newParentId: string | null): Promise<void> {
        if (newParentId === null || itemId === newParentId) return;
        const db = await getDB();
        const all = await db.getAll("items");
        const item = all.find((i) => i.id === itemId);
        if (!item || item.type !== "folder") return;
        const parentMap = new Map(all.map((i) => [i.id, i.parent_id]));
        if (createsCycle(itemId, newParentId, parentMap)) {
            throw new Error("Cannot move a folder into its own descendant");
        }
    }

    static async updateParent(itemId: string, newParentId: string | null) {
        await ItemService.#assertNoFolderCycle(itemId, newParentId);

        const db = await getDB();
        const tx = db.transaction("items", "readwrite");
        const store = tx.objectStore("items");

        const item = await store.get(itemId);
        if (!item) throw new Error("Item not found");

        // A folder cannot be moved into itself
        if (itemId === newParentId) return;

        item.parent_id = newParentId;
        await ItemService.saveLocalMutationAndPush(item, store, tx);
    }

    static async updateItemOrder(itemId: string, newParentId: string | null, newSortOrder: string) {
        await ItemService.#assertNoFolderCycle(itemId, newParentId);

        const db = await getDB();
        const tx = db.transaction("items", "readwrite");
        const store = tx.objectStore("items");

        const item = await store.get(itemId);
        if (!item) throw new Error("Item not found");

        // Prevent dropping a folder into itself
        if (itemId === newParentId) return;

        item.parent_id = newParentId;
        item.sort_order = newSortOrder;
        await ItemService.saveLocalMutationAndPush(item, store, tx);
    }

    static async getDecryptedItem(id: string) {
        const db = await getDB();
        const item = await db.get("items", id);
        if (!item) return null;

        try {
            const payload = await decryptItemPayload<NotePayload>(item);
            return { ...item, payload };
        } catch (e) {
            console.error("Failed to decrypt item payload", e);
            return null;
        }
    }

    /**
     * The fallback: keep an editor's text as a NEW conflict copy of `noteId`, when the copy a push
     * 409 made from that editor is no longer there to write into. The same path as a detected
     * concurrent edit — the inbox, a toast, a reload — and the original is not touched.
     */
    static async saveTextAsConflictCopy(
        noteId: string,
        contentTitle: string,
        content: string,
    ): Promise<void> {
        await withItemWriteLock(noteId, async () => {
            const db = await getDB();
            const item = await db.get("items", noteId);
            if (!item) throw new ItemGoneError(noteId);
            const payload = await decryptItemPayload<Record<string, unknown>>(item);
            await saveAsConcurrentConflictCopy(item, { ...payload, contentTitle, content });
        });
    }

    static async updateItemPayload(
        id: string,
        contentTitle: string,
        content: string,
        opts: {
            basedOnContent?: string | (() => string | undefined);
            intoConflictCopy?: () => string | undefined;
        } = {},
    ) {
        await ItemService.reencryptAndSave(id, (p) => ({ ...p, contentTitle, content }), {
            required: true,
            basedOnContent: opts.basedOnContent,
            intoConflictCopy: opts.intoConflictCopy,
            reindex: (payload, item) => ({
                id,
                type: item.type,
                title: (payload.title as string) || "Untitled",
                content: item.type === "note" ? extractPlainText(content) : undefined,
            }),
        });
    }

    static async updateItemColor(id: string, color: string) {
        await ItemService.reencryptAndSave(id, (p) => ({ ...p, color }));
    }

    static async appendFileToNote(
        noteId: string,
        fileId: string,
        fileName: string,
        mime?: string,
        /**
         * The image's intrinsic dimensions. Without them an embed inserted this way jumps
         * on its FIRST render — the self-heal writes them only after `img.load`, which comes after
         * decryption. Restore and move already have them from the decrypted payload, so they pass
         * them through.
         */
        dims?: { width?: number; height?: number },
    ) {
        // Append the file node to the end of the content.
        // TipTap expects an img tag carrying data-file-id for its encFile node.
        // Escape the attribute — a File.name may contain a " and break the HTML, or inject
        // attributes of its own.
        const esc = (s: string) =>
            s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
        const mimeAttr = mime ? ` data-mime="${esc(mime)}"` : "";
        const dimAttrs =
            dims?.width && dims?.height
                ? ` data-w="${Math.round(dims.width)}" data-h="${Math.round(dims.height)}"`
                : "";
        const nodeHtml = `<p><img data-file-id="${esc(fileId)}" alt="${esc(fileName)}"${mimeAttr}${dimAttrs}></img></p>`;

        await ItemService.reencryptAndSave(
            noteId,
            (p) => ({ ...p, content: ((p.content as string) || "") + nodeHtml }),
            {
                required: true,
                reindex: (payload, item) => ({
                    id: noteId,
                    type: item.type,
                    title: (payload.title as string) || "Untitled",
                    content: extractPlainText((payload.content as string) || ""),
                }),
            },
        );
    }

    static async updateItemTitle(id: string, title: string) {
        await ItemService.reencryptAndSave(id, (p) => ({ ...p, title }), {
            reindex: (payload, item) => ({
                id,
                type: item.type,
                title,
                content:
                    item.type === "note" && payload.content
                        ? extractPlainText(payload.content as string)
                        : undefined,
            }),
        });
    }

    static async updateItemIcon(id: string, icon: string) {
        await ItemService.reencryptAndSave(id, (p) => ({ ...p, icon }));
    }

    static async updateItemStarred(id: string, starred: boolean) {
        await ItemService.reencryptAndSave(id, (p) => ({ ...p, starred }));
    }

    static async deleteItem(id: string) {
        const db = await getDB();

        // Collect every item for the soft delete (itself + every descendant).
        // V3: files are 1:1 with their chunk set; no shared-blob lookup is needed.
        const allItems = await db.getAll("items");
        const idsToDelete = collectDescendants(allItems, [id]);

        const now = Math.floor(Date.now() / 1000);
        const batchId = uuidv7();
        const trashed: LocalItem[] = [];
        const tx = db.transaction("items", "readwrite");
        const store = tx.objectStore("items");

        for (const deleteId of idsToDelete) {
            const item = await store.get(deleteId);
            // FileLifecycle approves the transition, not a hand-rolled field check. It
            // covers both an already TRASHED item (keeping the original trashed_batch_id) and a
            // locally tombstoned DELETED row — `permanentDeleteItem` and `FileService.hardDelete` set
            // ONLY `purged_at`, so the old `!item.deleted_at` condition would trash it again and push
            // an upsert for a permanently deleted item.
            if (item && FileLifecycle.can(FileLifecycle.stateOf(item), "trash")) {
                item.deleted_at = now;
                item.trashed_batch_id = batchId;
                // Synced trash (7b): a trash is a NORMAL mutation — dirty=true plus a push, so the
                // trash state propagates to other devices. (Before: local only, dirty=false, and the
                // mutation dropped.)
                item.dirty = true;
                item.localRev = (item.localRev || 0) + 1;
                item.updated_at = now;
                await store.put(item);
                trashed.push(item);
            }
        }
        await tx.done;

        for (const it of trashed) {
            void removeDoc(it.id).catch((e) =>
                console.warn(`Failed to remove ${it.id} from index`, e),
            );
            // Drop the cached blob URL and tell the encFile NodeViews to run load() again, so they
            // detect deleted_at and show the "File in trash / Restore" placeholder.
            void fileBridge.invalidateFile(it.id).catch(() => {});
            // Push the trash state (offline → the mutation queue).
            pushItem(it).catch(() => enqueueMutation(it.id, "upsert"));
        }

        if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent(APP_EVENTS.vaultItemsChanged));
        }
    }

    static async duplicateItem(
        id: string,
    ): Promise<{ item: LocalItem; strippedAttachments: number }> {
        const original = await ItemService.getDecryptedItem(id);
        if (!original) throw new Error("Item not found");
        // Files reference chunk sets on the server; duplicating one is not supported yet.
        if (original.type === "file") throw new Error("Cannot duplicate a file");

        const title = `Copy of ${original.payload?.title || "Untitled"}`;
        const newItem = await ItemService.createItem(
            original.type,
            original.parent_id,
            title,
            `${original.sort_order}b${Date.now()}`,
        );

        let strippedAttachments = 0;
        if (original.type === "note" && original.payload?.content) {
            const raw = original.payload.content as string;
            // One file = one owning note — the copy keeps the text, not the vault references.
            const { html, strippedCount } = stripAllFileRefsFromHtml(raw);
            strippedAttachments = strippedCount;
            await ItemService.updateItemPayload(newItem.id, title, html);
        }

        if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent(APP_EVENTS.vaultItemsChanged));
        }
        return { item: newItem, strippedAttachments };
    }

    static async restoreItem(id: string) {
        const db = await getDB();
        const root = await db.get("items", id);
        if (!root?.deleted_at) return;

        // Cascade: restore the item itself plus every currently trashed descendant — the mirror of
        // deleteItem's collection. Without it, restoring a folder or note leaves its children in
        // Trash forever. Note: without `trashed_batch_id` provenance we restore ALL trashed
        // descendants, not only those deleted together — better than today's "nothing comes back";
        // the provenance arrives with the trash-sync phase.
        const allItems = await db.getAll("items");
        const byId = new Map(allItems.map((i) => [i.id, i]));
        const targetBatchId = root.trashed_batch_id;

        // DOWN: restore itself + the trashed descendants (expanding ONLY from the id's subtree — siblings are untouched).
        const idsToRestore = collectDescendants(allItems, [id], (it) => {
            if (!it.deleted_at) return false;
            // If the root has a trashed_batch_id, only descendants with the same one are restored.
            if (targetBatchId) return it.trashed_batch_id === targetBatchId;
            return true;
        });

        // UPWARDS: restore trashed ANCESTORS, so the item returns to its original folder rather than
        // the root. This does not spread to their other children (only the ancestor chain is added,
        // with no downward expansion).
        {
            const seen = new Set<string>();
            let pid = root.parent_id;
            while (pid && !seen.has(pid)) {
                seen.add(pid);
                const p = byId.get(pid);
                if (!p?.deleted_at) break; // a live or missing ancestor → the end of the chain
                idsToRestore.add(pid);
                pid = p.parent_id;
            }
        }

        const now = Math.floor(Date.now() / 1000);
        const restoredItems: LocalItem[] = [];
        const tx = db.transaction("items", "readwrite");
        const store = tx.objectStore("items");
        for (const rid of idsToRestore) {
            const item = await store.get(rid);
            if (!item?.deleted_at) continue;

            // The invariant "child READY ⟹ parent READY": if the parent is neither in the restore set
            // nor alive (gone, purged, or still trashed), send the item to the root rather than into
            // limbo. The up-cascade above means trashed ancestors are already in
            // the set → this catches only purged parents.
            let parentId = item.parent_id;
            if (parentId && !idsToRestore.has(parentId)) {
                const owner = byId.get(parentId);
                if (!owner || owner.deleted_at) parentId = null;
            }

            const restored: LocalItem = {
                ...item,
                parent_id: parentId,
                deleted_at: undefined,
                trashed_batch_id: undefined,
                dirty: true,
                localRev: (item.localRev || 0) + 1,
                updated_at: now,
            };
            await store.put(restored);
            restoredItems.push(restored);
        }
        await tx.done;

        for (const it of restoredItems) {
            // The file is READY again — tell the encFile NodeViews to drop the "in trash" placeholder.
            if (it.type === "file") {
                void fileBridge.invalidateFile(it.id).catch(() => {});
            } else if (it.encrypted_payload && it.payload_nonce) {
                void (async () => {
                    try {
                        const p = await decryptItemPayload<Partial<NotePayload>>(it);
                        await addOrUpdateDoc({
                            id: it.id,
                            type: it.type,
                            title: p.title || "Untitled",
                            content:
                                it.type === "note" && p.content
                                    ? extractPlainText(p.content)
                                    : undefined,
                        });
                    } catch (e) {
                        console.warn(`Failed to index restored item ${it.id}`, e);
                    }
                })();
            }
            pushItem(it).catch(() => enqueueMutation(it.id, "upsert"));
        }
    }

    /**
     * Hard delete — the ONLY client-side purge path: a local IDB cleanup, invalidation,
     * and a batch `delete_ids` towards the server. On a network error it goes into the mutation
     * queue, so a purge (including "Empty trash") works offline too.
     */
    static async permanentDeleteItem(idOrIds: string | string[]) {
        const seeds = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
        if (seeds.length === 0) return;

        const db = await getDB();
        // Cascade: purge the seeds plus every TRASHED descendant of theirs, files included —
        // otherwise purging a note leaves its files as orphans (item rows plus chunk sets) that eat
        // quota. Only trashed descendants, so a live (READY) row is never purged.
        const allItems = await db.getAll("items");
        const ids = collectDescendants(allItems, seeds, (it) => !!it.deleted_at);

        const now = Math.floor(Date.now() / 1000);
        const purgedChunkSets: string[] = [];
        const tx = db.transaction("items", "readwrite");
        const store = tx.objectStore("items");
        for (const id of ids) {
            const item = await store.get(id);
            if (item) {
                item.purged_at = now;
                // A tombstone carries nothing worth preserving: the queued delete supersedes any
                // pending upsert, and a `dirty` left on it made the pull's tombstone branches build a
                // conflict copy of a permanently deleted item (a live "[Conflict …]" resurrection).
                item.dirty = false;
                item.sync_error = undefined;
                await store.put(item);
                if (item.type === "file" && item.chunk_set_id) {
                    purgedChunkSets.push(item.chunk_set_id);
                }
            }
            void removeDoc(id).catch(() => {});
            // Files: clear the blob and thumbnail cache, and tell the NodeViews
            void fileBridge.invalidateFile(id).catch(() => {});
        }
        await tx.done;

        // Write the delete queue entry BEFORE going to the network
        for (const id of ids) {
            await enqueueMutation(id, "delete");
        }

        // Permanently deleted → drop the local ciphertext cache too. After the
        // transaction, so an IDB transaction is not held across the file-chunks writes.
        for (const chunkSetId of purgedChunkSets) {
            void evictChunkSet(chunkSetId).catch(() => {});
        }

        // Serialize with other pushes to prevent race conditions
        void pushDeletes([...ids]);

        if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent(APP_EVENTS.vaultItemsChanged));
        }
    }
}
