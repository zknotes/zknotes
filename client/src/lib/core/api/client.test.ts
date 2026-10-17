import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, ApiError, isServerUnreachableError } from "./client";

describe("apiFetch client", () => {
    it("throws ApiError with status property on HTTP non-2xx errors", async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 413,
            statusText: "Payload Too Large",
            json: () => Promise.resolve({ error: "payload_too_large" }),
        } as Response);

        try {
            await apiFetch("/items/batch", { method: "POST" });
            expect.unreachable("should have thrown ApiError");
        } catch (err: any) {
            expect(err).toBeInstanceOf(ApiError);
            expect(err.status).toBe(413);
            expect(err.message).toBe("payload_too_large");
        }
    });

    it("respects AbortSignal timeout on long-running requests", async () => {
        globalThis.fetch = vi.fn().mockImplementation((_url, opts) => {
            return new Promise((_resolve, reject) => {
                if (opts?.signal) {
                    opts.signal.addEventListener("abort", () => {
                        reject(new DOMException("The operation was aborted.", "TimeoutError"));
                    });
                }
            });
        });

        // Test custom signal abort
        const controller = new AbortController();
        const promise = apiFetch("/slow", { signal: controller.signal });
        controller.abort();

        await expect(promise).rejects.toThrow("aborted");
    });
});

describe("isServerUnreachableError", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    async function failureOf(promise: Promise<unknown>): Promise<unknown> {
        try {
            await promise;
        } catch (err) {
            return err;
        }
        return expect.unreachable("should have thrown");
    }

    it("recognises a request that got no response, and rethrows the browser's own error", async () => {
        const networkError = new TypeError("Failed to fetch");
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));

        const err = await failureOf(apiFetch("/auth/kdf-params", { method: "POST" }));

        // Callers elsewhere match on the type and the message (upload-errors), so it stays the same object.
        expect(err).toBe(networkError);
        expect(isServerUnreachableError(err)).toBe(true);
    });

    it("recognises our own timeout", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockRejectedValue(new DOMException("signal timed out", "TimeoutError")),
        );
        expect(isServerUnreachableError(await failureOf(apiFetch("/auth/me")))).toBe(true);
    });

    it("recognises a browser that already knows it is offline", async () => {
        vi.stubGlobal("navigator", { onLine: false });
        vi.stubGlobal("fetch", vi.fn());
        expect(isServerUnreachableError(await failureOf(apiFetch("/auth/me")))).toBe(true);
    });

    it("does not count a request the caller aborted", async () => {
        const controller = new AbortController();
        vi.stubGlobal(
            "fetch",
            vi.fn().mockImplementation(() => {
                controller.abort();
                return Promise.reject(new DOMException("aborted", "AbortError"));
            }),
        );
        const err = await failureOf(apiFetch("/uploads/x", { signal: controller.signal }));
        expect(isServerUnreachableError(err)).toBe(false);
    });

    it("counts a proxy reporting the API down (502, 504) but not the API's own errors", () => {
        expect(isServerUnreachableError(new ApiError("Bad Gateway", 502))).toBe(true);
        expect(isServerUnreachableError(new ApiError("Gateway Timeout", 504))).toBe(true);
        // 503 is the API itself saying it is busy — it answered, so it is not unreachable.
        expect(isServerUnreachableError(new ApiError("service_unavailable", 503))).toBe(false);
        expect(isServerUnreachableError(new ApiError("Internal Server Error", 500))).toBe(false);
        expect(isServerUnreachableError(new ApiError("invalid_credentials", 401))).toBe(false);
    });

    it("does not mistake a TypeError from a bug for a network failure", () => {
        expect(isServerUnreachableError(new TypeError("x is undefined"))).toBe(false);
        expect(isServerUnreachableError("Failed to fetch")).toBe(false);
        expect(isServerUnreachableError(null)).toBe(false);
    });
});

describe("apiFetch timeoutMs", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("uses the per-call timeout, and does not hand the option to fetch", async () => {
        const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({}),
        });
        vi.stubGlobal("fetch", fetchMock);

        await apiFetch("/auth/kdf-params", { method: "POST", timeoutMs: 1234 });

        expect(timeoutSpy).toHaveBeenCalledWith(1234);
        expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("timeoutMs");
    });
});
