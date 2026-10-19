// A thin reactive state for pinned items (selective sync).
// ONLY the list of pinned root ids + the localStorage persistence + the is/pin/unpin mutations live
// here. Every file-orchestration effect (chunk sync, evict, emit presence) has been moved out into
// modules/files/pin-orchestrator.ts, so core/* can import the state without breaking the core →
// modules rule.
//
// The methods are decorated (wrapped) when the orchestrator loads (through register-bridge) — which
// gives a pin/unpin from core/ui/FolderItem and one from a module identical side effects.

import { loadPersisted, savePersisted, STORAGE_KEYS } from "$lib/core/utils/persisted";

const PIN_STORE_KEY = STORAGE_KEYS.pinnedItems;

class PinManager {
    // The reactive in-memory state
    roots = $state<string[]>([]);

    constructor() {
        // JSON string[]; a corrupt value or a blocked storage reads as "nothing pinned".
        const stored = loadPersisted<unknown>(PIN_STORE_KEY, []);
        this.roots = Array.isArray(stored) ? stored.filter((v) => typeof v === "string") : [];
    }

    private save() {
        savePersisted(PIN_STORE_KEY, this.roots);
    }

    isPinned(id: string): boolean {
        return this.roots.includes(id);
    }

    pinItem(id: string): void {
        if (!this.roots.includes(id)) {
            this.roots.push(id);
            this.save();
            // The side effects (syncPinnedChunks + emitFilesChanged) are injected by a wrapper from
            // pin-orchestrator after the bootstrap.
        }
    }

    unpinItem(id: string): void {
        const idx = this.roots.indexOf(id);
        if (idx !== -1) {
            this.roots.splice(idx, 1);
            this.save();
            // The side-effects (emit + free tree) are injected by a wrapper from the orchestrator.
        }
    }
}

export const pinManager = new PinManager();

export function getPinnedRoots(): string[] {
    return pinManager.roots;
}
