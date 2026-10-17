/**
 * The page the service worker answers a navigation with when the server cannot be reached and the
 * app cannot start from the cache.
 *
 * A production build can start from the cache — every chunk is precached, so the last app shell
 * boots offline. A dev server cannot: its modules are never precached, so serving its cached shell
 * left "Loading ZKnotes…" spinning for good, even after the server came back. This page says what is
 * going on, retries on a growing delay (at once when the browser reports a connection or the tab
 * comes back into view), and reloads into the app as soon as the address answers again.
 *
 * Self-contained, because the server is the thing that is away: no stylesheet, script or image is
 * fetched. The response carries its own CSP, and its one inline script and style are allowed by a
 * nonce minted per response.
 */

/** Seconds before each automatic retry; the last one repeats. */
export const RETRY_DELAYS_S: readonly number[] = [2, 4, 8, 15];

const CHECK_TIMEOUT_MS = 10_000;

export function serverUnreachableCsp(nonce: string): string {
    return [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        // The retry asks the page's own address.
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
    ].join("; ");
}

export function renderServerUnreachablePage(nonce: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0a1628">
<title>Can't reach the server — ZKnotes</title>
<style nonce="${nonce}">
    html, body { margin: 0; height: 100%; }
    body {
        display: flex; align-items: center; justify-content: center; padding: 1.5rem;
        box-sizing: border-box; background: #0a1628; color: #f1f5f9;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    main { max-width: 26rem; text-align: center; }
    svg { width: 2.5rem; height: 2.5rem; color: #f59e0b; margin-bottom: 1rem; }
    .eyebrow {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.18em;
        color: rgba(52, 211, 153, 0.8); margin: 0 0 0.5rem;
    }
    h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 0.75rem; }
    p { font-size: 0.875rem; line-height: 1.5; color: #94a3b8; margin: 0 0 1.5rem; }
    button {
        font: inherit; font-size: 0.875rem; font-weight: 600; color: #0a1628;
        background: #34d399; border: 0; border-radius: 0.375rem; padding: 0.625rem 1.25rem;
        cursor: pointer;
    }
    button:disabled { opacity: 0.6; cursor: default; }
    button:focus-visible { outline: 2px solid #f1f5f9; outline-offset: 2px; }
    #status {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 0.75rem; color: #64748b; margin: 1rem 0 0; min-height: 1rem;
    }
</style>
</head>
<body>
<main>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/>
        <path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/>
        <path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/>
        <path d="m2 2 20 20"/>
    </svg>
    <p class="eyebrow">ZKnotes</p>
    <h1>Can't reach the server</h1>
    <p>ZKnotes opens by itself as soon as the server is back. In the meantime, check your internet
    connection.</p>
    <button type="button" id="retry">Try now</button>
    <p id="status"></p>
</main>
<script nonce="${nonce}">
(() => {
    const delays = ${JSON.stringify(RETRY_DELAYS_S)};
    const status = document.getElementById("status");
    const retry = document.getElementById("retry");
    let attempt = 0;
    let countdown;
    let busy = false;

    function schedule() {
        clearInterval(countdown);
        if (document.visibilityState === "hidden") {
            status.textContent = "";
            return;
        }
        let left = delays[Math.min(attempt, delays.length - 1)];
        attempt += 1;
        status.textContent = "Trying again in " + left + " s…";
        countdown = setInterval(() => {
            left -= 1;
            if (left > 0) {
                status.textContent = "Trying again in " + left + " s…";
            } else {
                check();
            }
        }, 1000);
    }

    async function check() {
        if (busy) return;
        busy = true;
        clearInterval(countdown);
        retry.disabled = true;
        status.textContent = "Checking…";
        try {
            const res = await fetch(location.href, {
                cache: "no-store",
                signal: AbortSignal.timeout(${CHECK_TIMEOUT_MS}),
            });
            if (res.ok) {
                status.textContent = "Connected. Opening ZKnotes…";
                location.reload();
                return;
            }
        } catch {}
        busy = false;
        retry.disabled = false;
        schedule();
    }

    retry.addEventListener("click", () => {
        attempt = 0;
        check();
    });
    addEventListener("online", check);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
    });
    schedule();
})();
</script>
</body>
</html>
`;
}

function mintNonce(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return btoa(String.fromCharCode(...bytes));
}

export function serverUnreachableResponse(): Response {
    const nonce = mintNonce();
    return new Response(renderServerUnreachablePage(nonce), {
        status: 503,
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": serverUnreachableCsp(nonce),
        },
    });
}
