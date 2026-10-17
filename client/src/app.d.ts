// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
    namespace App {
        // interface Error {}
        // interface Locals {}
        // interface PageData {}
        interface PageState {
            /**
             * The link text a note link was followed from — a title suggestion for creating a
             * missing note. Kept in history state, never in the URL.
             */
            linkTitle?: string;
        }
        // interface Platform {}
    }

    const __APP_VERSION__: string;
    const __BUILD_DATE__: string;
    const __COMMIT_HASH__: string;
}

declare module "virtual:changelog" {
    export interface ChangelogEntry {
        version: string;
        date: string | null;
        sections: { category: string; items: string[] }[];
    }
    const entries: ChangelogEntry[];
    export default entries;
}

export {};
