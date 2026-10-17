import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/core/api", () => ({
    pingUploadSession: vi.fn(),
}));

import { pingUploadSession } from "$lib/core/api";
import { ApiError } from "$lib/core/api/client";
import { ACTIVE_HEARTBEAT_MS, createActiveHeartbeat, pingOrExpire } from "./upload-heartbeat";

describe("pingOrExpire", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns ok for live session", async () => {
        vi.mocked(pingUploadSession).mockResolvedValue({
            ok: true,
            session_status: "uploading",
        });
        expect(await pingOrExpire("cs-1")).toBe("ok");
    });

    it("returns expired for aborted session", async () => {
        vi.mocked(pingUploadSession).mockResolvedValue({
            ok: true,
            session_status: "aborted",
        });
        expect(await pingOrExpire("cs-1")).toBe("expired");
    });

    // What the ping really throws for a session the server no longer has — the code, with the
    // status beside it. The text alone is `no_session`, not "not found".
    it("returns expired when the server no longer has the session (404 no_session, 410)", async () => {
        vi.mocked(pingUploadSession).mockRejectedValue(
            new ApiError("no_session", 404, { error: "no_session" }),
        );
        expect(await pingOrExpire("cs-1")).toBe("expired");
        vi.mocked(pingUploadSession).mockRejectedValue(new ApiError("gone", 410, {}));
        expect(await pingOrExpire("cs-1")).toBe("expired");
    });

    it("rethrows a network failure or a server error — the session may be alive", async () => {
        vi.mocked(pingUploadSession).mockRejectedValue(new TypeError("Failed to fetch"));
        await expect(pingOrExpire("cs-1")).rejects.toThrow("Failed to fetch");
        vi.mocked(pingUploadSession).mockRejectedValue(new ApiError("Internal Server Error", 500));
        await expect(pingOrExpire("cs-1")).rejects.toThrow("Internal Server Error");
    });
});

describe("createActiveHeartbeat", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.mocked(pingUploadSession).mockResolvedValue({
            ok: true,
            session_status: "uploading",
        });
    });

    it("pings at most once per ACTIVE_HEARTBEAT_MS", async () => {
        const hb = createActiveHeartbeat("cs-hb");
        await hb.tick();
        expect(pingUploadSession).not.toHaveBeenCalled();

        vi.advanceTimersByTime(ACTIVE_HEARTBEAT_MS + 1);
        await hb.tick();
        expect(pingUploadSession).toHaveBeenCalledOnce();
        hb.stop();
        vi.useRealTimers();
    });
});
