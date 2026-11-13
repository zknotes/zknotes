/**
 * Extension points of the file detail panel, so a feature module can add to it without
 * `modules/files` importing that module (the golden rule: no module → module imports).
 *
 * A module registers at bootstrap (from `(app)/+layout.svelte`), the same way `fileBridge` is
 * filled. Registrations hold loaders, not components: the feature's code stays out of the main
 * bundle until the panel actually opens.
 *
 *  - a section: a component rendered inside the panel for the open file;
 *  - a content guard: asked before the file's current bytes are replaced or permanently deleted.
 *    It returns a warning to show the user first, or null when nothing would be lost.
 */
import type { Component } from "svelte";

/** What a section is told about the open file. */
export type FilePanelFile = {
    readonly id: string;
    readonly title: string;
    readonly updatedAt: number;
};

export type FilePanelSectionLoader = () => Promise<{
    default: Component<{ file: FilePanelFile }>;
}>;

export type FileContentGuard = (fileId: string) => Promise<string | null>;

const sections = new Map<string, FilePanelSectionLoader>();
const guards = new Map<string, FileContentGuard>();

export const filePanelExtensions = {
    /** Registering the same key again replaces the earlier loader (an HMR reload, a re-bootstrap). */
    registerSection(key: string, loader: FilePanelSectionLoader): void {
        sections.set(key, loader);
    },

    registerContentGuard(key: string, guard: FileContentGuard): void {
        guards.set(key, guard);
    },

    sections(): Array<{ key: string; load: FilePanelSectionLoader }> {
        return [...sections].map(([key, load]) => ({ key, load }));
    },

    /**
     * The warnings to show before the file's content is replaced or deleted for good. A guard that
     * fails is skipped: it must never block the user's own action.
     */
    async contentWarnings(fileId: string): Promise<string[]> {
        const out: string[] = [];
        for (const guard of guards.values()) {
            try {
                const w = await guard(fileId);
                if (w) out.push(w);
            } catch {
                // see above
            }
        }
        return out;
    },
};
