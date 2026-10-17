// The resize handle for an encFile image — lifted out of the enc-file-node.ts addNodeView god
// function. It owns only the DOM handle and the drag mechanics; committing the width (a
// ProseMirror transaction) stays with the caller through the `onCommit` callback (the NodeView knows
// getPos/editor.view).

export interface ResizeControllerOpts {
    /** The image whose width the drag changes (a live preview through `style.width`). */
    img: HTMLImageElement;
    /** A read-only editor hides the handle and allows no resize. */
    editable: boolean;
    /** Called at the end of the drag with the final width in px (min 50). The NodeView commits it into the PM doc. */
    onCommit: (px: number) => void;
}

const MIN_WIDTH = 50;
const FALLBACK_WIDTH = 400;

export class ResizeController {
    /** The DOM element the caller appends into the host and shows or hides through `setVisible`. */
    readonly handle: HTMLElement;

    private readonly editable: boolean;

    constructor(opts: ResizeControllerOpts) {
        this.editable = opts.editable;

        const handle = document.createElement("div");
        handle.className = "encfile-resize-handle";
        if (!opts.editable) handle.style.display = "none";

        handle.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const startX = e.clientX;
            const startW = opts.img.offsetWidth || FALLBACK_WIDTH;
            const widthAt = (clientX: number) => Math.max(MIN_WIDTH, startW + (clientX - startX));
            const onMove = (ev: MouseEvent) => {
                opts.img.style.width = `${widthAt(ev.clientX)}px`;
            };
            const onUp = (ev: MouseEvent) => {
                opts.onCommit(widthAt(ev.clientX));
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
            };
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });

        this.handle = handle;
    }

    /** Follows the image's visibility (the handle hides when the image does). A no-op in read-only mode. */
    setVisible(visible: boolean): void {
        if (this.editable) this.handle.style.display = visible ? "" : "none";
    }
}
