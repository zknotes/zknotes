/**
 * Regression: a restore after a trash must not be left on the "Image in trash" placeholder when the
 * old (trashed) resolveUrl promise settles after a newer successful load.
 * The loadSeq guard's logic lives in enc-file-node.ts addNodeView — here we test the same pattern.
 */
import { describe, expect, it, vi } from "vitest";

describe("encFile loadSeq guard pattern", () => {
    it("an old rejected promise does not overwrite a newer successful render", async () => {
        let loadSeq = 0;
        let domState: "image" | "placeholder" | "loading" = "image";

        const { FileDeletedError } = await import("$lib/modules/files/download");

        function simulateLoad(fileId: string, resolve: () => Promise<{ url: string }>): void {
            const seq = ++loadSeq;
            domState = "loading";

            void resolve()
                .then(({ url }) => {
                    if (seq !== loadSeq) return;
                    domState = url ? "image" : "placeholder";
                })
                .catch((err: unknown) => {
                    if (seq !== loadSeq) return;
                    if ((err as { name?: string })?.name === "FileDeletedError") {
                        domState = "placeholder";
                    }
                });
        }

        let resolveTrashed!: () => void;
        const trashedPromise = new Promise<{ url: string }>((_, reject) => {
            resolveTrashed = () => reject(new FileDeletedError("file-1", "trashed"));
        });

        let resolveReady!: (v: { url: string }) => void;
        const readyPromise = new Promise<{ url: string }>((res) => {
            resolveReady = res;
        });

        // 1) a load while the file is in the trash
        simulateLoad("file-1", () => trashedPromise);
        // 2) restore → invalidate → a new load
        simulateLoad("file-1", () => readyPromise);

        resolveReady({ url: "blob:restored" });
        await vi.waitFor(() => expect(domState).toBe("image"));

        // 3) the old trashed promise settles late — it must not bring the placeholder back
        resolveTrashed();
        await new Promise((r) => setTimeout(r, 10));
        expect(domState).toBe("image");
    });
});
