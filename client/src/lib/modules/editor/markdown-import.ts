/**
 * Markdown → HTML for the Insert Markdown modal.
 *
 * - A scoped `Marked` instance (it does not mutate the global `marked` singleton).
 * - Math: `$$…$$` display, `$…$` inline (no whitespace in the inline content; bare numbers such as
 *   `$5$` are not math).
 * - The output goes through `sanitizeHtml` (DOMPurify) before it is inserted into TipTap.
 */
import { Marked, type TokenizerAndRendererExtension } from "marked";
import { escapeHtml, sanitizeHtml } from "$lib/core/utils/dompurify";

/** Inline math: it must not be a bare number or a currency (`$5$`, `$10.99$`). */
function isCurrencyLikeLatex(text: string): boolean {
    return /^\d+([.,]\d+)*$/.test(text.trim());
}

const mathExtension: TokenizerAndRendererExtension = {
    name: "math",
    level: "inline",
    start(src: string) {
        return src.match(/\$/)?.index;
    },
    tokenizer(src: string) {
        // Block math: $$ ... $$
        const blockMatch = /^\$\$([\s\S]+?)\$\$/.exec(src);
        if (blockMatch?.[1] !== undefined) {
            return {
                type: "math",
                raw: blockMatch[0],
                text: blockMatch[1].trim(),
                display: "yes" as const,
            };
        }
        // Inline math: $...$ with no whitespace in the content (otherwise "costs $5 or $10" becomes
        // math). Bare numbers ($5$) are forbidden too — those are currencies, not latex.
        const inlineMatch = /^\$((?:\\.|[^$\s\\])+)\$(?!\$)/.exec(src);
        if (inlineMatch?.[1] !== undefined) {
            const text = inlineMatch[1].trim();
            if (isCurrencyLikeLatex(text)) return undefined;
            return {
                type: "math",
                raw: inlineMatch[0],
                text,
                display: "no" as const,
            };
        }
        return undefined;
    },
    renderer(token) {
        const t = token as unknown as { text: string; display: string };
        return `<span data-type="inlineMath" data-latex="${escapeHtml(t.text)}" data-display="${t.display}"></span>`;
    },
};

/** One scoped Marked instance per module — it leaves the global `marked` alone. */
const markedImport = new Marked({
    gfm: true,
    breaks: false,
});
markedImport.use({ extensions: [mathExtension] });

/**
 * Turns markdown into sanitised HTML ready for `editor.commands.insertContent`.
 */
export function importMarkdownToHtml(markdown: string): string {
    const raw = markedImport.parse(markdown, { async: false }) as string;
    return sanitizeHtml(raw);
}
