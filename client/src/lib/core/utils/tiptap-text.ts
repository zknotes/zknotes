/**
 * Extracts the indexable plaintext out of a note's content payload.
 *
 * `content` is currently stored as an HTML string (from `editor.getHTML()`), but we accept TipTap JSON
 * trees too, for forward compatibility.
 *
 * Image nodes and data: URIs are discarded so the encrypted index does not explode when notes embed
 * base64 images. The output is capped at MAX_LEN.
 */

const MAX_LEN = 50_000;

export function extractPlainText(content: unknown): string {
    if (!content) return "";

    let text: string;
    if (typeof content === "string") {
        text = stripHtml(content);
    } else if (typeof content === "object") {
        text = walkTipTapNode(content);
    } else {
        return "";
    }

    text = text.replace(/\s+/g, " ").trim();
    return text.length > MAX_LEN ? text.slice(0, MAX_LEN) : text;
}

function stripHtml(html: string): string {
    // Discard the script/style blocks entirely, then remove everything else.
    // Worker-safe (with no DOMParser dependency).
    return (
        html
            .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
            .replace(/<img\b[^>]*>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            // Last, so that the text "&lt;" (stored as "&amp;lt;") stays "&lt;" and is not decoded twice.
            .replace(/&amp;/g, "&")
    );
}

interface TipTapNode {
    type?: string;
    text?: string;
    attrs?: { label?: string; id?: string };
    content?: unknown[];
}

function walkTipTapNode(node: unknown): string {
    if (!node || typeof node !== "object") return "";
    const n = node as TipTapNode;
    if (n.type === "image") return "";
    if (n.type === "mention") {
        return `@${n.attrs?.label || n.attrs?.id || ""}`;
    }

    const parts: string[] = [];
    if (typeof n.text === "string") parts.push(n.text);
    if (Array.isArray(n.content)) {
        for (const child of n.content) {
            parts.push(walkTipTapNode(child));
        }
    }
    return parts.join(" ");
}
