/**
 * The StorageSegments contract: each share is a percentage of the quota, capped at 100 %, a zero
 * quota draws nothing, and `overLimit` repaints every segment that does not keep its colour.
 */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import StorageSegments from "./StorageSegments.svelte";

let target: HTMLElement | undefined;
let instance: Record<string, unknown> | undefined;

afterEach(() => {
    if (instance) {
        unmount(instance);
        instance = undefined;
    }
    target?.remove();
    target = undefined;
});

function render(props: {
    segments: Array<{ label: string; bytes: number; className: string; keepColor?: boolean }>;
    quota: number;
    overLimit?: boolean;
    legend?: boolean;
}) {
    target = document.createElement("div");
    document.body.appendChild(target);
    instance = mount(StorageSegments, { target, props });
    flushSync();
    return target;
}

function widths(root: HTMLElement): string[] {
    return [...root.querySelectorAll<HTMLElement>("[data-segment]")].map((el) => el.style.width);
}

describe("StorageSegments", () => {
    it("draws each share as a percentage of the quota", () => {
        const root = render({
            segments: [
                { label: "Files", bytes: 25, className: "bg-blue-500" },
                { label: "Notes", bytes: 50, className: "bg-brand0" },
            ],
            quota: 100,
        });
        expect(widths(root)).toEqual(["25%", "50%"]);
        expect(root.querySelector("[data-segment='Files']")?.getAttribute("title")).toBe(
            "Files: 0 KB",
        );
    });

    it("caps an over-quota share at 100 % and draws nothing without a quota", () => {
        expect(
            widths(
                render({ segments: [{ label: "Files", bytes: 300, className: "x" }], quota: 100 }),
            ),
        ).toEqual(["100%"]);
        expect(
            widths(
                render({ segments: [{ label: "Files", bytes: 300, className: "x" }], quota: 0 }),
            ),
        ).toEqual(["0%"]);
    });

    it("repaints the segments in the danger colour over the limit, except those that keep theirs", () => {
        const root = render({
            segments: [
                { label: "Files", bytes: 90, className: "bg-blue-500" },
                { label: "Trash", bytes: 20, className: "bg-amber-500/60", keepColor: true },
            ],
            quota: 100,
            overLimit: true,
        });
        expect(root.querySelector("[data-segment='Files']")?.className).toContain(
            "bg-[var(--danger)]",
        );
        expect(root.querySelector("[data-segment='Trash']")?.className).toContain(
            "bg-amber-500/60",
        );
    });

    it("renders the legend with one row per segment when asked", () => {
        const root = render({
            segments: [
                { label: "Files", bytes: 1024 * 1024, className: "bg-blue-500" },
                { label: "Other data", bytes: 0, className: "bg-gray-400" },
            ],
            quota: 100,
            legend: true,
        });
        expect(root.textContent).toContain("Files");
        expect(root.textContent).toContain("Other data");
        expect(root.textContent).toMatch(/1(\.0)? MB/);
    });
});
