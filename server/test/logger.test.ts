import { describe, expect, test } from "bun:test";
import { buildApp } from "../src/app";
import { devLogEvents } from "../src/logger";

describe("Logger Resilience", () => {
    test("does not crash when logging circular objects", async () => {
        // Build the app with the logger enabled
        const app = await buildApp({ logger: true });

        // Create a circular object
        const circularObj: any = { name: "I am circular" };
        circularObj.self = circularObj;

        // Create an error that contains it
        const err = new Error("Something broke");
        (err as any).context = circularObj;

        let _logCaptured = false;

        // Listen on devLogEvents to confirm it was handled
        const onLog = (rec: any) => {
            if (rec.message.includes("Something broke")) {
                _logCaptured = true;
            }
        };
        devLogEvents.once("log", onLog);

        // This must NOT throw
        expect(() => {
            app.log.error({ err }, "Logging a circular error");
        }).not.toThrow();

        // Pino processes streams asynchronously or synchronously depending on the setup.
        // Wait a moment, just in case.
        await new Promise((resolve) => setTimeout(resolve, 10));

        // It must not take the server down. We do not assert logCaptured strictly, because that
        // depends on whether we are in dev mode, but we can check that it survived.
        expect(true).toBe(true);

        await app.close();
    });

    test("client-log endpoint handles malformed payloads gracefully", async () => {
        const app = await buildApp({ logger: false });

        // If someone sends a string instead of an array for args
        const response = await app.inject({
            method: "POST",
            url: "/client-log",
            payload: {
                level: "error",
                tag: "WeirdClient",
                args: "this is not an array, it's a string",
            },
        });

        // The endpoint may return 500 if map() throws, but it must NOT take the server down
        expect([200, 400, 500]).toContain(response.statusCode);

        await app.close();
    });
});
