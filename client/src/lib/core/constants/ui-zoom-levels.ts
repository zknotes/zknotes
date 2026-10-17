import type { UiZoomLevel } from "$lib/core/stores/ui-zoom.svelte";

export interface UiZoomLevelPreset {
    id: UiZoomLevel;
    label: string;
}

// One place of truth for the list of UI zoom levels — UiZoomPicker and SidebarAppMenu both use it.
export const UI_ZOOM_LEVELS: UiZoomLevelPreset[] = [
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
];
