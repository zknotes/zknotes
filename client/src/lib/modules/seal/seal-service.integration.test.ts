import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
    buildChunkAad,
    buildItemKeyAad,
    buildPayloadAad,
    encryptChunk,
    encryptItemKey,
    encryptPayload,
    generateItemKey,
    type SealWire,
} from "@zknotes/shared";
import { unzipSync } from "fflate";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── A fake server: the seal routes as the client sees them ─────────────────────────────────────
const server = vi.hoisted(() => ({
    rows: new Map<string, SealWire>(),
    commitments: [] as string[],
    calendarsDown: false,
    confirmUpgrades: false,
    upgradeReply: null as null | ((message: string) => string),
    pendingReply: "" as string,
}));

vi.mock("$lib/core/api", async (importOriginal) => {
    const actual = await importOriginal<typeof import("$lib/core/api")>();
    const now = () => Math.floor(Date.now() / 1000);
    return {
        ...actual,
        createSeal: vi.fn(
            async (body: { id: string; chunk_set_id: string; commitment: string }) => {
                server.commitments.push(body.commitment);
                if (server.calendarsDown) {
                    throw new actual.ApiError("Bad gateway", 502, {
                        error: "calendars_unavailable",
                    });
                }
                server.rows.set(body.id, {
                    id: body.id,
                    chunk_set_id: body.chunk_set_id,
                    state: "pending",
                    encrypted_record: null,
                    record_nonce: null,
                    encrypted_seal_key: null,
                    seal_key_nonce: null,
                    created_at: now(),
                    updated_at: now(),
                });
                return {
                    id: body.id,
                    replies: [
                        { calendar: "https://a.example", ok: true, body: server.pendingReply },
                        { calendar: "https://b.example", ok: false },
                    ],
                };
            },
        ),
        putSeal: vi.fn(async (id: string, body: Record<string, string>) => {
            const row = server.rows.get(id);
            if (!row) throw new actual.ApiError("Not found", 404, { error: "not_found" });
            const next = { ...row, ...body, updated_at: now() } as SealWire;
            server.rows.set(id, next);
            return next;
        }),
        listSeals: vi.fn(async () => ({
            seals: [...server.rows.values()],
            limit: { per_day: 20, used_today: server.rows.size },
        })),
        upgradeSeal: vi.fn(
            async (
                _id: string,
                body: { attestations: Array<{ calendar: string; message: string }> },
            ) => ({
                results: body.attestations.map((a) =>
                    server.confirmUpgrades && server.upgradeReply
                        ? { ...a, status: "confirmed", body: server.upgradeReply(a.message) }
                        : { ...a, status: "pending" },
                ),
            }),
        ),
        deleteSeal: vi.fn(async (id: string) => {
            server.rows.delete(id);
        }),
    };
});

vi.mock("$lib/core/workers/crypto-rpc", async (importOriginal) => {
    const rpc = await importOriginal<typeof import("$lib/core/workers/crypto-rpc")>();
    const { loadInProcessCryptoWorker } = await import("$lib/core/workers/crypto-worker.testkit");
    const worker = new rpc.CryptoWorkerClient(await loadInProcessCryptoWorker());
    return {
        ...rpc,
        unlockWorker: (vk: Uint8Array) => worker.unlock(vk),
        decryptPayloadWithKeyTask: (...a: Parameters<typeof rpc.decryptPayloadWithKeyTask>) =>
            worker.decryptPayloadWithKey(...a),
        decryptChunkTask: (...a: Parameters<typeof rpc.decryptChunkTask>) =>
            worker.decryptChunk(...a),
        sealHashStartTask: (s: string) => worker.sealHashStart(s),
        sealHashChunkTask: (a: Parameters<typeof rpc.sealHashChunkTask>[0]) =>
            worker.sealHashChunk(a),
        sealHashFinishTask: (s: string) => worker.sealHashFinish(s),
        sealEncryptRecordTask: (id: string, r: object) => worker.sealEncryptRecord(id, r),
        sealDecryptRecordTask: (id: string, c: Parameters<typeof rpc.sealDecryptRecordTask>[1]) =>
            worker.sealDecryptRecord(id, c),
    };
});

import { getDB, type LocalItem } from "$lib/core/db";
import { putLocalChunk } from "$lib/core/db/file-chunks";
import { fromBase64, toBase64 } from "$lib/core/utils/base64";
import { unlockWorker } from "$lib/core/workers/crypto-rpc";
import { createMemorySink } from "$lib/modules/export/sink";
import {
    appendOp,
    fromHex,
    parseDetached,
    serializeTimestamp,
    sha256Op,
    Timestamp,
    toHex,
} from "./ots-protocol";
import { writeCertificateArchive } from "./seal-export";
import { loadSeals, SealError, sealFile, sealsForChunkSet, upgradeOne } from "./seal-service";

