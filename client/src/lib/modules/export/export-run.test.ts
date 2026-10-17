import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportRun, type ExportTick } from "./utils";

type Phase = "a" | "b" | "zipping";
const item = (id: string, type = "note") => ({ id, type });

afterEach(() => vi.restoreAllMocks());

describe("ExportRun", () => {
    it("emit sends the current done/total under the given phase", () => {
        const ticks: ExportTick[] = [];
        const run = new ExportRun<ExportTick & { phase: Phase }>(5, (t) => ticks.push(t));
        run.emit("zipping");
        expect(ticks).toEqual([{ phase: "zipping", done: 0, total: 5 }]);
    });

    it("stage emits the start (done=0), then one per entry with done++", async () => {
        const ticks: ExportTick[] = [];
        const run = new ExportRun<ExportTick & { phase: Phase }>(2, (t) => ticks.push({ ...t }));
        const handle = vi.fn().mockResolvedValue(undefined);

        await run.stage("a", [item("1"), item("2")], "Export", handle);

        expect(handle).toHaveBeenCalledTimes(2);
        expect(ticks).toEqual([
            { phase: "a", done: 0, total: 2 }, // start
            { phase: "a", done: 1, total: 2 },
            { phase: "a", done: 2, total: 2 },
        ]);
    });

    it("done runs across several phases (one shared counter)", async () => {
        const ticks: ExportTick[] = [];
        const run = new ExportRun<ExportTick & { phase: Phase }>(3, (t) => ticks.push({ ...t }));
        const ok = vi.fn().mockResolvedValue(undefined);

        await run.stage("a", [item("1")], "Export", ok);
        await run.stage("b", [item("2"), item("3")], "Export", ok);
        run.emit("zipping");

        expect(run.done).toBe(3);
        expect(ticks.at(-1)).toEqual({ phase: "zipping", done: 3, total: 3 });
        // The second phase starts at done=1 (the counter carries on from the first).
        expect(ticks).toContainEqual({ phase: "b", done: 1, total: 3 });
    });

    it("an error in handle → warn + skip, and done still increments", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const run = new ExportRun<ExportTick & { phase: Phase }>(2, undefined);
        const handle = vi
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error("decrypt fail"));

        await run.stage("a", [item("good"), item("bad", "file")], "Export", handle);

        expect(run.done).toBe(2); // both entries moved the counter
        expect(warn).toHaveBeenCalledWith("Export: skipping file bad", expect.any(Error));
    });

    // A skipped item is reported back, not only written to the console.
    it("a failed item lands in skipped with its type and the error's message", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const run = new ExportRun<ExportTick & { phase: Phase }>(3, undefined);
        const handle = vi
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error("Chunk integrity check failed"))
            .mockRejectedValueOnce("not an Error");

        await run.stage("a", [item("good"), item("bad", "file"), item("odd")], "Export", handle);

        expect(run.skipped).toEqual([
            { id: "bad", type: "file", reason: "Chunk integrity check failed" },
            { id: "odd", type: "note", reason: "not an Error" },
        ]);
    });

    it("skip records an item outside a stage the same way", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const run = new ExportRun<ExportTick & { phase: Phase }>(1, undefined);

        run.skip(item("n1"), new Error("decrypt fail"), "HTML export");

        expect(run.skipped).toEqual([{ id: "n1", type: "note", reason: "decrypt fail" }]);
        expect(warn).toHaveBeenCalledWith("HTML export: skipping note n1", expect.any(Error));
    });

    it("it does not throw without an onProgress callback", async () => {
        const run = new ExportRun<ExportTick & { phase: Phase }>(1, undefined);
        await expect(
            run.stage("a", [item("1")], "Export", vi.fn().mockResolvedValue(undefined)),
        ).resolves.toBeUndefined();
        expect(run.done).toBe(1);
    });
});
