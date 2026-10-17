/**
 * A sign-in against a server that accepts the connection and never answers (paused, or wedged on its
 * database) waited out the general 30 s timeout before saying anything. Its first request is a
 * lookup the server answers in milliseconds, so it gives up much sooner.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getKdfParams } from "./auth";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("getKdfParams", () => {
    it("gives up well before the general 30 s timeout", async () => {
        const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                headers: new Headers(),
                json: async () => ({ kdf_salt: "", kdf_params: { m: 65536, t: 3, p: 1 } }),
            }),
        );

        await getKdfParams("someone@example.com");

        const timeoutMs = timeoutSpy.mock.calls[0]?.[0] ?? Number.POSITIVE_INFINITY;
        expect(timeoutMs).toBeLessThanOrEqual(10_000);
    });
});
