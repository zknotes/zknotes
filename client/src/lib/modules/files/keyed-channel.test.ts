import { describe, expect, it, vi } from "vitest";
import { createKeyedChannel } from "./keyed-channel";

describe("createKeyedChannel", () => {
    it("delivers an emit only to the subscribers of the same key", () => {
        const ch = createKeyedChannel();
        const a = vi.fn();
        const b = vi.fn();
        ch.on("file-1", a);
        ch.on("file-2", b);

        ch.emit("file-1");
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).not.toHaveBeenCalled();
    });

    it("passes the argument to every subscriber of a key", () => {
        const ch = createKeyedChannel<number>();
        const a = vi.fn();
        const b = vi.fn();
        ch.on("k", a);
        ch.on("k", b);

        ch.emit("k", 42);
        expect(a).toHaveBeenCalledWith(42);
        expect(b).toHaveBeenCalledWith(42);
    });

    it("unsubscribe stops any further delivery", () => {
        const ch = createKeyedChannel();
        const cb = vi.fn();
        const off = ch.on("k", cb);

        ch.emit("k");
        off();
        ch.emit("k");
        expect(cb).toHaveBeenCalledTimes(1);
    });

    it("allows an unsubscribe from inside a callback without skipping the others (a copy of the set)", () => {
        const ch = createKeyedChannel();
        const calls: string[] = [];
        const offA = ch.on("k", () => {
            calls.push("a");
            offA();
        });
        ch.on("k", () => calls.push("b"));

        ch.emit("k");
        expect(calls).toEqual(["a", "b"]);
    });

    it("an emit on an unknown key is a no-op", () => {
        const ch = createKeyedChannel();
        expect(() => ch.emit("missing")).not.toThrow();
    });
});
