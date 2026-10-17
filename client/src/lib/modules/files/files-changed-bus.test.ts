import { afterEach, describe, expect, it, vi } from "vitest";
import {
    emitFilesChanged,
    emitNotesChanged,
    onFilesChanged,
    onNotesChanged,
} from "./files-changed-bus";

/** Waits for the coalesce flush (queueMicrotask). Two microtasks, to be safe. */
const flush = () => new Promise<void>((r) => queueMicrotask(() => queueMicrotask(r)));

// Drain any leftover buffer between tests (an emit with no listener stays pending).
afterEach(async () => {
    const a = onFilesChanged(() => {});
    const b = onNotesChanged(() => {});
    await flush();
    a();
    b();
});

describe("files-changed-bus — the files channel", () => {
    it("delivers the emitted ids to the listener", async () => {
        const cb = vi.fn();
        const unsub = onFilesChanged(cb);
        emitFilesChanged(["a"]);
        await flush();
        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb).toHaveBeenCalledWith(["a"]);
        unsub();
    });

    it("coalesce + dedupe: several emits in the same tick → one flush, unique ids", async () => {
        const cb = vi.fn();
        const unsub = onFilesChanged(cb);
        emitFilesChanged(["a"]);
        emitFilesChanged(["b", "a"]);
        emitFilesChanged(["c"]);
        await flush();
        expect(cb).toHaveBeenCalledTimes(1);
        const ids = cb.mock.calls[0]?.[0] ?? [];
        expect([...ids].sort()).toEqual(["a", "b", "c"]);
        unsub();
    });

    it("mount-buffer: an emit before the subscription → it reaches the first listener", async () => {
        emitFilesChanged(["x"]);
        const cb = vi.fn();
        const unsub = onFilesChanged(cb); // subscribing AFTER the emit
        await flush();
        expect(cb).toHaveBeenCalledWith(["x"]);
        unsub();
    });

    it("unsubscribe stops the delivery", async () => {
        const cb = vi.fn();
        const unsub = onFilesChanged(cb);
        unsub();
        emitFilesChanged(["a"]);
        await flush();
        expect(cb).not.toHaveBeenCalled();
    });
});

describe("files-changed-bus — the channels are separate", () => {
    it("a files emit does not fire a notes listener, and vice versa", async () => {
        const files = vi.fn();
        const notes = vi.fn();
        const u1 = onFilesChanged(files);
        const u2 = onNotesChanged(notes);
        emitFilesChanged(["f"]);
        emitNotesChanged(["n"]);
        await flush();
        expect(files).toHaveBeenCalledWith(["f"]);
        expect(notes).toHaveBeenCalledWith(["n"]);
        expect(files).toHaveBeenCalledTimes(1);
        expect(notes).toHaveBeenCalledTimes(1);
        u1();
        u2();
    });
});
