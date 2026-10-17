// The domain: the canonical file lifecycle — the ONLY place that knows the states and the permitted
// transitions. Pure, with no I/O, no database and no UI →
// trivial to unit-test and safe to import under SSR.
//
// It covers axis 2 ONLY (a persisted item: READY/TRASHED/DELETED). The upload flow (axis 1) is a
// separate, larger state machine — `UploadPhase` in modules/files/upload-state.ts (13 phases,
// resumable) — because a failed upload never created an item, so there is nothing to assign an
// axis-2 state to.
//
// `FileLifecycle` defines two things: (a) the STATE (`stateOf`) and (b) whether a mutation is ALLOWED
// in that state (`can`) — so it is both a state machine and a guard policy. That is why
// `crop`/`rename`/`move` (READY-only mutations
// which do NOT change the state) live here as guards: they are not allowed on a TRASHED or DELETED file.

export type FileState = "READY" | "TRASHED" | "DELETED";

export type FileAction =
    // they change the state
    | "trash" // READY   → TRASHED
    | "restore" // TRASHED → READY
    | "hardDelete" // TRASHED → DELETED
    // READY-only mutations (they do not change the state; they are guards only)
    | "crop"
    | "rename"
    | "move";

/** The minimal shape of a row a state is derived from (it works with `EncryptedItem`/`LocalItem` alike). */
export type LifecycleRow = {
    deleted_at?: number | null;
    purged_at?: number | null;
};

// The permitted transitions. crop, rename and move are READY→READY (they do not change the state, but
// are allowed only from READY). `transition` can still return them; a service typically uses them
// through `can`, as a guard.
const TRANSITIONS: Readonly<Record<FileState, Readonly<Partial<Record<FileAction, FileState>>>>> = {
    READY: { trash: "TRASHED", crop: "READY", rename: "READY", move: "READY" },
    TRASHED: { restore: "READY", hardDelete: "DELETED" },
    DELETED: {},
};

// biome-ignore lint/complexity/noStaticOnlyClass: the same convention as ItemService.
export class FileLifecycle {
    /**
     * Derives the state from a row that is PRESENT. `purged_at` is the discriminator (a DELETED
     * tombstone) — without it, DELETED would look like TRASHED and `restore` would falsely resurrect it.
     * A missing row (a lookup miss) is not this function's domain but the service's (GONE → an
     * idempotent no-op) — `stateOf` never receives `undefined`.
     */
    static stateOf(item: LifecycleRow): FileState {
        if (item.purged_at != null) return "DELETED";
        return item.deleted_at != null ? "TRASHED" : "READY";
    }

    /** Whether an action is allowed from the given state (a guard before calling the service). */
    static can(from: FileState, action: FileAction): boolean {
        return TRANSITIONS[from][action] !== undefined;
    }

    /** The target state, or a throw on a disallowed transition (strict — for local decisions). */
    static transition(from: FileState, action: FileAction): FileState {
        const to = TRANSITIONS[from][action];
        if (!to) throw new Error(`Illegal file transition: ${from} --${action}-->`);
        return to;
    }
}
