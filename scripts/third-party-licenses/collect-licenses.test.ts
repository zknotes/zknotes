import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectShippedPackages, renderNotices } from "./collect-licenses";

/**
 * The notice collector over a fixture tree that has the shapes a Bun install produces: a hoisted
 * dependency, a dependency nested under its dependent, a workspace reached through a symlink, and
 * a package installed twice at two versions.
 */

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function pkg(dir: string, manifest: Record<string, unknown>, license?: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    if (license !== undefined) writeFileSync(join(dir, "LICENSE"), license);
}

function fixture(): { app: string; lib: string } {
    const root = mkdtempSync(join(tmpdir(), "zknotes-licenses-"));
    dirs.push(root);
    const app = join(root, "app");
    const lib = join(root, "lib");
    pkg(app, {
        name: "@zknotes/app",
        private: true,
        dependencies: { a: "^1.0.0", "@zknotes/lib": "workspace:*" },
        devDependencies: { tool: "1.0.0", ships: "1.0.0" },
    });
    pkg(lib, { name: "@zknotes/lib", private: true, dependencies: { d: "1.0.0", a: "2.0.0" } });
    // hoisted a@1 with a nested c (its own dependency, a different version than the root would see)
    pkg(
        join(app, "node_modules/a"),
        {
            name: "a",
            version: "1.0.0",
            license: "MIT",
            dependencies: { c: "1.0.0" },
            homepage: "https://a.example",
        },
        "MIT License text of a",
    );
    pkg(join(app, "node_modules/a/node_modules/c"), {
        name: "c",
        version: "1.0.0",
        license: { type: "ISC" },
        author: { name: "C Author", email: "c@example.com" },
    });
    pkg(join(app, "node_modules/tool"), { name: "tool", version: "1.0.0", license: "MIT" }, "x");
    pkg(
        join(app, "node_modules/ships"),
        { name: "ships", version: "1.0.0", license: "MIT" },
        "ships text",
    );
    // the workspace, as Bun links it, and its dependencies next to it
    mkdirSync(join(app, "node_modules/@zknotes"), { recursive: true });
    symlinkSync(lib, join(app, "node_modules/@zknotes/lib"), "dir");
    pkg(
        join(lib, "node_modules/d"),
        { name: "d", version: "1.0.0", license: "Apache-2.0" },
        "Apache text",
    );
    pkg(join(lib, "node_modules/a"), { name: "a", version: "2.0.0", license: "MIT" }, "MIT a2");
    return { app, lib };
}

describe("collectShippedPackages", () => {
    it("walks the production closure through nesting and workspaces, and lists no workspace", () => {
        const { app } = fixture();
        const notices = collectShippedPackages([app]);
        expect(notices.map((n) => `${n.name}@${n.version}`)).toEqual([
            "a@1.0.0",
            "a@2.0.0",
            "c@1.0.0",
            "d@1.0.0",
        ]);
        const c = notices.find((n) => n.name === "c")!;
        expect(c.license).toBe("ISC");
        expect(c.author).toBe("C Author <c@example.com>");
        expect(c.licenseText).toBeNull();
        expect(notices.find((n) => n.name === "a")!.url).toBe("https://a.example");
    });

    it("`extra` adds a development dependency whose output ships, but not the rest", () => {
        const { app } = fixture();
        const names = collectShippedPackages([app], { extra: { app: ["ships"] } }).map(
            (n) => n.name,
        );
        expect(names).toContain("ships");
        expect(names).not.toContain("tool");
    });

    it("is deterministic and the rendering carries each license text", () => {
        const { app } = fixture();
        const one = renderNotices(collectShippedPackages([app]), { intro: "Intro" });
        const two = renderNotices(collectShippedPackages([app]), { intro: "Intro" });
        expect(one).toBe(two);
        expect(one).toContain("4 packages.");
        expect(one).toContain("MIT License text of a");
        expect(one).toContain("Apache text");
        expect(one).toContain("c 1.0.0\nLicense: ISC");
        expect(one).toContain("ships no license file");
    });

    it("renders a note for a package the manifest cannot describe", () => {
        const { app } = fixture();
        const text = renderNotices(collectShippedPackages([app]), {
            intro: "Intro",
            notes: { d: "fonts under OFL" },
        });
        expect(text).toContain("Note: fonts under OFL");
    });
});
