// Saas spec 156 (package G): what keeps an unsafe or malformed public link out of /instance-config.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { buildApp } from "../../src/app";

let app: Awaited<ReturnType<typeof buildApp>>;
const saved = {
    www: process.env.PUBLIC_WWW_URL,
    manage: process.env.ACCOUNT_MANAGE_URL,
    env: process.env.NODE_ENV,
};

beforeAll(async () => {
    app = await buildApp({ logger: false });
});
afterAll(async () => {
    await app.close();
});
afterEach(() => {
    if (saved.www === undefined) delete process.env.PUBLIC_WWW_URL;
    else process.env.PUBLIC_WWW_URL = saved.www;
    if (saved.manage === undefined) delete process.env.ACCOUNT_MANAGE_URL;
    else process.env.ACCOUNT_MANAGE_URL = saved.manage;
    process.env.NODE_ENV = saved.env;
});

const config = async () => (await app.inject({ method: "GET", url: "/instance-config" })).json();

describe("instance-config public links", () => {
    test("a trailing slash is dropped, a malformed value or a non-web scheme is omitted", async () => {
        process.env.PUBLIC_WWW_URL = "https://zknotes.eu/";
        process.env.ACCOUNT_MANAGE_URL = "javascript:alert(1)";
        const body = await config();
        expect(body.wwwUrl).toBe("https://zknotes.eu");
        expect(body.account?.manageUrl).toBeUndefined();

        process.env.PUBLIC_WWW_URL = "not a url";
        expect((await config()).wwwUrl).toBeUndefined();
    });

    test("plain http is allowed in development but omitted in production", async () => {
        process.env.PUBLIC_WWW_URL = "http://zknotes.localhost";
        expect((await config()).wwwUrl).toBe("http://zknotes.localhost");
        process.env.NODE_ENV = "production";
        expect((await config()).wwwUrl).toBeUndefined();
    });
});
