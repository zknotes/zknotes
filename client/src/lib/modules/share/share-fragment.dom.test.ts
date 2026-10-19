import { afterEach, describe, expect, it } from "vitest";
import { readShareFragmentKey } from "./share-crypto";

// Saas spec 156 (package G): the fragment key never reaches the server; this reads it out of the URL.
afterEach(() => {
    window.location.hash = "";
});

describe("readShareFragmentKey", () => {
    it("returns the k parameter of the fragment, or null", () => {
        window.location.hash = "#k=abc";
        expect(readShareFragmentKey()).toBe("abc");
        window.location.hash = "#k=a&x=1";
        expect(readShareFragmentKey()).toBe("a");
        window.location.hash = "#x=1";
        expect(readShareFragmentKey()).toBeNull();
        window.location.hash = "";
        expect(readShareFragmentKey()).toBeNull();
    });
});
