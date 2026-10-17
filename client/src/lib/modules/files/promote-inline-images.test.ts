import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./limits", () => {
    const getMaxFileSize = vi.fn(() => 100_000);
    return {
        getMaxFileSize,
        getMaxFileSizeMB: vi.fn(() => 0),
        refreshFileLimits: vi.fn().mockResolvedValue(undefined),
        // A known limit, the mocked one; the rule for an unknown limit is limits.test.ts's.
        exceedsKnownFileSizeLimit: vi.fn((size: number) => size > getMaxFileSize()),
    };
});

vi.mock("./editor-images", () => ({
    preparePendingUpload: vi.fn(),
}));

vi.mock("./upload-manager", () => ({
    startUpload: vi.fn(),
}));

vi.mock("$lib/core/stores/toast.svelte", () => ({
    globalToasts: { add: vi.fn() },
}));

import { exceedsKnownFileSizeLimit, getMaxFileSize } from "./limits";
import { rewriteDataImagesInHtml, restoreInFlightDataUrls } from "./promote-inline-images";
import {
    clearNotePromote,
    inFlightPromoteCount,
    restoreInFlightDataUrls as restoreDirect,
    trackInFlight,
    untrackInFlight,
} from "./promote-inflight";
import { replaceHugeDataImageTags } from "./refs";

const TINY_PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("rewriteDataImagesInHtml", () => {
    beforeEach(() => {
        vi.mocked(getMaxFileSize).mockReturnValue(100_000);
    });

    it("converts 2 data: imgs and keeps the text", () => {
        const html = `<p>hello</p><img src="${TINY_PNG}" alt="a" /><p>mid</p><img width="300" src="${TINY_PNG}" alt="b" />`;
        const { html: out, jobs, skipped } = rewriteDataImagesInHtml(html);
        expect(skipped).toBe(0);
        expect(jobs).toHaveLength(2);
        expect(out).toContain("hello");
        expect(out).toContain("mid");
        expect(out).not.toContain("data:image");
        expect(out).toContain('data-file-id="local:');
        expect(out).toContain('width="300"');
        expect(out).not.toMatch(/\bsrc\s*=\s*["']\s*["']/); // no empty src
        expect(jobs[0]?.localId).toBeTruthy();
        expect(jobs[0]?.dataUrl.startsWith("data:image")).toBe(true);
    });

    it("leaves an existing data-file-id alone", () => {
        const html = `<img data-file-id="f1" src="blob:x" /><img src="${TINY_PNG}" />`;
        const { html: out, jobs } = rewriteDataImagesInHtml(html);
        expect(jobs).toHaveLength(1);
        expect(out).toContain('data-file-id="f1"');
    });

    it("does not promote a remote https image", () => {
        const html = `<img src="https://example.com/a.png" />`;
        const { html: out, jobs } = rewriteDataImagesInHtml(html);
        expect(jobs).toHaveLength(0);
        expect(out).toBe(html);
    });

    it("size guard: above max → skipped, the tag untouched", () => {
        vi.mocked(getMaxFileSize).mockReturnValue(100);
        // the base64 length * 3/4 >> 100
        const huge = `data:image/png;base64,${"A".repeat(500)}`;
        const html = `<img src="${huge}" alt="big" />`;
        const { html: out, jobs, skipped } = rewriteDataImagesInHtml(html);
        expect(skipped).toBe(1);
        expect(jobs).toHaveLength(0);
        expect(out).toBe(html);
    });

    it("the chain with replaceHugeDataImageTags on an oversized image", () => {
        vi.mocked(getMaxFileSize).mockReturnValue(100);
        const huge = `data:image/png;base64,${"A".repeat(100_000)}`;
        const html = `<p>x</p><img src="${huge}" alt="pic" />`;
        const { html: mid } = rewriteDataImagesInHtml(html);
        const safe = replaceHugeDataImageTags(mid);
        expect(safe).not.toContain("data:image");
        expect(safe).toContain("Inline image");
    });

    // An offline cold start knows no limit. The image used to be skipped as too large, and
    // replaceHugeDataImageTags then swapped it for a placeholder; now it is promoted and the server
    // decides.
    it("no limit known: a data: image is promoted, not skipped", () => {
        vi.mocked(getMaxFileSize).mockReturnValue(0);
        vi.mocked(exceedsKnownFileSizeLimit).mockImplementationOnce(() => false);
        const html = `<p>x</p><img src="data:image/png;base64,${"A".repeat(500)}" alt="pic" />`;
        const { html: out, jobs, skipped } = rewriteDataImagesInHtml(html);
        expect(skipped).toBe(0);
        expect(jobs).toHaveLength(1);
        expect(out).toContain('data-file-id="local:');
    });

    it("synchronous — it does not return a Promise", () => {
        const r = rewriteDataImagesInHtml(`<img src="${TINY_PNG}" />`);
        expect(r).not.toBeInstanceOf(Promise);
        expect(r.jobs.length).toBe(1);
    });
});

describe("promote-inflight restore", () => {
    beforeEach(() => {
        clearNotePromote("n1");
    });

    it("restoreInFlightDataUrls brings data: back for an in-flight local:", () => {
        trackInFlight("n1", {
            localId: "abc",
            dataUrl: TINY_PNG,
            alt: "x",
        });
        expect(inFlightPromoteCount("n1")).toBe(1);
        const html = `<p>t</p><img data-file-id="local:abc" alt="x" />`;
        const out = restoreDirect(html, "n1");
        expect(out).toContain(`src="${TINY_PNG}"`);
        expect(out).not.toContain("data-file-id");
        untrackInFlight("n1", "abc");
        expect(inFlightPromoteCount("n1")).toBe(0);
    });

    it("re-export restoreInFlightDataUrls s promote-inline-images", () => {
        trackInFlight("n1", { localId: "z", dataUrl: TINY_PNG, alt: "a" });
        const out = restoreInFlightDataUrls(`<img data-file-id="local:z" />`, "n1");
        expect(out).toContain("data:image");
        clearNotePromote("n1");
    });
});
