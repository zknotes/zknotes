export interface ChangelogEntry {
    version: string; // "0.1.0" or "Unreleased"
    date: string | null; // ISO date or null for Unreleased
    sections: { category: string; items: string[] }[];
}

export interface ParseResult {
    entries: ChangelogEntry[];
    warnings: string[];
}

const VALID_CATEGORIES = new Set([
    "Added",
    "Changed",
    "Fixed",
    "Security",
    "Deprecated",
    "Removed",
]);

export function parseChangelog(markdown: string): ParseResult {
    const lines = markdown.split("\n");
    const result: ParseResult = { entries: [], warnings: [] };
    let currentEntry: ChangelogEntry | null = null;
    let currentCategory: string | null = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]?.trim();
        if (line === undefined || !line) continue;

        if (line.startsWith("## ")) {
            const heading = line.substring(3).trim();
            // e.g. [Unreleased] or [0.1.0] - 2026-07-09 or [0.1.0] — 2026-07-09
            const match = heading.match(/^\[([^\]]+)\](?:\s*[-—]\s*(\d{4}-\d{2}-\d{2}))?/);
            if (match) {
                const version = match[1] as string;
                const date = match[2] || null;
                currentEntry = { version, date, sections: [] };
                result.entries.push(currentEntry);
                currentCategory = null;
            } else {
                result.warnings.push(`Line ${i + 1}: Malformed version heading: ${line}`);
            }
        } else if (line.startsWith("### ")) {
            if (!currentEntry) {
                result.warnings.push(
                    `Line ${i + 1}: Category found before version heading: ${line}`,
                );
                continue;
            }
            const category = line.substring(4).trim();
            if (!VALID_CATEGORIES.has(category)) {
                result.warnings.push(`Line ${i + 1}: Unknown category: ${category}`);
            }
            currentCategory = category;
            const existingSection = currentEntry.sections.find((s) => s.category === category);
            if (!existingSection) {
                currentEntry.sections.push({ category, items: [] });
            }
        } else if (line.startsWith("- ") || line.startsWith("* ")) {
            if (!currentEntry) {
                continue; // Ignoring list items before first version (could be general text)
            }
            if (!currentCategory) {
                result.warnings.push(`Line ${i + 1}: Item found without category: ${line}`);
                continue;
            }
            const itemText = line.substring(2).trim();
            const section = currentEntry.sections.find((s) => s.category === currentCategory);
            if (section) {
                section.items.push(itemText);
            }
        } else if (line.startsWith("#")) {
            // other headers (e.g., # Changelog) are ignored
        } else {
            // multi-line item or general text
            if (currentEntry && currentCategory) {
                const section = currentEntry.sections.find((s) => s.category === currentCategory);
                if (section && section.items.length > 0) {
                    section.items[section.items.length - 1] += ` ${line}`;
                }
            }
        }
    }
    return result;
}
