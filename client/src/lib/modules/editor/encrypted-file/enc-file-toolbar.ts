// The hover/selection toolbar for an encFile node (Crop / Info / Remove) — lifted out of
// enc-file-node.ts's addNodeView god function. It owns only the toolbar DOM plus the selection
// ring on the host; the actions bubble as CustomEvents from the `host` element (NoteFileEvents catches
// them). The decision of WHEN to show it (isSelected/editable/the async load state) belongs to the
// NodeView, through `syncToolbar` — this is the rendering alone.

import { APP_EVENTS } from "$lib/core/constants/events";

const RING_CLASSES = ["ring-2", "ring-brand0/60", "rounded-md"] as const;
const BTN_BASE = "text-xs px-2 py-0.5 rounded text-white transition";

export class ToolbarController {
    private toolbar: HTMLElement | null = null;

    constructor(private readonly host: HTMLElement) {}

    get visible(): boolean {
        return this.toolbar !== null;
    }

    /** Bubbles the action up to the NoteFileEvents handler (the same host as download/crop/info/delete). */
    private dispatch(event: string, fileId: string): void {
        this.host.dispatchEvent(new CustomEvent(event, { detail: { fileId }, bubbles: true }));
    }

    private makeButton(
        label: string,
        hover: string,
        event: string,
        fileId: string,
    ): HTMLButtonElement {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `${BTN_BASE} bg-black/70 ${hover}`;
        btn.textContent = label;
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            this.dispatch(event, fileId);
        });
        return btn;
    }

    /**
     * Shows the toolbar for `fileId`.
     * @param isImage — true ONLY when the NodeView rendered a raster `<img>` (a blob URL).
     *   A streamed video or a file chip has a URL or a rendering, but Crop has to stay off.
     * Info and Crop are hidden for deleted files (Remove only). Idempotent.
     */
    show(fileId: string, isImage: boolean, isDeletedFile = false): void {
        if (this.toolbar) return;
        this.host.classList.add(...RING_CLASSES);

        const toolbar = document.createElement("span");
        toolbar.className = "absolute top-1.5 right-1.5 flex items-center gap-1 z-20";
        toolbar.contentEditable = "false";
        // A preventDefault on mousedown keeps the focus on the editor (it prevents a blur + teardown
        // before the click); stopPropagation stops ProseMirror treating the mousedown as a
        // cursor placement.
        toolbar.addEventListener("mousedown", (e) => {
            e.stopPropagation();
            e.preventDefault();
        });

        if (isImage && !isDeletedFile) {
            toolbar.appendChild(
                this.makeButton("Crop", "hover:bg-brand0", APP_EVENTS.encfileCropRequest, fileId),
            );
        }
        if (!isDeletedFile) {
            toolbar.appendChild(
                this.makeButton(
                    "Info",
                    "hover:bg-[var(--row-hover)]",
                    APP_EVENTS.encfileInfo,
                    fileId,
                ),
            );
        }
        toolbar.appendChild(
            this.makeButton("Remove", "hover:bg-red-600", APP_EVENTS.encfileDelete, fileId),
        );

        this.host.appendChild(toolbar);
        this.toolbar = toolbar;
    }

    clear(): void {
        this.toolbar?.remove();
        this.toolbar = null;
        this.host.classList.remove(...RING_CLASSES);
    }
}
