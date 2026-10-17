// A light HTML → Markdown converter for the HTML TipTap generates.
// It covers the subset TipTap produces: headings, bold, italic, strikethrough, code (inline + block),
// links, ordered/unordered lists, blockquotes, horizontal rules and encFile image references.
// A note on v1 fidelity: complex nested structures may lose their formatting — deliberately so.

import { sanitizeHtml } from "./dompurify";

export function htmlToMarkdown(html: string): string {
    const cleanHtml = sanitizeHtml(html);
    const doc = new DOMParser().parseFromString(cleanHtml, "text/html");
    return nodeToMd(doc.body).trim();
}

function nodeToMd(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
        return (node.textContent ?? "").replace(/\n/g, " ");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const inner = () => childrenToMd(el);

    switch (tag) {
        case "h1":
            return `# ${inner()}\n\n`;
        case "h2":
            return `## ${inner()}\n\n`;
        case "h3":
            return `### ${inner()}\n\n`;
        case "h4":
            return `#### ${inner()}\n\n`;
        case "p":
            return `${inner()}\n\n`;
        case "br":
            return "\n";
        case "strong":
        case "b":
            return `**${inner()}**`;
        case "em":
        case "i":
            return `_${inner()}_`;
        case "s":
        case "del":
        case "strike":
            return `~~${inner()}~~`;
        case "code":
            return el.closest("pre") ? inner() : `\`${inner()}\``;
        case "pre": {
            const lang = (el.querySelector("code")?.className ?? "").replace("language-", "");
            return `\`\`\`${lang}\n${el.textContent ?? ""}\n\`\`\`\n\n`;
        }
        case "blockquote":
            return `${childrenToMd(el)
                .split("\n")
                .map((l) => `> ${l}`)
                .join("\n")}\n\n`;
        case "hr":
            return `---\n\n`;
        case "a": {
            const href = el.getAttribute("href") ?? "";
            return `[${inner()}](${href})`;
        }
        case "img": {
            // An encFile reference: use data-file-id as the path hint
            const fileId = el.getAttribute("data-file-id");
            const alt = el.getAttribute("alt") ?? "";
            if (fileId) return `![${alt}](./_attachments/${fileId})`;
            const src = el.getAttribute("src") ?? "";
            if (src.startsWith("data:")) return `![${alt}](_image_embedded)`; // base64 — skip it
            return `![${alt}](${src})`;
        }
        case "ul":
            return `${listToMd(el, false)}\n`;
        case "ol":
            return `${listToMd(el, true)}\n`;
        case "li":
            return inner(); // listToMd handles it
        case "table":
            return `${tableToMd(el)}\n`;
        case "div":
        case "section":
        case "article":
            return `${inner()}\n`;
        default:
            return inner();
    }
}

function childrenToMd(el: Element): string {
    return [...el.childNodes].map(nodeToMd).join("");
}

function listToMd(ul: HTMLElement, ordered: boolean): string {
    const items = [...ul.children].filter((c) => c.tagName.toLowerCase() === "li");
    return items
        .map((li, i) => {
            const prefix = ordered ? `${i + 1}. ` : "- ";
            const content = childrenToMd(li as HTMLElement)
                .trimEnd()
                .replace(/\n/g, `\n${" ".repeat(prefix.length)}`);
            return `${prefix}${content}`;
        })
        .join("\n");
}

function tableToMd(table: HTMLElement): string {
    const rows = [...table.querySelectorAll("tr")];
    if (rows.length === 0) return "";
    const lines: string[] = [];
    rows.forEach((row, i) => {
        const cells = [...row.querySelectorAll("th,td")].map((c) =>
            childrenToMd(c as HTMLElement)
                .trim()
                .replace(/\|/g, "\\|"),
        );
        lines.push(`| ${cells.join(" | ")} |`);
        if (i === 0) lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
    });
    return lines.join("\n");
}
