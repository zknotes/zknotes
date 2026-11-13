/**
 * The seal module's bootstrap, called from `(app)/+layout.svelte`. It only registers loaders, so
 * nothing of the OTS code, the worker calls or jsPDF loads until a file panel opens or the
 * background upgrade runs.
 */
import { filePanelExtensions } from "$lib/core/events/file-panel-extensions";

export function registerSealExtensions(): void {
    filePanelExtensions.registerSection("seal", () => import("./SealSection.svelte"));
    filePanelExtensions.registerContentGuard("seal", async (fileId) => {
        const { sealCountOfFile } = await import("./seal-service");
        const n = await sealCountOfFile(fileId);
        if (n === 0) return null;
        return n === 1
            ? "This file's current content is sealed. Replacing or permanently deleting it ends that seal: the proof is deleted with the content. Export the certificate first if you need it."
            : `This file's current content has ${n} seals. Replacing or permanently deleting it ends them: the proofs are deleted with the content. Export the certificates first if you need them.`;
    });
}

/** How often pending seals are checked while the app is open. */
const UPGRADE_INTERVAL_MS = 30 * 60 * 1000;
/** The first check waits a little, so it does not compete with the first sync after unlock. */
const FIRST_UPGRADE_DELAY_MS = 20 * 1000;

/**
 * Checks pending seals once soon after unlock, then every half hour, until the returned stop is
 * called (lock, logout). A failed round is simply retried next time.
 */
export function startSealUpgrader(): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const round = async () => {
        if (stopped) return;
        try {
            const { loadSeals, upgradePendingSeals } = await import("./seal-service");
            const { seals } = await loadSeals();
            const pending = seals.filter((s) => s.state === "pending");
            if (pending.length > 0 && !stopped) await upgradePendingSeals(pending);
        } catch {
            // offline, locked, or the server is away — next round
        }
        if (!stopped) timer = setTimeout(round, UPGRADE_INTERVAL_MS);
    };
    timer = setTimeout(round, FIRST_UPGRADE_DELAY_MS);
    return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
    };
}
