// The search document of an item — a pure function kept apart from the index orchestrator so the
// sync layer, the item service and the index build all share the one rule for titles.
import { extractPlainText } from "$lib/core/utils/tiptap-text";
import type { SearchDoc } from "$lib/core/workers/crypto-rpc";
import { UNTITLED } from "./rank";

/**
 * The search document of one item, built from its decrypted payload. For a file the display name is
 * `name` (notes and folders use `title`) — the hand-built copies this replaces read `title` for
 * every kind and indexed each file as "Untitled". Only a note contributes content.
 */
export function toSearchDoc(
    item: { id: string; type: SearchDoc["type"] },
    payload: { name?: unknown; title?: unknown; content?: unknown },
): SearchDoc {
    const name = typeof payload.name === "string" ? payload.name : "";
    const title = typeof payload.title === "string" ? payload.title : "";
    const doc: SearchDoc = { id: item.id, type: item.type, title: name || title || UNTITLED };
    if (item.type === "note" && typeof payload.content === "string" && payload.content) {
        doc.content = extractPlainText(payload.content);
    }
    return doc;
}