const vaultKey = new Uint8Array(32).fill(9);
const FILE_ID = "0192f0d0-0000-7000-8000-0000000000f1";
const CHUNK_SET = "0192f0d0-0000-7000-8000-0000000000c1";
const fileBytes = new Uint8Array(300_000).map((_, i) => (i * 31) % 251);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A file of three chunks in IDB, encrypted exactly as an upload would. */
async function seedFile() {
    const ik = generateItemKey();
    const wrapped = encryptItemKey(ik, vaultKey, buildItemKeyAad(FILE_ID));
    const chunkSize = 128 * 1024;
    const total = Math.ceil(fileBytes.length / chunkSize);
    const chunks = [];
    for (let i = 0; i < total; i++) {
        const plain = fileBytes.subarray(i * chunkSize, (i + 1) * chunkSize);
        const { ciphertext, nonce } = encryptChunk(plain, ik, buildChunkAad(CHUNK_SET, i, total));
        await putLocalChunk({
            key: `${CHUNK_SET}:${i}`,
            chunkSetId: CHUNK_SET,
            index: i,
            ciphertext,
            nonce,
            storedAt: Date.now(),
        });
        const hash = new Uint8Array(
            await crypto.subtle.digest("SHA-256", ciphertext as BufferSource),
        );
        chunks.push({ nonce: toBase64(nonce), hash: toBase64(hash), size: ciphertext.byteLength });
    }
    const payload = {
        kind: "file",
        chunkSetId: CHUNK_SET,
        name: "contract.pdf",
        mime: "application/pdf",
        size: fileBytes.length,
        chunkSize,
        chunks,
    };
    const enc = encryptPayload(payload, ik, buildPayloadAad(FILE_ID, 1));
    const row: LocalItem = {
        id: FILE_ID,
        parent_id: null,
        type: "file",
        encrypted_payload: toBase64(enc.ciphertext),
        payload_nonce: toBase64(enc.nonce),
        encrypted_item_key: toBase64(wrapped.ciphertext),
        item_key_nonce: toBase64(wrapped.nonce),
        chunk_set_id: CHUNK_SET,
        chunk_count: total,
        sort_order: "m",
        version: 1,
        dirty: false,
        localRev: 0,
        created_at: 1,
        updated_at: 1,
    };
    await (await getDB()).put("items", row);
}

/** A completed answer for a pending message: one hash and a Bitcoin block attestation. */
async function confirmedReply(messageHex: string): Promise<string> {
    const t = new Timestamp(fromHex(messageHex));
    const leaf = await (await t.addOp(appendOp(new Uint8Array([7])))).addOp(sha256Op);
    leaf.addAttestation({ kind: "bitcoin", height: 900_123 });
    return toBase64(serializeTimestamp(t));
}

beforeAll(async () => {
    const fixtures = new URL("./__fixtures__/", import.meta.url);
    server.pendingReply = toBase64(
        new Uint8Array(readFileSync(new URL("calendar-alice.pending.bin", fixtures))),
    );
});

beforeEach(async () => {
    const db = await getDB();
    await db.clear("items");
    await db.clear("file-chunks");
    server.rows.clear();
    server.commitments = [];
    server.calendarsDown = false;
    server.confirmUpgrades = false;
    await unlockWorker(vaultKey.slice());
    await seedFile();
});

