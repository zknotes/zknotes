// Writes the third-party notice file for the given workspaces to stdout — the API image builds its
// own this way (the web build gets it from the Vite plugin). Usage:
//   bun scripts/third-party-licenses/cli.ts server > third-party-licenses.txt
import * as path from "node:path";
import {
    CLIENT_EXTRA,
    collectShippedPackages,
    renderNotices,
    ZKNOTES_INTRO,
    ZKNOTES_NOTES,
} from "./collect-licenses";

const root = path.resolve(import.meta.dir, "../..");
const workspaces = process.argv.slice(2);
if (workspaces.length === 0) {
    console.error("usage: bun scripts/third-party-licenses/cli.ts <workspace dir>...");
    process.exit(2);
}
const notices = collectShippedPackages(
    workspaces.map((w) => path.resolve(root, w)),
    { extra: CLIENT_EXTRA },
);
process.stdout.write(renderNotices(notices, { intro: ZKNOTES_INTRO, notes: ZKNOTES_NOTES }));
