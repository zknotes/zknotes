import * as fs from "node:fs";
import * as path from "node:path";
// @ts-expect-error
import type { Plugin } from "vite";
import { parseChangelog } from "./parse-changelog";

export function changelogPlugin(options?: { limit?: number }): Plugin {
    const virtualModuleId = "virtual:changelog";
    const resolvedVirtualModuleId = `\0${virtualModuleId}`;
    const limit = options?.limit;

    return {
        name: "vite-changelog-plugin",
        resolveId(id: string) {
            if (id === virtualModuleId) {
                return resolvedVirtualModuleId;
            }
        },
        load(id: string) {
            if (id === resolvedVirtualModuleId) {
                // Let's make it robust by resolving relative to this file's directory:
                const robustChangelogPath = path.resolve(__dirname, "../../CHANGELOG.md");

                this.addWatchFile(robustChangelogPath);

                let markdown = "";
                try {
                    markdown = fs.readFileSync(robustChangelogPath, "utf-8");
                } catch (_e) {
                    this.warn(`[Changelog] Could not read CHANGELOG.md at ${robustChangelogPath}`);
                    return `export default [];`;
                }

                const result = parseChangelog(markdown);

                if (result.warnings.length > 0) {
                    for (const w of result.warnings) {
                        this.warn(`[Changelog] ${w}`);
                    }
                }

                let entries = result.entries.filter((e) => e.version !== "Unreleased");
                if (limit !== undefined) {
                    entries = entries.slice(0, limit);
                }

                return `export default ${JSON.stringify(entries)};`;
            }
        },
    };
}
