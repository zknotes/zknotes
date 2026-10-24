import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadPublicWww() {
    return await import("./public-www");
}

describe("instance public config", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("is empty until /instance-config returns", async () => {
        const { getInstancePublicConfig } = await loadPublicWww();
        expect(getInstancePublicConfig()).toBeNull();
    });

    it("loads the AGPL source link so the UI can offer Corresponding Source", async () => {
        // Shipping the client is conveying. A runtime value rather than a build
        // constant — an instance that has modified the client has to point at its own source.
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ sourceUrl: "https://git.example/fork" }),
            }),
        );
        const { loadInstancePublicConfig } = await loadPublicWww();
        expect((await loadInstancePublicConfig()).sourceUrl).toBe("https://git.example/fork");
    });

    it("loads verifyUrl when the instance offers a verification page, and drops an unsafe one", async () => {
        // Settings → About shows "Verify this build" only with this link; a self-host without a page
        // of its own gets none.
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ verifyUrl: "https://zknotes.example/verify" }),
            }),
        );
        const { loadInstancePublicConfig } = await loadPublicWww();
        expect((await loadInstancePublicConfig()).verifyUrl).toBe("https://zknotes.example/verify");

        vi.resetModules();
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ verifyUrl: "javascript:alert(1)" }),
            }),
        );
        const fresh = await loadPublicWww();
        expect((await fresh.loadInstancePublicConfig()).verifyUrl).toBeUndefined();
    });

    it("loads wwwUrl and account.manageUrl from GET /instance-config", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                wwwUrl: "https://zknotes.example",
                account: { manageUrl: "https://account.example/manage" },
            }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { loadInstancePublicConfig, getInstancePublicConfig } = await loadPublicWww();
        const cfg = await loadInstancePublicConfig();

        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringMatching(/\/instance-config$/),
            expect.objectContaining({ credentials: "include", cache: "no-store" }),
        );
        expect(cfg.wwwUrl).toBe("https://zknotes.example");
        expect(cfg.account?.manageUrl).toBe("https://account.example/manage");
        expect(getInstancePublicConfig()).toEqual(cfg);
    });

    it("omits missing fields so the UI can hide those rows (self-host)", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({}),
            }),
        );

        const { loadInstancePublicConfig } = await loadPublicWww();
        const cfg = await loadInstancePublicConfig();

        expect(cfg.wwwUrl).toBeUndefined();
        expect(cfg.account).toBeUndefined();
    });

    it("reuses a successful response without a second fetch", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ wwwUrl: "https://zknotes.example" }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { loadInstancePublicConfig } = await loadPublicWww();
        await loadInstancePublicConfig();
        await loadInstancePublicConfig();

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("treats javascript:, data: and other non-https schemes as missing", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    wwwUrl: "javascript:alert(1)",
                    sourceUrl: "data:text/html,hi",
                    account: { manageUrl: "ftp://files.example/x" },
                }),
            }),
        );

        const { loadInstancePublicConfig } = await loadPublicWww();
        const cfg = await loadInstancePublicConfig();

        expect(cfg.wwwUrl).toBeUndefined();
        expect(cfg.sourceUrl).toBeUndefined();
        expect(cfg.account).toBeUndefined();
    });

    it("accepts https URLs and rejects a relative / invalid value", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    wwwUrl: "https://zknotes.example/about",
                    sourceUrl: "/relative",
                    account: { manageUrl: "not a url" },
                }),
            }),
        );

        const { loadInstancePublicConfig } = await loadPublicWww();
        const cfg = await loadInstancePublicConfig();

        expect(cfg.wwwUrl).toBe("https://zknotes.example/about");
        expect(cfg.sourceUrl).toBeUndefined();
        expect(cfg.account).toBeUndefined();
    });

    it("allows http URLs only in development", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ wwwUrl: "http://localhost:5174" }),
            }),
        );

        const { loadInstancePublicConfig } = await loadPublicWww();
        const cfg = await loadInstancePublicConfig();

        if (import.meta.env.DEV) {
            expect(cfg.wwwUrl).toBe("http://localhost:5174");
        } else {
            expect(cfg.wwwUrl).toBeUndefined();
        }
    });

    it("does not cache a failed fetch, so a later call can recover", async () => {
        const fetchMock = vi
            .fn()
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ wwwUrl: "https://zknotes.example" }),
            });
        vi.stubGlobal("fetch", fetchMock);

        const { loadInstancePublicConfig } = await loadPublicWww();
        const first = await loadInstancePublicConfig();
        const second = await loadInstancePublicConfig();

        expect(first.wwwUrl).toBeUndefined();
        expect(second.wwwUrl).toBe("https://zknotes.example");
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    describe("refreshInstancePublicConfig — the sign-in screen's reachability probe", () => {
        it("throws when no response comes back, so the screen knows the server is away", async () => {
            vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
            const { refreshInstancePublicConfig } = await loadPublicWww();
            await expect(refreshInstancePublicConfig()).rejects.toThrow("Failed to fetch");
        });

        it("throws when the proxy reports the API down", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn().mockResolvedValue({ ok: false, status: 502, statusText: "Bad Gateway" }),
            );
            const { refreshInstancePublicConfig } = await loadPublicWww();
            await expect(refreshInstancePublicConfig()).rejects.toMatchObject({ status: 502 });
        });

        it("resolves empty for a server that answers without the route (an older one)", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" }),
            );
            const { refreshInstancePublicConfig, getInstancePublicConfig } = await loadPublicWww();
            expect(await refreshInstancePublicConfig()).toEqual({});
            expect(getInstancePublicConfig()).toBeNull();
        });

        it("always asks the server — a probe answered from the cache would prove nothing", async () => {
            const fetchMock = vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({ wwwUrl: "https://zknotes.example" }),
            });
            vi.stubGlobal("fetch", fetchMock);
            const { refreshInstancePublicConfig, getInstancePublicConfig } = await loadPublicWww();

            await refreshInstancePublicConfig();
            await refreshInstancePublicConfig();

            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(fetchMock).toHaveBeenCalledWith(
                expect.stringMatching(/\/instance-config$/),
                expect.objectContaining({ signal: expect.any(AbortSignal) }),
            );
            expect(getInstancePublicConfig()?.wwwUrl).toBe("https://zknotes.example");
        });

        it("loadInstancePublicConfig still never throws", async () => {
            vi.stubGlobal(
                "fetch",
                vi
                    .fn()
                    .mockResolvedValue({ ok: false, status: 504, statusText: "Gateway Timeout" }),
            );
            const { loadInstancePublicConfig } = await loadPublicWww();
            expect(await loadInstancePublicConfig()).toEqual({});
        });
    });
});