describe("sealFile", () => {
    it("sends only a commitment and stores an encrypted record the vault can read back", async () => {
        const view = await sealFile(FILE_ID);
        expect(view.state).toBe("pending");
        expect(view.manifest.content_sha256).toBe(sha(fileBytes));
        expect(view.manifest.byte_length).toBe(fileBytes.length);
        expect(view.manifest.content_type).toBe("application/pdf");

        // The server saw a 32-byte commitment that is neither the file hash nor the manifest hash.
        const [commitment] = server.commitments;
        expect(commitment).toMatch(/^[0-9a-f]{64}$/);
        expect(commitment).not.toBe(view.manifest.content_sha256);
        expect(commitment).not.toBe(sha(new TextEncoder().encode(view.record.manifest)));

        // What the server keeps contains neither the name nor the hash in the clear.
        const stored = server.rows.get(view.id);
        const blob = Buffer.from(fromBase64(stored?.encrypted_record ?? "")).toString("latin1");
        expect(blob).not.toContain("contract.pdf");
        expect(blob).not.toContain(view.manifest.content_sha256);

        const { seals } = await loadSeals();
        expect(seals.map((s) => s.id)).toEqual([view.id]);
        expect(seals[0]?.record.file_name).toBe("contract.pdf");
        const proof = await parseDetached(fromBase64(seals[0]?.record.proof ?? ""));
        expect(toHex(proof.timestamp.msg)).toBe(
            sha(new TextEncoder().encode(view.record.manifest)),
        );
    });

    it("AC3 on the client: no usable calendar → an error, and nothing is kept", async () => {
        server.calendarsDown = true;
        await expect(sealFile(FILE_ID)).rejects.toMatchObject({
            code: "calendars_unavailable",
        } satisfies Partial<SealError>);
        expect(server.rows.size).toBe(0);
    });

    it("groups seals by the chunk set inside the record, not the server's column", async () => {
        const view = await sealFile(FILE_ID);
        const row = server.rows.get(view.id) as SealWire;
        server.rows.set(view.id, { ...row, chunk_set_id: "someone-elses-set" });
        const { seals } = await loadSeals();
        expect(sealsForChunkSet(seals, CHUNK_SET).map((s) => s.id)).toEqual([view.id]);
        expect(sealsForChunkSet(seals, "someone-elses-set")).toEqual([]);
    });

    it("a record moved onto another row id is not shown", async () => {
        const view = await sealFile(FILE_ID);
        const row = server.rows.get(view.id) as SealWire;
        server.rows.delete(view.id);
        server.rows.set("0192f0d0-0000-7000-8000-00000000dead", {
            ...row,
            id: "0192f0d0-0000-7000-8000-00000000dead",
        });
        expect((await loadSeals()).seals).toEqual([]);
    });
});

describe("upgrade and export", () => {
    it("a completed answer turns the seal confirmed; the archive checks out", async () => {
        const pending = await sealFile(FILE_ID);
        // Still pending: nothing changes and nothing is written.
        expect(await upgradeOne(pending)).toBe(pending);

        // AC7: a pending seal cannot be exported.
        await expect(
            writeCertificateArchive(createMemorySink().sink, pending, null),
        ).rejects.toThrow(/pending/);

        const replies = new Map<string, string>();
        for (const msg of (await parseDetached(fromBase64(pending.record.proof))).timestamp
            .allAttestations()
            .map((a) => toHex(a.msg))) {
            replies.set(msg, await confirmedReply(msg));
        }
        server.upgradeReply = (m) => replies.get(m) ?? "";
        server.confirmUpgrades = true;

        const confirmed = await upgradeOne(pending);
        expect(confirmed.state).toBe("confirmed");
        expect(confirmed.blocks).toEqual([900_123]);
        expect(confirmed.record.confirmed_at).toBeTruthy();
        expect(server.rows.get(pending.id)?.state).toBe("confirmed");
        const reloaded = (await loadSeals()).seals[0];
        expect(reloaded?.blocks).toEqual([900_123]);

        const { sink, bytes } = createMemorySink();
        const db = await getDB();
        const item = await db.get("items", FILE_ID);
        const { decryptItemPayload } = await import("$lib/core/crypto/item-codec");
        const payload = await decryptItemPayload<import("@zknotes/shared").FilePayload>(
            item as LocalItem,
        );
        await writeCertificateArchive(sink, confirmed, { itemId: FILE_ID, payload });

        const zip = unzipSync(bytes());
        expect(Object.keys(zip).sort()).toEqual(
            [
                "VERIFY.txt",
                "certificate.pdf",
                "contract.pdf",
                "manifest.json",
                "manifest.json.ots",
            ].sort(),
        );
        // Step 1–2 of VERIFY.txt: the file's SHA-256 is the manifest's content_sha256.
        const manifest = JSON.parse(new TextDecoder().decode(zip["manifest.json"]));
        expect(sha(zip["contract.pdf"] as Uint8Array)).toBe(manifest.content_sha256);
        // Step 3: the proof is over these manifest bytes.
        const proof = await parseDetached(zip["manifest.json.ots"] as Uint8Array);
        expect(toHex(proof.timestamp.msg)).toBe(sha(zip["manifest.json"] as Uint8Array));
        expect(new TextDecoder().decode((zip["certificate.pdf"] as Uint8Array).slice(0, 5))).toBe(
            "%PDF-",
        );
        const verify = new TextDecoder().decode(zip["VERIFY.txt"]);
        expect(verify).toContain(manifest.content_sha256);
        expect(verify).toContain("ots verify manifest.json.ots");
    }, 30_000);
});
