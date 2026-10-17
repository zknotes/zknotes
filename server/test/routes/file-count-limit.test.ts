// MAX_FILE_COUNT used to be honoured only by a restore: POST /items and /items/batch checked the
// built-in ceiling, so the documented override did nothing for ordinary uploads.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../../src/app";
import {
    createSeededFileItem,
    createTestUser,
    filePayload,
    getUserIdByEmail,
    insertChunkSet,
    resetDb,
} from "../helpers";

let app: FastifyInstance;
let cookie: string;
let email: string;
const previous = process.env.MAX_FILE_COUNT;

beforeAll(async () => {
    app = await buildApp();
    await app.ready();
});

afterAll(async () => {
    await app.close();
});

beforeEach(async () => {
    await resetDb();
    ({ cookie, email } = await createTestUser(app));
});

afterEach(() => {
    if (previous === undefined) delete process.env.MAX_FILE_COUNT;
    else process.env.MAX_FILE_COUNT = previous;
});

describe("MAX_FILE_COUNT", () => {
    test("lowers the live-file ceiling for an ordinary file create", async () => {
        process.env.MAX_FILE_COUNT = "1";
        await createSeededFileItem(app, cookie, email, 100);

        const userId = (await getUserIdByEmail(email)) as string;
        const chunkSetId = uuidv7();
        await insertChunkSet(chunkSetId, userId, { totalSize: 100 });
        const res = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: filePayload(uuidv7(), chunkSetId),
        });
        expect(res.statusCode).toBe(429);
        expect(res.json().error).toBe("file_count_limit_exceeded");
    });
});
