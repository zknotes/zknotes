import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `sw-update` carries a module-level `initialized` guard, so every scenario needs a fresh module
// (vi.resetModules + a dynamic import). Node has neither navigator.serviceWorker nor window.location,
// so we stub both. A reload may come ONLY from the user's "Reload" in the toast — never from the
// first claim action on an uncontrolled page.

type ToastArg = { message: string; action: { onClick: () => void } };
const toastAdd = vi.fn((_opts: ToastArg) => "toast-1");
vi.mock("$lib/core/stores/toast.svelte", () => ({
    globalToasts: {
        add: (opts: ToastArg) => toastAdd(opts),
    },
}));

type Listener = (ev?: unknown) => void;

interface FakeWorker {
    state: string;
    postMessage: ReturnType<typeof vi.fn>;
    addEventListener: (type: string, fn: Listener) => void;
    emit: (type: string) => void;
}

function makeWorker(state = "installed"): FakeWorker {
    const listeners = new Map<string, Listener[]>();
    return {
        state,
        postMessage: vi.fn(),
        addEventListener(type, fn) {
            listeners.set(type, [...(listeners.get(type) ?? []), fn]);
        },
        emit(type) {
            for (const fn of listeners.get(type) ?? []) fn();
        },
    };
}

function installEnv(opts: {
    controller: unknown;
    waiting?: FakeWorker | null;
    installing?: FakeWorker | null;
}) {
    const swListeners = new Map<string, Listener[]>();
    const registration = {
        waiting: opts.waiting ?? null,
        installing: opts.installing ?? null,
        addEventListener: (type: string, fn: Listener) => {
            swListeners.set(`reg:${type}`, [...(swListeners.get(`reg:${type}`) ?? []), fn]);
        },
    };
    const serviceWorker = {
        controller: opts.controller,
        register: vi.fn().mockResolvedValue(registration),
        addEventListener: (type: string, fn: Listener) => {
            swListeners.set(type, [...(swListeners.get(type) ?? []), fn]);
        },
    };
    const reload = vi.fn();
    vi.stubGlobal("navigator", { serviceWorker });
    vi.stubGlobal("window", { location: { reload } });

    return {
        reload,
        emitControllerChange() {
            for (const fn of swListeners.get("controllerchange") ?? []) fn();
        },
    };
}

async function freshModule() {
    vi.resetModules();
    return await import("./sw-update");
}

beforeEach(() => {
    // initServiceWorkerUpdate is PROD-only; without this every test would be a no-op.
    vi.stubEnv("PROD", true);
    toastAdd.mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe("initServiceWorkerUpdate", () => {
    it("does not reload when the page had no controller (first install claim)", async () => {
        const env = installEnv({ controller: null });
        const m = await freshModule();
        m.initServiceWorkerUpdate();
        await vi.waitFor(() => expect(navigator.serviceWorker.register).toHaveBeenCalled());

        env.emitControllerChange();

        expect(env.reload).not.toHaveBeenCalled();
    });

    it("reloads once when a controlled page gets a new controller (user hit Reload)", async () => {
        const env = installEnv({ controller: {} });
        const m = await freshModule();
        m.initServiceWorkerUpdate();
        await vi.waitFor(() => expect(navigator.serviceWorker.register).toHaveBeenCalled());

        env.emitControllerChange();
        env.emitControllerChange();

        expect(env.reload).toHaveBeenCalledTimes(1);
    });

    it("shows the update toast for a waiting worker on a controlled page", async () => {
        const waiting = makeWorker("installed");
        installEnv({ controller: {}, waiting });
        const m = await freshModule();
        m.initServiceWorkerUpdate();

        await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledTimes(1));
        const arg = toastAdd.mock.calls[0]?.[0];
        expect(arg?.message).toContain("new version");
        if (!arg) throw new Error("toast not recorded");

        arg.action.onClick();
        expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    });

    it("is a no-op without service worker support", async () => {
        vi.stubGlobal("navigator", {});
        vi.stubGlobal("window", { location: { reload: vi.fn() } });
        const m = await freshModule();
        expect(() => m.initServiceWorkerUpdate()).not.toThrow();
        expect(toastAdd).not.toHaveBeenCalled();
    });
});
