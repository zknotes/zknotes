/**
 * A prefix on the document title in Vite's dev mode, so local browser tabs look different from
 * production ones.
 *
 * `import.meta.env.DEV` is a compile-time constant — in a production build the prefix disappears
 * (tree-shaking / dead-code elimination).
 */
export const PAGE_TITLE_PREFIX = import.meta.env.DEV ? "LOCAL-" : "";

export function pageTitle(title: string): string {
    return `${PAGE_TITLE_PREFIX}${title}`;
}
