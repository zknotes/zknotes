// Measures how long a restore commit's writes take against the statement timeout (a per-item
// loop vs. a chunked bulk upsert, plus a second updated_at pass) and the `pull since=0` risk.
// It does not touch the dev database: it targets the test DB (localhost:5433) from
// docker-compose.yml.
import { resolve } from "node:path";
import { topoSortByParent } from "@zknotes/shared";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";

const DB_URL = "postgresql://zknotes:zknotes@localhost:5433/zknotes_test";
const N = Number(process.env.N ?? 100_000);
const PAYLOAD_BYTES = Number(process.env.PAYLOAD_BYTES ?? 1024);
const STATEMENT_TIMEOUT_MS = 15_000;

const ms = (t: number) => `${(t / 1000).toFixed(2)} s`;
const mark = (t: number, budget = STATEMENT_TIMEOUT_MS) =>
    t > budget ? "❌ OVER" : t > budget * 0.5 ? "⚠ close" : "✅";

// Migrations (idempotent) — the same path as server/test/setup.ts
{
    const mc = postgres(DB_URL, { onnotice: () => {} });
    await migrate(drizzle({ client: mc }), {
        migrationsFolder: resolve(import.meta.dir, "../drizzle"),
    });
    await mc.end();
}

const sql = postgres(DB_URL, {
    onnotice: () => {},
    max: 4,
    connection: {
        statement_timeout: STATEMENT_TIMEOUT_MS,
        idle_in_transaction_session_timeout: 30_000,
    },
});

const USER = "restore-measure-user";
console.log(`\n=== SEED: ${N.toLocaleString("en")} items, payload ${PAYLOAD_BYTES} B ===`);

await sql`DELETE FROM items WHERE user_id = ${USER}`;
await sql`DELETE FROM users WHERE id = ${USER}`;
await sql`
    INSERT INTO users (id, email, auth_key_hash, kdf_salt, kdf_params, encrypted_vault_key, vault_key_nonce)
    VALUES (${USER}, ${"restore@measure.local"}, ${"x"}, ${Buffer.alloc(16)}, ${JSON.stringify({ m: 1, t: 1, p: 1 })},
            ${Buffer.alloc(32)}, ${Buffer.alloc(24)})
`;

// The tree: 500 folders (3 deep) plus the remaining notes distributed across them.
type Row = { id: string; parent_id: string | null; type: "note" | "folder" };
const rows: Row[] = [];
const folderIds: string[] = [];
const FOLDERS = 500;
for (let i = 0; i < FOLDERS; i++) {
    const parent = i < 20 ? null : (folderIds[Math.floor(i / 25) - 1] ?? null);
    const id = uuidv7();
    folderIds.push(id);
    rows.push({ id, parent_id: parent, type: "folder" });
}
for (let i = rows.length; i < N; i++) {
    rows.push({ id: uuidv7(), parent_id: folderIds[i % FOLDERS] ?? null, type: "note" });
}

const payload = Buffer.alloc(PAYLOAD_BYTES, 7);
const nonce = Buffer.alloc(24, 3);
const ikey = Buffer.alloc(48, 5);

let t = Bun.nanoseconds();
const CHUNK = 2000;
for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK).map((r) => ({
        id: r.id,
        user_id: USER,
        type: r.type,
        parent_id: r.parent_id,
        encrypted_payload: payload,
        payload_nonce: nonce,
        encrypted_item_key: ikey,
        item_key_nonce: nonce,
        version: 1,
        sort_order: "a0",
        created_at: 1700000000,
        updated_at: 1700000000,
    }));
    await sql`INSERT INTO items ${sql(slice)}`;
}
console.log(`seed done in ${ms((Bun.nanoseconds() - t) / 1e6)}`);

// ── topoSortByParent (pure CPU, outside the transaction) ─────────────────────
console.log(`\n=== topoSortByParent (${N.toLocaleString("en")} items) ===`);
t = Bun.nanoseconds();
const sorted = topoSortByParent(rows, (r) => r.parent_id);
const topoMs = (Bun.nanoseconds() - t) / 1e6;
console.log(`a realistic tree (depth ~3): ${ms(topoMs)} ${mark(topoMs)}  (${sorted.length} items)`);

