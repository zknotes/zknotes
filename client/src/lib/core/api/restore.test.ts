import { afterEach, describe, expect, it, vi } from "vitest";
import { setUnauthorizedHandler, UnauthorizedError } from "./client";
import { createRestoreSession, getRestoreSession, RestoreClientError } from "./restore";

// The restore client used to carry a private copy of the HTTP transport whose 401 skipped the
// session teardown: a session that expired mid-restore left the vault unlocked. It now shares
// `apiFetch`; what it adds is only the error body the wizard continues from.

function response(status: number, body: unknown): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: `status ${status}`,
        headers: new Headers(),
        json: async () => body,
    } as unknown as Response;
}

afterEach(() => {
    vi.unstubAllGlobals();
    setUnauthorizedHandler(null);
});

describe("restore client", () => {
    it("a 401 runs the registered session teardown handler", async () => {
        const onUnauthorized = vi.fn();
        setUnauthorizedHandler(onUnauthorized);
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(401, { error: "unauthorized" })));

        await expect(getRestoreSession("rs1")).rejects.toBeInstanceOf(UnauthorizedError);
        expect(onUnauthorized).toHaveBeenCalledWith("expired");
    });

    it("a refusal keeps the body the wizard continues from", async () => {
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValue(
                    response(409, { error: "restore_already_open", restore_session_id: "rs9" }),
                ),
        );

        const err = await createRestoreSession({
            backup_hash: "h",
            manifest: [],
            mode: "skip_existing",
        }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RestoreClientError);
        expect((err as RestoreClientError).status).toBe(409);
        expect((err as RestoreClientError).body).toEqual({
            error: "restore_already_open",
            restore_session_id: "rs9",
        });
    });

    it("gives a restore call the long timeout and the session cookie", async () => {
        const fetchMock = vi.fn().mockResolvedValue(response(200, { ok: true }));
        vi.stubGlobal("fetch", fetchMock);

        await getRestoreSession("rs1");
        const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { timeoutMs?: number };
        expect(init.credentials).toBe("include");
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect("timeoutMs" in init).toBe(false);
    });
});
