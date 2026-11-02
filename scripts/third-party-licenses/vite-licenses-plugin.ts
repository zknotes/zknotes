// Serves and emits /third-party-licenses.txt for the web build: in `vite dev` straight from the
// installed packages on request, in `vite build` as an asset of the client bundle, so adapter-static
// puts it in the web root and the tree hash covers it. Settings → About links to it.
import * as path from "node:path";
// @ts-expect-error
import type { Plugin } from "vite";
import {
    CLIENT_EXTRA,
    collectShippedPackages,
    renderNotices,
    ZKNOTES_INTRO,
    ZKNOTES_NOTES,
} from "./collect-licenses";

export const LICENSES_FILE = "third-party-licenses.txt";

export function thirdPartyLicensesPlugin(): Plugin {
    const repoRoot = path.resolve(__dirname, "../..");
    let text: string | null = null;
    const render = (): string => {
        if (text === null) {
            const notices = collectShippedPackages(
                [path.join(repoRoot, "client"), path.join(repoRoot, "shared")],
                { extra: CLIENT_EXTRA },
            );
            text = renderNotices(notices, { intro: ZKNOTES_INTRO, notes: ZKNOTES_NOTES });
        }
        return text;
    };
    let isClientBuild = false;

    return {
        name: "vite-third-party-licenses",
        configResolved(config: { build: { ssr?: boolean | string } }) {
            // SvelteKit runs Vite twice; the file belongs to the client (static) output only.
            isClientBuild = !config.build.ssr;
        },
        configureServer(server: {
            middlewares: {
                use: (
                    fn: (
                        req: { url?: string },
                        res: {
                            setHeader: (k: string, v: string) => void;
                            end: (s: string) => void;
                        },
                        next: () => void,
                    ) => void,
                ) => void;
            };
        }) {
            server.middlewares.use((req, res, next) => {
                if (req.url?.split("?")[0] !== `/${LICENSES_FILE}`) return next();
                res.setHeader("Content-Type", "text/plain; charset=utf-8");
                res.end(render());
            });
        },
        generateBundle() {
            if (!isClientBuild) return;
            this.emitFile({ type: "asset", fileName: LICENSES_FILE, source: render() });
        },
    };
}
