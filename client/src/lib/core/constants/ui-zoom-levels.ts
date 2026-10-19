// One place of truth for the UI zoom levels — the store, UiZoomPicker and SidebarAppMenu all derive
// from this list (it used to be written three times: a type union, an id array and this table).
export const UI_ZOOM_LEVELS = [
    { id: "auto", label: "Auto" },
    { id: "80", label: "80%" },
    { id: "100", label: "100%" },
    { id: "120", label: "120%" },
    { id: "140", label: "140%" },
    { id: "160", label: "160%" },
    { id: "180", label: "180%" },
    { id: "200", label: "200%" },
    { id: "220", label: "220%" },
    { id: "240", label: "240%" },
] as const;

export type UiZoomLevel = (typeof UI_ZOOM_LEVELS)[number]["id"];
export interface UiZoomLevelPreset {
    id: UiZoomLevel;
    label: string;
}
export const UI_ZOOM_LEVEL_IDS: readonly UiZoomLevel[] = UI_ZOOM_LEVELS.map((l) => l.id);
