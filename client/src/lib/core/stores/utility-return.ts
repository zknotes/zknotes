/**
 * Pure path classification and the stack logic behind "close the utility view".
 * The $state store lives in utility-return.svelte.ts — no Svelte dependency here (unit tests).
 */

export const UTILITY_ROOTS = ["starred", "recent", "trash", "files", "settings", "help"] as const;

export type UtilityRoot = (typeof UTILITY_ROOTS)[number];

export type PathClass =
    | { kind: "home" }
    | { kind: "note"; id: string }
    | { kind: "utility"; root: UtilityRoot }
    | { kind: "other" };

/** Normalise a pathname: no trailing slash (except the root `/`). */
export function normalizePath(pathname: string): string {
    if (!pathname || pathname === "/") return "/";
    const noQuery = pathname.split("?")[0] ?? pathname;
    const trimmed = noQuery.replace(/\/+$/, "");
    return trimmed === "" ? "/" : trimmed;
}

export function classifyPath(pathname: string): PathClass {
    const path = normalizePath(pathname);
    if (path === "/") return { kind: "home" };

    const noteMatch = /^\/note\/([^/]+)$/.exec(path);
    if (noteMatch?.[1]) return { kind: "note", id: noteMatch[1] };

    for (const root of UTILITY_ROOTS) {
        if (path === `/${root}` || path.startsWith(`/${root}/`)) {
            return { kind: "utility", root };
        }
    }
    return { kind: "other" };
}

export function isUtilityPath(pathname: string): boolean {
    return classifyPath(pathname).kind === "utility";
}

/**
 * Updates the return stack on an SPA navigation (not on a close-driven one).
 */
export function applyNavigation(
    stack: readonly string[],
    from: string | null,
    to: string,
): string[] {
    const toPath = normalizePath(to);
    const toClass = classifyPath(toPath);

    if (toClass.kind === "home") return ["/"];
    if (toClass.kind === "note") return [toPath];

    if (toClass.kind === "utility") {
        if (from == null) {
            // A cold enter (a deep link / a refresh) — an empty stack → the cold fallback on close
            return [...stack];
        }
        const fromPath = normalizePath(from);
        const fromClass = classifyPath(fromPath);

        if (fromClass.kind === "home" || fromClass.kind === "note") {
            return [fromPath];
        }
        if (fromClass.kind === "utility") {
            if (fromClass.root === toClass.root) {
                // A tab/topic inside the same root — the stack is untouched
                return [...stack];
            }
            // Cross-root: push the path we are leaving
            return [...stack, fromPath];
        }
        return [...stack];
    }

    // other (login, share, …) — reset
    return [];
}

/** Pulls the note id out of a `/note/:id` path, otherwise null. */
export function noteIdFromPath(path: string): string | null {
    const c = classifyPath(path);
    return c.kind === "note" ? c.id : null;
}

export type NoteLiveCheck = (id: string) => boolean;

/**
 * If the target is a note that is no longer alive, return the cold fallback; otherwise the target.
 */
export function resolveValidPath(
    target: string,
    opts: {
        isLiveNote: NoteLiveCheck;
        coldFallback: () => string;
    },
): string {
    const path = normalizePath(target);
    const id = noteIdFromPath(path);
    if (id != null && !opts.isLiveNote(id)) {
        return normalizePath(opts.coldFallback());
    }
    return path;
}

/**
 * The pop plus the stack preparation after a close (before the navigation).
 * Returns the target path; `nextStack` is the stack after the pop (and after a base reseed if one is
 * needed).
 */
export function popCloseTarget(
    stack: readonly string[],
    opts: {
        isLiveNote: NoteLiveCheck;
        coldFallback: () => string;
    },
): { target: string; nextStack: string[] } {
    const copy = [...stack];
    const raw = copy.length > 0 ? (copy.pop() as string) : opts.coldFallback();
    const target = resolveValidPath(raw, opts);
    const targetClass = classifyPath(target);

    // After a close on a base surface, stack = [base]; on an intermediate utility the rest remains
    if (targetClass.kind === "home" || targetClass.kind === "note") {
        return { target, nextStack: [target] };
    }
    return { target, nextStack: copy };
}
