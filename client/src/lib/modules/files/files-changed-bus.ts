// The domain events "files/notes have changed" → the bridge in (app)/+layout.svelte listens for
// them and does the query invalidation. FileService/move publish; they do NOT import QueryClient or
// Svelte. That puts the invalidation in ONE place.
//
// The rules: idempotent + coalesced (several emits in the same microtask → one flush), with a
// mount-buffer (an event fired before the bridge subscribes reaches the first listener).

type Listener = (ids: string[]) => void;

/** A small coalesced pub/sub channel (keyed by ids). */
function makeChannel() {
    const listeners = new Set<Listener>();
    let pending: Set<string> | null = null;
    let scheduled = false;

    function flush(): void {
        scheduled = false;
        if (!pending || listeners.size === 0) return; // no listeners → hold on to the buffer
        const batch = [...pending];
        pending = null;
        for (const cb of listeners) cb(batch);
    }
    function schedule(): void {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(flush);
    }

    return {
        emit(ids: string[]): void {
            if (!pending) pending = new Set();
            for (const id of ids) pending.add(id);
            schedule();
        },
        on(cb: Listener): () => void {
            listeners.add(cb);
            if (pending) schedule(); // deliver the buffer gathered before the mount
            return () => {
                listeners.delete(cb);
            };
        },
    };
}

const filesChannel = makeChannel();
const notesChannel = makeChannel();

/** Files (by id) changed → the bridge invalidates treeItems + deletedItems. */
export const emitFilesChanged = (ids: string[]): void => filesChannel.emit(ids);
export const onFilesChanged = (cb: Listener): (() => void) => filesChannel.on(cb);

/** Notes (by id) changed (an embed strip/append during a move, say) → the bridge invalidates the note(id) cache. */
export const emitNotesChanged = (ids: string[]): void => notesChannel.emit(ids);
export const onNotesChanged = (cb: Listener): (() => void) => notesChannel.on(cb);
