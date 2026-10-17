import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `persistent-storage` carries a module-level `attempted` guard, so every scenario needs a fresh
// module (vi.resetModules + a dynamic import). We stub the global `navigator`/`localStorage` because
// node has neither a Storage Manager nor localStorage (which `persisted.ts` uses).

function installLocalStorage() {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
    });
}

function stubNavigator(storage?: unknown) {
    vi.stubGlobal("navigator", storage === undefined ? {} : { storage });
}

async function freshModule() {
    vi.resetModules();
    return await import("./persistent-storage");
}

beforeEach(() => {
    installLocalStorage();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("requestPersistentStorage", () => {
    it("returns 'unsupported' when the Storage Manager is absent", async () => {
        stubNavigator(); // navigator.storage undefined
        const m = await freshModule();
        expect(await m.requestPersistentStorage()).toBe("unsupported");
        expect(m.loadPersistOutcome()).toBe("unsupported");
    });

    it("returns 'persisted' when persist() grants", async () => {
        stubNavigator({
            persist: vi.fn().mockResolvedValue(true),
            persisted: vi.fn().mockResolvedValue(false),
        });
        const m = await freshModule();
        expect(await m.requestPersistentStorage()).toBe("persisted");
        expect(m.loadPersistOutcome()).toBe("persisted");
    });

    it("returns 'persisted' without calling persist() when already persisted", async () => {
        const persist = vi.fn().mockResolvedValue(false);
        stubNavigator({ persist, persisted: vi.fn().mockResolvedValue(true) });
        const m = await freshModule();
        expect(await m.requestPersistentStorage()).toBe("persisted");
        expect(persist).not.toHaveBeenCalled();
    });

    it("returns 'denied' when persist() refuses", async () => {
        stubNavigator({
            persist: vi.fn().mockResolvedValue(false),
            persisted: vi.fn().mockResolvedValue(false),
        });
        const m = await freshModule();
        expect(await m.requestPersistentStorage()).toBe("denied");
        expect(m.loadPersistOutcome()).toBe("denied");
    });

    it("returns 'denied' when persist() throws", async () => {
        stubNavigator({
            persist: vi.fn().mockRejectedValue(new Error("blocked")),
            persisted: vi.fn().mockResolvedValue(false),
        });
        const m = await freshModule();
        expect(await m.requestPersistentStorage()).toBe("denied");
    });

    it("is idempotent — calls persist() at most once across invocations", async () => {
        const persist = vi.fn().mockResolvedValue(true);
        stubNavigator({ persist, persisted: vi.fn().mockResolvedValue(false) });
        const m = await freshModule();
        await m.requestPersistentStorage();
        await m.requestPersistentStorage();
        expect(persist).toHaveBeenCalledTimes(1);
    });
});