// A deep chain — recursion through the parents
for (const depth of [5_000, 20_000, 100_000]) {
    const chain: Row[] = [];
    let prev: string | null = null;
    for (let i = 0; i < depth; i++) {
        const id = uuidv7();
        chain.push({ id, parent_id: prev, type: "folder" });
        prev = id;
    }
    chain.reverse(); // the worst case: a child before its parent
    try {
        const t2 = Bun.nanoseconds();
        topoSortByParent(chain, (r) => r.parent_id);
        console.log(
            `a chain of depth ${depth.toLocaleString("en")}: ✅ ${ms((Bun.nanoseconds() - t2) / 1e6)}`,
        );
    } catch (e) {
        console.log(`a chain of depth ${depth.toLocaleString("en")}: ❌ ${(e as Error).message}`);
    }
}

// ── The naive per-item loop (the shape of POST /items/batch) ─────────────────
const sample = rows.slice(0, Number(process.env.LOOP_N ?? 5_000));
console.log(
    `\n=== A per-item loop (a sample of ${sample.length.toLocaleString("en")}, then extrapolated) ===`,
);
t = Bun.nanoseconds();
await sql.begin(async (tx) => {
    for (const r of sample) {
        await tx`SELECT * FROM items WHERE id = ${r.id} AND user_id = ${USER} FOR UPDATE`;
        await tx`UPDATE items SET encrypted_payload = ${payload}, version = version + 1,
                 updated_at = ${1700001000} WHERE id = ${r.id}`;
        await tx`SELECT storage_used_items FROM users WHERE id = ${USER} FOR UPDATE`;
        await tx`UPDATE users SET storage_used_items = storage_used_items + 0 WHERE id = ${USER}`;
    }
});
const loopMs = (Bun.nanoseconds() - t) / 1e6;
const loopFull = (loopMs / sample.length) * N;
console.log(
    `sample: ${ms(loopMs)}  →  extrapolated to ${N.toLocaleString("en")}: ${ms(loopFull)} ${mark(loopFull)}`,
);

// ── The same loop without the per-item quota ─────────────────────────────────
console.log(`\n=== The per-item loop without the per-item quota ===`);
t = Bun.nanoseconds();
await sql.begin(async (tx) => {
    for (const r of sample) {
        await tx`SELECT * FROM items WHERE id = ${r.id} AND user_id = ${USER} FOR UPDATE`;
        await tx`UPDATE items SET encrypted_payload = ${payload}, version = version + 1,
                 updated_at = ${1700001001} WHERE id = ${r.id}`;
    }
    await tx`UPDATE users SET storage_used_items = storage_used_items + 0 WHERE id = ${USER}`;
});
const loopBMs = (Bun.nanoseconds() - t) / 1e6;
const loopBFull = (loopBMs / sample.length) * N;
console.log(`sample: ${ms(loopBMs)}  →  extrapolated: ${ms(loopBFull)} ${mark(loopBFull)}`);

// ── A bulk upsert in chunks (the commit's realistic design) ──────────────────
for (const chunkSize of [1000, 5000]) {
    console.log(`\n=== Bulk upsert, chunk ${chunkSize} (all ${N.toLocaleString("en")}) ===`);
    t = Bun.nanoseconds();
    let maxStmt = 0;
    await sql.begin(async (tx) => {
        for (let i = 0; i < rows.length; i += chunkSize) {
            const slice = rows.slice(i, i + chunkSize).map((r) => ({
                id: r.id,
                user_id: USER,
                type: r.type,
                parent_id: r.parent_id,
                encrypted_payload: payload,
                payload_nonce: nonce,
                encrypted_item_key: ikey,
                item_key_nonce: nonce,
                version: 2,
                sort_order: "a0",
                created_at: 1700000000,
                updated_at: 1700002000,
            }));
            const st = Bun.nanoseconds();
            await tx`
                INSERT INTO items ${tx(slice)}
                ON CONFLICT (id) DO UPDATE SET
                    encrypted_payload = EXCLUDED.encrypted_payload,
                    version = items.version + 1,
                    updated_at = EXCLUDED.updated_at
            `;
            maxStmt = Math.max(maxStmt, (Bun.nanoseconds() - st) / 1e6);
        }
        await tx`UPDATE users SET storage_used_items = storage_used_items + 0 WHERE id = ${USER}`;
    });
    const bulkMs = (Bun.nanoseconds() - t) / 1e6;
    console.log(
        `total: ${ms(bulkMs)} ${mark(bulkMs)}   longest SINGLE statement: ${ms(maxStmt)} ${mark(maxStmt)}`,
    );
}

