/**
 * With the server away, the service worker used to hand a dev tab its cached app shell, whose
 * modules were never cached: "Loading ZKnotes…" spun for good and stayed that way after the server
 * came back. The page that replaces it can rely on nothing from the server, and must still pass the
 * CSP it ships with.
 */
import { describe, expect, it } from "vitest";
import {
    renderServerUnreachablePage,
    serverUnreachableCsp,
    serverUnreachableResponse,
} from "./server-unreachable-page";

describe("server unreachable page", () => {
    it("explains what happened and offers a way to try again", () => {
        const html = renderServerUnreachablePage("n0nce");
        expect(html).toContain("Can't reach the server");
        expect(html).toContain('id="retry"');
    });

    it("loads nothing from the server — every style and script is inline", () => {
        const html = renderServerUnreachablePage("n0nce");
        expect(html).not.toMatch(/\s(src|href)=/i);
        expect(html).not.toMatch(/<link\b/i);
    });

    it("its inline style and script carry the nonce its CSP allows, and nothing else runs", () => {
        const html = renderServerUnreachablePage("n0nce");
        const csp = serverUnreachableCsp("n0nce");

        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain("script-src 'nonce-n0nce'");
        expect(csp).toContain("style-src 'nonce-n0nce'");
        expect(csp).not.toContain("unsafe-inline");

        const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
        const styles = html.match(/<style\b[^>]*>/gi) ?? [];
        expect(scripts).toEqual(['<script nonce="n0nce">']);
        expect(styles).toEqual(['<style nonce="n0nce">']);
        // No inline event handlers or style attributes — the CSP would block them silently.
        expect(html).not.toMatch(/\son[a-z]+=/i);
        expect(html).not.toMatch(/\sstyle=/i);
    });

    it("is answered as an uncacheable 503 with a fresh nonce each time", async () => {
        const a = serverUnreachableResponse();
        const b = serverUnreachableResponse();

        expect(a.status).toBe(503);
        expect(a.headers.get("Cache-Control")).toBe("no-store");
        expect(a.headers.get("Content-Type")).toBe("text/html; charset=utf-8");

        const nonceOf = (r: Response) =>
            r.headers.get("Content-Security-Policy")?.match(/'nonce-([^']+)'/)?.[1];
        const nonceA = nonceOf(a);
        expect(nonceA).toBeTruthy();
        expect(nonceA).not.toBe(nonceOf(b));
        expect(await a.text()).toContain(`<script nonce="${nonceA}">`);
    });
});
