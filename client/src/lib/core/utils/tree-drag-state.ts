// Shares the baseline X coordinate for the drag-outdent gesture between FolderItem instances. The
// baseline is reset ONLY when the hovered node actually changes (`hoveredId`), not on every dragover
// event — otherwise every micro-movement of the mouse within one row (crossing the icon or the text, a
// dragenter bubbling up from an inner element) would reset the measurement and the outdent would never
// fire. A plain mutable object (not $state) — it is read and written imperatively, in event handlers
// only.
export const treeDragState = {
    hoveredId: null as string | null,
    baselineX: 0,
};
