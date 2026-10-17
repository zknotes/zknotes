// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
    getMaxConcurrentChunks,
    initUploadVisibilityListener,
    isUploadTabHidden,
} from "./upload-visibility";

describe("upload visibility", () => {
    afterEach(() => {
        Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => "visible",
        });
    });

    it("returns 3 concurrent chunks when visible", () => {
        initUploadVisibilityListener();
        expect(isUploadTabHidden()).toBe(false);
        expect(getMaxConcurrentChunks()).toBe(3);
    });

    it("returns 1 concurrent chunk when hidden", () => {
        initUploadVisibilityListener();
        Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));
        expect(isUploadTabHidden()).toBe(true);
        expect(getMaxConcurrentChunks()).toBe(1);
    });
});
