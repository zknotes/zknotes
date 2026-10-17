import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { DecorationSet } from "@tiptap/pm/view";

/**
 * The sync highlight: it briefly colours the blocks that changed when content arrives from another
 * device (a pull). The decorations live in the plugin's state rather than in the doc, so they touch
 * neither the content nor the dirty flag and the undo stack. Setting and clearing go through meta
 * transactions; the CSS class `.sync-flash-highlight` animates the fade.
 */
export const syncHighlightKey = new PluginKey<DecorationSet>("syncHighlight");

interface SetMeta {
    decorations: DecorationSet;
}

export const SyncHighlight = Extension.create({
    name: "syncHighlight",
    addProseMirrorPlugins() {
        return [
            new Plugin<DecorationSet>({
                key: syncHighlightKey,
                state: {
                    init: () => DecorationSet.empty,
                    apply(tr, old) {
                        const meta = tr.getMeta(syncHighlightKey) as SetMeta | undefined;
                        if (meta) return meta.decorations;
                        // Map the existing decorations through the doc's changes, in case the user types during the flash.
                        return old.map(tr.mapping, tr.doc);
                    },
                },
                props: {
                    decorations(state) {
                        return syncHighlightKey.getState(state);
                    },
                },
            }),
        ];
    },
});

/** The text of every top-level block in the current doc — for the before/after diff around a content swap. */
export function topBlockTexts(doc: PMNode): string[] {
    const texts: string[] = [];
    doc.forEach((node) => {
        texts.push(node.textContent);
    });
    return texts;
}

/**
 * Compares the new top-level blocks with the previous ones (a multiset keyed by text) and returns the [from, to] ranges
 * of the blocks missing from the old set — those are the changed or new blocks to highlight.
 */
export function changedBlockRanges(doc: PMNode, beforeTexts: string[]): Array<[number, number]> {
    const remaining = new Map<string, number>();
    for (const t of beforeTexts) remaining.set(t, (remaining.get(t) ?? 0) + 1);

    const ranges: Array<[number, number]> = [];
    let pos = 0;
    doc.forEach((node) => {
        const text = node.textContent;
        const count = remaining.get(text) ?? 0;
        if (count > 0 && text !== "") {
            // An unchanged block — consume one instance from the old set.
            remaining.set(text, count - 1);
        } else if (text !== "") {
            // A new or changed block carrying text — highlight it.
            ranges.push([pos, pos + node.nodeSize]);
        }
        pos += node.nodeSize;
    });
    return ranges;
}
