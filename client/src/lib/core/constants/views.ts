// The utility views the sidebar offers as quick access (Starred / Trash / Recent / Files): one table
// for the buttons, the active-route match and the close-button titles, so a view cannot be renamed
// in one place and not the other.
import { Clock, Files, Star, Trash2 } from "lucide-svelte";
import type { LucideIcon } from "$lib/core/types/icons";

export type UtilityView = "starred" | "trash" | "recent" | "files";

export interface QuickView {
    id: UtilityView;
    path: string;
    label: string;
    /** The button tooltip. */
    title: string;
    icon: LucideIcon;
    /** The icon classes while the view is active (the accent colour of the view). */
    activeIconClass: string;
    /** The counter classes while the view is active. */
    activeCountClass: string;
}

export const QUICK_VIEWS: readonly QuickView[] = [
    {
        id: "starred",
        path: "/starred",
        label: "Starred",
        title: "Starred notes",
        icon: Star,
        activeIconClass: "text-amber-400 fill-current",
        activeCountClass: "text-amber-400/70",
    },
    {
        id: "trash",
        path: "/trash",
        label: "Trash",
        title: "Trash",
        icon: Trash2,
        activeIconClass: "text-rose-400",
        activeCountClass: "text-rose-400/70",
    },
    {
        id: "recent",
        path: "/recent",
        label: "Recent",
        title: "Recently opened",
        icon: Clock,
        activeIconClass: "text-sky-400",
        activeCountClass: "text-sky-400/70",
    },
    {
        id: "files",
        path: "/files",
        label: "Files",
        title: "All files",
        icon: Files,
        activeIconClass: "text-indigo-400",
        activeCountClass: "text-indigo-400/70",
    },
];

/** The quick view whose route `pathname` is under, or undefined for the notes area. */
export function quickViewForPath(pathname: string): QuickView | undefined {
    return QUICK_VIEWS.find((v) => pathname.startsWith(v.path));
}
