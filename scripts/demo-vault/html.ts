/**
 * The HTML fragments TipTap itself serialises, so a demo note opens in the editor exactly as if it
 * had been typed there. Shapes to keep in step with the editor: `enc-file-node.ts` parses
 * `img[data-file-id]`, the math extension reads `data-type="inlineMath"` + `data-latex`, and
 * prosemirror-tables expects block content inside every cell.
 */

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

export const h = (level: 1 | 2 | 3, text: string): string => `<h${level}>${text}</h${level}>`;

export const p = (text: string, align?: "center" | "right"): string =>
    align ? `<p style="text-align: ${align}">${text}</p>` : `<p>${text}</p>`;

export const hr = "<hr>";

export const ul = (items: string[]): string =>
    `<ul>${items.map((item) => `<li><p>${item}</p></li>`).join("")}</ul>`;

export const ol = (items: string[]): string =>
    `<ol>${items.map((item) => `<li><p>${item}</p></li>`).join("")}</ol>`;

export const quote = (...paragraphs: string[]): string =>
    `<blockquote>${paragraphs.map((text) => `<p>${text}</p>`).join("")}</blockquote>`;

export const tasks = (items: Array<[done: boolean, text: string]>): string =>
    `<ul data-type="taskList">${items
        .map(
            ([done, text]) =>
                `<li data-checked="${done}" data-type="taskItem">` +
                `<label><input type="checkbox"${done ? " checked" : ""}><span></span></label>` +
                `<div><p>${text}</p></div></li>`,
        )
        .join("")}</ul>`;

export const code = (language: string, body: string): string =>
    `<pre><code class="language-${language}">${escapeHtml(body)}</code></pre>`;

export const table = (headers: string[], rows: string[][]): string => {
    const head = headers.map((cell) => `<th colspan="1" rowspan="1"><p>${cell}</p></th>`).join("");
    const body = rows
        .map(
            (row) =>
                `<tr>${row.map((cell) => `<td colspan="1" rowspan="1"><p>${cell}</p></td>`).join("")}</tr>`,
        )
        .join("");
    return `<table><tbody><tr>${head}</tr>${body}</tbody></table>`;
};

// ── Inline marks ───────────────────────────────────────────────────────────────

export const b = (text: string): string => `<strong>${text}</strong>`;
export const i = (text: string): string => `<em>${text}</em>`;
export const u = (text: string): string => `<u>${text}</u>`;
export const strike = (text: string): string => `<s>${text}</s>`;
export const mono = (text: string): string => `<code>${escapeHtml(text)}</code>`;
export const sub = (text: string): string => `<sub>${text}</sub>`;
export const sup = (text: string): string => `<sup>${text}</sup>`;

export const mark = (text: string, color = "#fde68a"): string =>
    `<mark data-color="${color}" style="background-color: ${color}; color: inherit">${text}</mark>`;

export const colored = (text: string, color: string): string =>
    `<span style="color: ${color}">${text}</span>`;

export const link = (text: string, href: string): string =>
    `<a target="_blank" rel="noopener" href="${escapeHtml(href)}">${text}</a>`;

/** The @-mention that links one note to another — CustomMention's renderHTML shape. */
export const noteLink = (id: string, label: string): string =>
    `<a href="/note/${id}" data-type="mention" data-id="${id}" data-label="${escapeHtml(label)}"` +
    ` data-note-id="${id}" class="note-link" contenteditable="false">@${label}</a>`;

/**
 * @aarkue/tiptap-math-extension's own serialisation: the attributes in declaration order, and the
 * LaTeX repeated as text content between `$` (or `$$`) delimiters. Emitting anything else means the
 * editor rewrites the node on load and the note opens dirty.
 */
export const math = (latex: string, display = false): string => {
    const fence = display ? "$$" : "$";
    return (
        `<span data-latex="${escapeHtml(latex)}" data-evaluate="no"` +
        ` data-display="${display ? "yes" : "no"}" data-type="inlineMath">` +
        `${escapeHtml(fence + latex + fence)}</span>`
    );
};

/**
 * An attachment embedded in the note body. Three things have to match the editor exactly, or it
 * rewrites the node on load and the note opens dirty:
 *   - `encFile` is a BLOCK node, so the img stands on its own, never inside a paragraph
 *   - `alt` carries the attachment's file name; the NodeView syncs it back to the name it decrypts
 *   - `data-w` / `data-h` are the original's intrinsic pixels, which it otherwise measures and writes
 * The referenced file item's parent must be the note that embeds it (the strict 1:1 model).
 */
export const image = (
    fileId: string,
    fileName: string,
    size: { w: number; h: number },
    mime = "image/png",
): string =>
    `<img data-file-id="${fileId}" alt="${escapeHtml(fileName)}" data-mime="${mime}"` +
    ` data-w="${size.w}" data-h="${size.h}">`;

/**
 * An attachment that is not an image (a PDF, a CSV…): the same block node, which the editor draws
 * as a file chip. With no pixels to measure it carries no `data-w` / `data-h`. The same 1:1 rule
 * holds — the file item's parent is the note that embeds it.
 */
export const attachment = (fileId: string, fileName: string, mime: string): string =>
    `<img data-file-id="${fileId}" alt="${escapeHtml(fileName)}" data-mime="${mime}">`;
