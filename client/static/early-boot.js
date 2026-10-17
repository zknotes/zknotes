// Runs before the SvelteKit bundle (see app.html). Keep FOUC-critical and
// beforeinstallprompt capture here so the document shell can stay free of
// inline scripts under production CSP (script-src 'self' + build hashes only).
(() => {
    const stored = localStorage.getItem("theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = stored === "dark" || (!stored && prefersDark);
    if (isDark) document.documentElement.classList.add("dark");
})();

(() => {
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const noHover = !window.matchMedia("(hover: hover)").matches;
    if (coarse || noHover) document.documentElement.classList.add("is-touch");
})();

// Key must stay in sync with STORAGE_KEYS.uiZoom (persisted.ts) + UiZoomLevel union.
// --ui-zoom-factor must match ui-zoom store applyLevel (for .ui-zoom-immune menus).
(() => {
    try {
        const stored = localStorage.getItem("cn_ui_zoom");
        const levels = ["80", "100", "120", "140", "160", "180", "200", "220", "240"];
        if (levels.includes(stored)) {
            document.documentElement.style.fontSize = `${stored}%`;
            document.documentElement.style.setProperty(
                "--ui-zoom-factor",
                String(Number(stored) / 100),
            );
        }
    } catch {
        /* private mode / blocked storage */
    }
})();

window.deferredPromptEvent = null;
window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    window.deferredPromptEvent = e;
});
