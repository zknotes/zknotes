/**
 * Shared lifecycle state for the search index — the SearchBar can show "Building index…" while the
 * layout's onMount initialiser is at work.
 */

type Phase = "idle" | "building" | "ready";

function createSearchIndexStore() {
    let phase = $state<Phase>("idle");
    let built = $state(0);
    let total = $state(0);

    return {
        get phase() {
            return phase;
        },
        get built() {
            return built;
        },
        get total() {
            return total;
        },
        get isReady() {
            return phase === "ready";
        },
        get isBuilding() {
            return phase === "building";
        },
        startBuilding() {
            phase = "building";
            built = 0;
            total = 0;
        },
        setProgress(b: number, t: number) {
            built = b;
            total = t;
        },
        markReady() {
            phase = "ready";
        },
        reset() {
            phase = "idle";
            built = 0;
            total = 0;
        },
    };
}

export const searchIndexStore = createSearchIndexStore();
