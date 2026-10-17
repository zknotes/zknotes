/**
 * Form UX gate — every bare <input>/<select>/<textarea> has to carry the canonical class.
 *
 * It is not a parallel of check-button-ux.sh (the absence of a tag, a single-line grep). Here we look
 * for the *presence* of an exact class token on a tag that is routinely broken across 5+ lines and
 * carries an `onkeydown={(e) => …}` inside it — a naive `<input[^>]*>` stops at the arrow and falsely
 * reports a control that does have the class.
 *
 * The scanner walks forward from `<input` / `<select` / `<textarea`, tracking quotes and `{}` depth,
 * and closes the tag on a `>` only when the depth is 0 and we are not inside a string.
 *
 * Every bare <input>/<select>/<textarea> has to carry the canonical class (.input / .checkbox /
 * .radio).
 */

import { Glob } from "bun";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** The source components (the class goes through cn()) + the chromeless chrome. */
const ALLOW_FILES = new Set([
    "client/src/lib/core/ui/Input.svelte",
    "client/src/lib/core/ui/Checkbox.svelte",
    "client/src/lib/core/ui/ToolbarSearch.svelte",
    "client/src/lib/modules/editor/EditorHeader.svelte",
    "client/src/lib/modules/editor/InsertMarkdownModal.svelte",
    "client/src/lib/modules/editor/popovers/LinkPopover.svelte",
    "client/src/lib/modules/files/NotePickerModal.svelte",
    "client/src/routes/(app)/files/+page.svelte",
]);

const ALLOW_PREFIXES = ["client/src/lib/core/ui/dev/", "client/src/lib/modules/files/dev/"];

const TYPE_EXEMPT = new Set(["file", "hidden", "color"]);

type Hit = {
    file: string;
    line: number;
    tag: string;
    reason: string;
};

function isAllowlisted(rel: string): boolean {
    if (ALLOW_FILES.has(rel)) return true;
    return ALLOW_PREFIXES.some((p) => rel.startsWith(p));
}

function lineAt(src: string, index: number): number {
    let line = 1;
    for (let i = 0; i < index; i++) {
        if (src.charCodeAt(i) === 10) line++;
    }
    return line;
}

/** The end of an opening tag: a `>` only outside quotes and at brace depth 0. */
function findTagEnd(src: string, start: number): number {
    let quote: '"' | "'" | "`" | null = null;
    let brace = 0;
    for (let i = start; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            if (c === "\\" && quote !== "`") {
                i++;
                continue;
            }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'" || c === "`") {
            quote = c;
            continue;
        }
        if (c === "{") {
            brace++;
            continue;
        }
        if (c === "}") {
            if (brace > 0) brace--;
            continue;
        }
        if (c === ">" && brace === 0) return i;
    }
    return -1;
}

function skipUntil(src: string, from: number, closer: string): number {
    const at = src.indexOf(closer, from);
    return at === -1 ? src.length : at + closer.length;
}

function isTagNameEnd(src: string, i: number): boolean {
    if (i >= src.length) return true;
    const c = src[i];
    return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "/" || c === ">";
}

type TagKind = "input" | "select" | "textarea";

function nextControl(src: string, from: number): { kind: TagKind; start: number } | null {
    let i = from;
    while (i < src.length) {
        if (src.startsWith("<!--", i)) {
            i = skipUntil(src, i + 4, "-->");
            continue;
        }
        if (src.startsWith("<script", i) && isTagNameEnd(src, i + 7)) {
            const openEnd = src.indexOf(">", i + 7);
            i = openEnd === -1 ? src.length : skipUntil(src, openEnd + 1, "</script>");
            continue;
        }
        if (src.startsWith("<style", i) && isTagNameEnd(src, i + 6)) {
            const openEnd = src.indexOf(">", i + 6);
            i = openEnd === -1 ? src.length : skipUntil(src, openEnd + 1, "</style>");
            continue;
        }
        if (src.startsWith("<input", i) && isTagNameEnd(src, i + 6)) {
            return { kind: "input", start: i };
        }
        if (src.startsWith("<select", i) && isTagNameEnd(src, i + 7)) {
            return { kind: "select", start: i };
        }
        if (src.startsWith("<textarea", i) && isTagNameEnd(src, i + 9)) {
            return { kind: "textarea", start: i };
        }
        i++;
    }
    return null;
}

