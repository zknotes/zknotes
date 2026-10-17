import { error } from "@sveltejs/kit";
import { dev } from "$app/environment";

// The dev tools (/dev/*) exist only on a dev server. A production build answers 404 rather than a
// page that says it is for developers.
export function load() {
    if (!dev) error(404, "Not found");
}
