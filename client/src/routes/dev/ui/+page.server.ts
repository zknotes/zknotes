// Prevent browser caching of the dev UI gallery page.
// This ensures that CSS/JS changes and visual tests (like disabled buttons, colors per theme)
// are always fresh when developing or when inspecting the page.
export const load = ({ setHeaders }) => {
    setHeaders({
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
        Pragma: "no-cache",
        Expires: "0",
    });
};