// ── A second short pass — bump updated_at ────────────────────────────────────
console.log(`\n=== A second pass, UPDATE updated_at over an indexed column ===`);
t = Bun.nanoseconds();
await sql`UPDATE items SET updated_at = ${1700003000} WHERE user_id = ${USER}`;
const secondPassMs = (Bun.nanoseconds() - t) / 1e6;
console.log(
    `one statement over ${N.toLocaleString("en")} rows: ${ms(secondPassMs)} ${mark(secondPassMs)}`,
);

// ── pull since=0 ─────────────────────────────────────────────────────────────
console.log(`\n=== Risk: GET /items?since=0 (no pagination) ===`);
t = Bun.nanoseconds();
const all = await sql`SELECT * FROM items WHERE user_id = ${USER}`;
const queryMs = (Bun.nanoseconds() - t) / 1e6;
t = Bun.nanoseconds();
type WireRow = {
    id: string;
    type: string;
    parent_id: string | null;
    encrypted_payload: Buffer | null;
    payload_nonce: Buffer | null;
    encrypted_item_key: Buffer | null;
    item_key_nonce: Buffer | null;
    version: number;
    sort_order: string;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
};
const wire = (all as unknown as WireRow[]).map((r) => ({
    id: r.id,
    type: r.type,
    parent_id: r.parent_id,
    encrypted_payload: r.encrypted_payload?.toString("base64") ?? null,
    payload_nonce: r.payload_nonce?.toString("base64") ?? null,
    encrypted_item_key: r.encrypted_item_key?.toString("base64") ?? null,
    item_key_nonce: r.item_key_nonce?.toString("base64") ?? null,
    version: r.version,
    sort_order: r.sort_order,
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at,
}));
const json = JSON.stringify({ items: wire, deleted: [], server_time: Date.now() });
const serMs = (Bun.nanoseconds() - t) / 1e6;
console.log(
    `query: ${ms(queryMs)}   serialisation: ${ms(serMs)}   JSON: ${(json.length / 1024 / 1024).toFixed(1)} MB`,
);
console.log(
    `(Fastify's bodyLimit is 30 MB, but that is for the REQUEST — this is the response, which has no limit.)`,
);

// The same series, but keyset pages as in GET /items?limit=
const { SYNC_LIMITS } = await import("@zknotes/shared");
const pageSize = SYNC_LIMITS.PULL_PAGE_SIZE;
let maxPageBytes = 0;
let pageCount = 0;
t = Bun.nanoseconds();
for (let i = 0; i < wire.length; i += pageSize) {
    const slice = wire.slice(i, i + pageSize);
    const pageJson = JSON.stringify({
        items: slice,
        deleted: [],
        server_time: Date.now(),
        server_time_iso: new Date().toISOString(),
        next_cursor: i + pageSize < wire.length ? "cursor" : null,
    });
    maxPageBytes = Math.max(maxPageBytes, pageJson.length);
    pageCount += 1;
}
const pageMs = (Bun.nanoseconds() - t) / 1e6;
console.log(`\n=== GET /items?since=0&limit=${pageSize} (paginated) ===`);
console.log(
    `pages: ${pageCount}   peak size: ${(maxPageBytes / 1024 / 1024).toFixed(2)} MB   (limit ${SYNC_LIMITS.PULL_PAGE_BYTES / 1024 / 1024} MiB)   serialising every page: ${ms(pageMs)}`,
);

await sql`DELETE FROM items WHERE user_id = ${USER}`;
await sql`DELETE FROM users WHERE id = ${USER}`;
await sql.end();
console.log("\ndone, the test data has been cleaned up.\n");
