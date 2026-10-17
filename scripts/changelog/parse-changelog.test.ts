import { describe, expect, it } from "vitest";
import { parseChangelog } from "./parse-changelog";

describe("parseChangelog", () => {
    it("parses Unreleased heading", () => {
        const md = `
## [Unreleased]
### Added
- Something new
        `;
        const res = parseChangelog(md);
        expect(res.warnings).toHaveLength(0);
        expect(res.entries).toHaveLength(1);
        expect(res.entries[0]?.version).toBe("Unreleased");
        expect(res.entries[0]?.date).toBeNull();
        expect(res.entries[0]?.sections[0]?.category).toBe("Added");
        expect(res.entries[0]?.sections[0]?.items).toEqual(["Something new"]);
    });

    it("parses multiple versions and delimiters", () => {
        const md = `
## [0.2.0] - 2026-07-10
### Changed
- Changed this

## [0.1.0] — 2026-07-09
### Fixed
- Fixed that
        `;
        const res = parseChangelog(md);
        expect(res.warnings).toHaveLength(0);
        expect(res.entries).toHaveLength(2);
        expect(res.entries[0]?.version).toBe("0.2.0");
        expect(res.entries[0]?.date).toBe("2026-07-10");
        expect(res.entries[1]?.version).toBe("0.1.0");
        expect(res.entries[1]?.date).toBe("2026-07-09");
    });

    it("warns on unknown category", () => {
        const md = `
## [0.1.0] - 2026-07-09
### Addded
- Typo category
        `;
        const res = parseChangelog(md);
        expect(res.warnings).toHaveLength(1);
        expect(res.warnings[0]).toContain("Unknown category");
    });

    it("warns on malformed heading", () => {
        const md = `
## 0.1.0 - 2026-07-09
### Added
- Item
        `;
        const res = parseChangelog(md);
        expect(res.warnings).toHaveLength(2);
        expect(res.warnings[0]).toContain("Malformed version heading");
    });
});
