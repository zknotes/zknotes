/**
 * An in-memory LIFO return stack for the full-page utility views (Starred, Settings, …).
 * The X and the sidebar toggle call close() → a goto with replaceState: true.
 *
 * `stack` is $state (tooltip/UI), but onNavigate is called from the layout's $effect — reading and
 * writing the stack has to go through untrack, or else effect_update_depth_exceeded.
 */
import { untrack } from "svelte";
import { recentNotesStore } from "./recent-notes.svelte";
import {
    applyNavigation,
    classifyPath,
    isUtilityPath,
    type NoteLiveCheck,
    normalizePath,
    popCloseTarget,
} from "./utility-return";

export type UtilityNavigateFn = (
    path: string,
    opts?: { replaceState?: boolean },
) => void | Promise<void>;

class UtilityReturnStore {
    /** A LIFO of paths; the bottom is the base (note/home), the top is the next close target. */
    stack = $state<string[]>([]);

    /** The last path we tracked — the `from` for the next navigation. */
    #lastPath: string | null = null;

    /** A close navigation must not re-push the stack. */
    #skipNextTrack = false;

    #navigate: UtilityNavigateFn | null = null;
    #isLiveNote: NoteLiveCheck = () => true;

    setNavigate(fn: UtilityNavigateFn) {
        this.#navigate = fn;
    }

    setNoteLiveCheck(fn: NoteLiveCheck) {
        this.#isLiveNote = fn;
    }

    clear() {
        untrack(() => {
            this.stack = [];
        });
        this.#lastPath = null;
        this.#skipNextTrack = false;
    }

    /**
     * Call it from the layout on every change to `page.url.pathname` within (app).
     * It must not subscribe the calling $effect to `stack`.
     */
    onNavigate(pathname: string) {
        const to = normalizePath(pathname);

        if (this.#skipNextTrack) {
            this.#skipNextTrack = false;
            this.#lastPath = to;
            // The stack was already set in close(); on a base surface, make sure it is consistent
            const kind = classifyPath(to).kind;
            if (kind === "home" || kind === "note") {
                untrack(() => {
                    this.stack = [to];
                });
            }
            return;
        }

        const from = this.#lastPath;
        const current = untrack(() => this.stack);
        const next = applyNavigation(current, from, to);
        untrack(() => {
            this.stack = next;
        });
        this.#lastPath = to;
    }

    coldFallbackPath(): string {
        const id = untrack(() => recentNotesStore.ids[0]);
        if (id && this.#isLiveNote(id)) return `/note/${id}`;
        return "/";
    }

    /** The target an X would open (without mutating anything) — for the title/tooltip. */
    peekCloseTarget(): string {
        const top = this.stack[this.stack.length - 1];
        if (top) {
            const id = top.startsWith("/note/") ? top.slice("/note/".length) : null;
            if (id && !this.#isLiveNote(id)) return this.coldFallbackPath();
            return normalizePath(top);
        }
        return this.coldFallbackPath();
    }

    close() {
        const current = untrack(() => this.stack);
        const { target, nextStack } = popCloseTarget(current, {
            isLiveNote: this.#isLiveNote,
            coldFallback: () => this.coldFallbackPath(),
        });
        untrack(() => {
            this.stack = nextStack;
        });
        this.#skipNextTrack = true;

        const nav = this.#navigate;
        if (!nav) {
            console.warn("utilityReturnStore.close: navigate not set");
            this.#skipNextTrack = false;
            return;
        }
        void nav(target, { replaceState: true });
    }
}

export const utilityReturnStore = new UtilityReturnStore();
