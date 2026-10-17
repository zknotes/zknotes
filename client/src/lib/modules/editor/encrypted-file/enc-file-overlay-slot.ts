// A single-slot mount/unmount for the encFile node's upload-progress overlay — lifted out of
// enc-file-node.ts. It keeps at most one overlay element in the host; `render` replaces the
// previous one and `clear` takes it away. The overlay element itself is built by the NodeView
// (makeUploadOverlay) — this is only the slot's lifecycle.

export class OverlaySlot {
    private overlay: HTMLElement | null = null;

    constructor(private readonly host: HTMLElement) {}

    /** Replaces the current overlay with a new element. */
    render(el: HTMLElement): void {
        this.clear();
        this.overlay = el;
        this.host.appendChild(el);
    }

    clear(): void {
        this.overlay?.remove();
        this.overlay = null;
    }
}
