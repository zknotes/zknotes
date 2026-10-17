// Seam 1: the core has to come up with no extensions at all.
//
// This is the only test that guards the boundary itself: if anyone moves an admin route back into
// `app.ts`, "with no extensions" stops meaning "with no admin" and this test fails. In open-core the
// extension list is empty, so this file also proves the core stands on its own.
import { describe, expect, test } from "bun:test";
import { buildApp } from "../src/app";
import { defaultExtensions } from "../src/server";

describe("API extensions seam", () => {
    test("core boots with no extensions and serves no admin routes", async () => {
        const app = await buildApp({ logger: false, extensions: [] });

        // The core's own route still exists.
        const core = await app.inject({ method: "GET", url: "/items?limit=1000" });
        expect(core.statusCode).not.toBe(404);

        // The admin route does not exist — it was never registered, because there is no extension.
        for (const url of ["/admin/auth/me", "/admin/users", "/admin/audit"]) {
            const res = await app.inject({ method: "GET", url });
            expect(res.statusCode).toBe(404);
        }

        await app.close();
    });

    test("onUserRegistered emits harmlessly with no subscriber (seam 4)", async () => {
        const app = await buildApp({ logger: false, extensions: [] });

        // With no subscriber at all, emitting must be a no-op rather than an exception — otherwise open-core registration
        // would depend on such a layer existing.
        expect(() => app.emitUserRegistered({ userId: "test-user" })).not.toThrow();

        // And with a subscriber it arrives exactly once, carrying the payload.
        const seen: string[] = [];
        app.onUserRegistered((e) => {
            seen.push(e.userId);
        });
        app.emitUserRegistered({ userId: "u1" });
        await new Promise((r) => setTimeout(r, 20));
        expect(seen).toEqual(["u1"]);

        await app.close();
    });

    test("/instance-config is reachable without a session (seam 5)", async () => {
        const app = await buildApp({ logger: false, extensions: [] });

        const res = await app.inject({ method: "GET", url: "/instance-config" });
        expect(res.statusCode).toBe(200);

        // With no environment set, a self-host gets no field at all — the client then renders none of those lines.
        const body = res.json();
        expect(body.account).toBeUndefined();
        expect(typeof body).toBe("object");

        await app.close();
    });

    test("core falls back to the permissive entitlements provider (seam 2)", async () => {
        const app = await buildApp({ logger: false, extensions: [] });
        expect(app.entitlements.name).toBe("permissive-env");

        // A self-host has no plan: no label, and nothing is locked behind "paid".
        // The permissive provider does not touch the database, so it does not care what `tx` it gets.
        const limits = await app.entitlements.forUser({} as never, "u1");
        expect(limits.planLabel).toBeNull();
        expect(limits.isPaid).toBe(true);

        await app.close();
    });

    test("the default composition is empty — core knows of no extension", () => {
        // This is an open-core assertion: were anyone to add an extension to `src/server.ts`, the core would load it
        // without the caller knowing.
        expect(defaultExtensions).toEqual([]);
    });
});
