// Extends the stock TipTap Image node with a draggable resize handle.
// `updateAttributes` is NOT available in the vanilla NodeViewRendererProps (only in the React/Vue/Svelte
// wrappers), so we commit width changes through getPos + tr.setNodeMarkup directly.

import type { NodeViewRendererProps } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

export const ImageResize = Image.extend({
    addAttributes() {
        return {
            ...this.parent?.(),
            width: {
                default: null,
                parseHTML: (el) => (el as HTMLElement).getAttribute("width") || null,
                renderHTML: (attrs) => {
                    if (!attrs.width) return {};
                    return { width: attrs.width, style: `width:${attrs.width};height:auto;` };
                },
            },
        };
    },

    addNodeView() {
        return (props: NodeViewRendererProps) => {
            const { node, editor, getPos } = props;

            const wrapper = document.createElement("figure");
            wrapper.className = "image-resize-wrapper";
            wrapper.style.cssText =
                "position:relative;display:block;width:fit-content;margin:1.2em 0;";

            const img = document.createElement("img");
            img.src = node.attrs.src || "";
            img.alt = node.attrs.alt || "";
            img.style.cssText = "display:block;border-radius:8px;max-width:100%;height:auto;";
            if (node.attrs.width) img.style.width = node.attrs.width;
            img.draggable = false;
            wrapper.appendChild(img);

            // The handle's visibility is controlled by CSS (.image-resize-wrapper:hover).
            const handle = document.createElement("div");
            handle.className = "image-resize-handle";
            wrapper.appendChild(handle);

            // Read the current attrs out of the live document — the `node` from the props goes stale
            // after the first setNodeMarkup call.
            const commitWidth = (px: number) => {
                // A mouseup can arrive after the editor has been destroyed (a navigation mid-drag).
                if (editor.isDestroyed) return;
                if (typeof getPos !== "function") return;
                const pos = getPos();
                if (pos === undefined) return;
                const live = editor.state.doc.nodeAt(pos);
                if (!live) return;
                editor.view.dispatch(
                    editor.state.tr.setNodeMarkup(pos, undefined, {
                        ...live.attrs,
                        width: `${px}px`,
                    }),
                );
            };

            handle.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const startX = e.clientX;
                const startW = img.offsetWidth;
                const onMove = (e: MouseEvent) => {
                    img.style.width = `${Math.max(50, startW + (e.clientX - startX))}px`;
                };
                const onUp = (e: MouseEvent) => {
                    commitWidth(Math.max(50, startW + (e.clientX - startX)));
                    document.removeEventListener("mousemove", onMove);
                    document.removeEventListener("mouseup", onUp);
                };
                document.addEventListener("mousemove", onMove);
                document.addEventListener("mouseup", onUp);
            });

            return {
                dom: wrapper,
                selectNode() {
                    wrapper.classList.add("selected");
                },
                deselectNode() {
                    wrapper.classList.remove("selected");
                },
                update(updatedNode: ProseMirrorNode) {
                    if (updatedNode.type.name !== "image") return false;
                    img.src = updatedNode.attrs.src || "";
                    img.alt = updatedNode.attrs.alt || "";
                    if (updatedNode.attrs.width) img.style.width = updatedNode.attrs.width;
                    else img.style.removeProperty("width");
                    return true;
                },
            };
        };
    },
});
