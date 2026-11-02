// The "file became local" channel: a keyed subscription, separate from the invalidation one.
import { describe, expect, it, vi } from "vitest";
import { notifyFileLocal, onFileInvalidated, onFileLocal } from "./file-invalidator";

describe("onFileLocal / notifyFileLocal", () => {
    it("calls only the subscribers of that fileId, and not the invalidation listeners", () => {
        const localA = vi.fn();
        const localB = vi.fn();
        const invalidatedA = vi.fn();
        const offA = onFileLocal("a", localA);
        onFileLocal("b", localB);
        onFileInvalidated("a", invalidatedA);

        notifyFileLocal("a");

        expect(localA).toHaveBeenCalledTimes(1);
        expect(localB).not.toHaveBeenCalled();
        expect(invalidatedA).not.toHaveBeenCalled();

        offA();
        notifyFileLocal("a");
        expect(localA).toHaveBeenCalledTimes(1);
    });
});