function classAttrValue(tag: string): string {
    const m = /\bclass\s*=\s*/.exec(tag);
    if (!m || m.index === undefined) return "";
    const i = m.index + m[0].length;
    const q = tag[i];
    if (q === '"' || q === "'" || q === "`") {
        const end = tag.indexOf(q, i + 1);
        return end === -1 ? tag.slice(i + 1) : tag.slice(i + 1, end);
    }
    if (q === "{") {
        let depth = 1;
        for (let j = i + 1; j < tag.length; j++) {
            const c = tag[j];
            if (c === "{") depth++;
            else if (c === "}") {
                depth--;
                if (depth === 0) return tag.slice(i + 1, j);
            }
        }
        return tag.slice(i + 1);
    }
    return "";
}

/**
 * An exact class token, not a prefix. `\binput\b` would let `input-sm` through, because `-` is a
 * non-word character. The token has to be bounded by a space, a quote, a bracket or the string's
 * edge.
 */
function hasClassToken(classSrc: string, token: string): boolean {
    const re = new RegExp(`(?:^|[\\s"'{\`(,])${token}(?:$|[\\s"'}\`)\\],])`);
    return re.test(classSrc);
}

function attrValue(tag: string, name: string): string | null {
    const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{([^}]*)\\}|([^\\s>]+))`);
    const m = re.exec(tag);
    if (!m) return null;
    const raw = m[1] ?? m[2] ?? m[3] ?? m[4] ?? "";
    return raw.replace(/^["']|["']$/g, "");
}

function isHoneypot(tag: string, classSrc: string): boolean {
    if (!hasClassToken(classSrc, "hidden")) return false;
    return /aria-hidden\s*=\s*(?:"true"|'true'|\{true\})/.test(tag);
}

function requiredToken(kind: TagKind, type: string | null): "input" | "checkbox" | "radio" {
    if (kind === "input" && type === "checkbox") return "checkbox";
    if (kind === "input" && type === "radio") return "radio";
    return "input";
}

function firstLine(tag: string): string {
    const line = tag.split("\n")[0] ?? tag;
    return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function scanFile(rel: string, src: string): Hit[] {
    if (isAllowlisted(rel)) return [];
    const hits: Hit[] = [];
    let from = 0;
    while (from < src.length) {
        const found = nextControl(src, from);
        if (!found) break;
        const end = findTagEnd(src, found.start + 1);
        if (end === -1) {
            hits.push({
                file: rel,
                line: lineAt(src, found.start),
                tag: src.slice(found.start, found.start + 40),
                reason: "unclosed tag (parser)",
            });
            break;
        }
        const tag = src.slice(found.start, end + 1);
        from = end + 1;

        const typeRaw = attrValue(tag, "type");
        const type = typeRaw?.trim().toLowerCase() ?? null;
        if (type && TYPE_EXEMPT.has(type)) continue;

        const classSrc = classAttrValue(tag);
        if (isHoneypot(tag, classSrc)) continue;

        const token = requiredToken(found.kind, type);
        if (hasClassToken(classSrc, token)) continue;

        hits.push({
            file: rel,
            line: lineAt(src, found.start),
            tag: firstLine(tag),
            reason: `missing class token "${token}"`,
        });
    }
    return hits;
}

const glob = new Glob("client/src/**/*.svelte");
const hits: Hit[] = [];

for await (const rel of glob.scan({ cwd: ROOT, onlyFiles: true })) {
    const src = await Bun.file(join(ROOT, rel)).text();
    hits.push(...scanFile(rel.replaceAll("\\", "/"), src));
}

hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

console.log("▶ Form UX — a bare <input>/<select>/<textarea> has to carry the canonical class");

if (hits.length === 0) {
    console.log("✓ Form UX gate — OK");
    process.exit(0);
}

for (const h of hits) {
    console.log(`  ✗ ${h.file}:${h.line} ${h.reason}`);
    console.log(`      ${h.tag}`);
}
console.log(`✗ Form UX gate — ${hits.length} problem(a)`);
process.exit(1);
