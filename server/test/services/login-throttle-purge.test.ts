// Saas spec 156 (package G): the GC of stale sign-in failure runs — which rows go and which stay.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app";
import { db } from "../../src/db";
import { loginFailures } from "../../src/db/schema";
import { purgeStaleSignInFailures, SOURCE_POLICY } from "../../src/services/login-throttle";
import { createTestUser, getUserIdByEmail, resetDb } from "../helpers";

let app: Awaited<ReturnType<typeof buildApp>>;
let userId: string;
const NOW = 1_800_000_000;

beforeAll(async () => {
    app = await buildApp({ logger: false });
});
afterAll(async () => {
    await app.close();
});
beforeEach(async () => {
    await resetDb();
    const { email } = await createTestUser(app);
    userId = (await getUserIdByEmail(email)) as string;
});

async function run(source: string, windowStartedAt: number, lockedUntil: number | null) {
    await db.insert(loginFailures).values({
        user_id: userId,
        source,
        failed_attempts: 3,
        window_started_at: windowStartedAt,
        locked_until: lockedUntil,
    });
}

describe("purgeStaleSignInFailures", () => {
    test("deletes runs past their window unless a lock is still in force", async () => {
        const stale = NOW - SOURCE_POLICY.windowSeconds - 1;
        await run("stale-unlocked", stale, null);
        await run("stale-lock-expired", stale, NOW - 1);
        await run("stale-still-locked", stale, NOW + 60);
        await run("fresh", NOW - 10, null);

        expect(await purgeStaleSignInFailures(NOW)).toBe(2);
        const left = (
            await db.select().from(loginFailures).where(eq(loginFailures.user_id, userId))
        )
            .map((r) => r.source)
            .sort();
        expect(left).toEqual(["fresh", "stale-still-locked"]);
    });
});
