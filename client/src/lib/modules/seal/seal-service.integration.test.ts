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
    /** What the block source answers, by height; empty = the source is off. */
    blockHeaders: new Map<number, string>(),
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
        getSealBlock: vi.fn(async (height: number) => {
            const header = server.blockHeaders.get(height);
            if (!header) {
                throw new actual.ApiError("Conflict", 409, { error: "block_source_disabled" });
            }
            return { height, header };
        }),
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
import { txUrl } from "./explorer";
import {
    appendOp,
    type BitcoinAnchor,
    bitcoinAnchors,
    fromHex,
    parseDetached,
    serializeTimestamp,
    sha256Op,
    Timestamp,
    toHex,
} from "./ots-protocol";
import { buildCertificatePdf } from "./seal-pdf";
import { verifyText, writeCertificateArchive } from "./seal-export";
import {
    loadSeals,
    resolveBlockTime,
    SealError,
    type SealView,
    sealFile,
    sealsForChunkSet,
    upgradeOne,
} from "./seal-service";
import { decodeManifest } from "./manifest";

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
    server.blockHeaders.clear();
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

/** The anchors of `reference-merged.confirmed.ots` (values pinned in ots-protocol.test.ts). */
let REAL_ANCHORS: BitcoinAnchor[] = [];
beforeAll(async () => {
    const bytes = new Uint8Array(
        readFileSync(new URL("./__fixtures__/reference-merged.confirmed.ots", import.meta.url)),
    );
    REAL_ANCHORS = bitcoinAnchors((await parseDetached(bytes)).timestamp);
});

describe("block time", () => {
    const fixtureText = (name: string) =>
        readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url))
            .toString()
            .trim();
    const fixtureB64 = (name: string) =>
        toBase64(new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url))));

    /** The real seal captured from the public calendars, as a confirmed view stored on the fake server. */
    function realConfirmedSeal(): SealView {
        const id = "0192f0d0-0000-7000-8000-0000000000b1";
        const manifest = fixtureText("manifest.json");
        server.rows.set(id, {
            id,
            chunk_set_id: CHUNK_SET,
            state: "confirmed",
            encrypted_record: null,
            record_nonce: null,
            encrypted_seal_key: null,
            seal_key_nonce: null,
            created_at: 1,
            updated_at: 1,
        });
        return {
            id,
            state: "confirmed",
            createdAt: 1,
            manifest: decodeManifest(new TextEncoder().encode(manifest)),
            blocks: [975_723, 975_735, 975_749],
            anchors: REAL_ANCHORS,
            record: {
                v: 1,
                chunk_set_id: CHUNK_SET,
                file_name: "sealed-file.txt",
                manifest,
                proof: fixtureB64("reference-merged.confirmed.ots"),
                confirmed_at: "2026-11-14T02:02:00.000Z",
            },
        };
    }

    it("takes the earliest block whose header checks out, and keeps it in the record", async () => {
        for (const h of [975_723, 975_735, 975_749]) {
            server.blockHeaders.set(h, fixtureText(`block-${h}.header.hex`));
        }
        const view = await resolveBlockTime(realConfirmedSeal());
        expect(view.record.block_time).toBe("2026-11-13T23:05:03.000Z");
        expect(view.record.block_height).toBe(975_723);

        const { seals } = await loadSeals();
        expect(seals.find((s) => s.id === view.id)?.record.block_time).toBe(
            "2026-11-13T23:05:03.000Z",
        );
    });

    it("ignores a source that answers with the wrong block", async () => {
        // Two heights answered with a real, valid header — of a different block; the third not at all.
        const other = fixtureText("block-975749.header.hex");
        for (const h of [975_723, 975_735]) server.blockHeaders.set(h, other);
        const view = await resolveBlockTime(realConfirmedSeal());
        expect(view.record.block_time).toBeUndefined();
    });

    it("with the source off, nothing changes", async () => {
        const seal = realConfirmedSeal();
        expect(await resolveBlockTime(seal)).toBe(seal);
    });

    it("spec 171 AC4: VERIFY.txt links every anchor's transaction and says it is not the fingerprint", () => {
        const seal = realConfirmedSeal();
        expect(seal.anchors.length).toBe(4);
        const text = verifyText(seal, "sealed-file.txt");
        for (const a of seal.anchors) {
            expect(text).toContain(`Block ${a.height}, transaction ${a.txid}`);
            expect(text).toContain(txUrl(a.txid));
            expect(text).toContain(`OP_RETURN: ${a.opReturn}`);
        }
        expect(text).toContain("It is NOT the file's fingerprint");
        expect(Math.max(...text.split("\n").map((l) => l.length))).toBeLessThanOrEqual(110);
    });

    it("spec 171 AC4: without recognized anchors VERIFY.txt keeps today's text", () => {
        const text = verifyText({ ...realConfirmedSeal(), anchors: [] }, "sealed-file.txt");
        expect(text).not.toContain("OP_RETURN");
        expect(text).toContain("Block height(s): 975723, 975735, 975749");
    });

    it("spec 171 AC5: the PDF names every transaction and links it", async () => {
        const seal = {
            ...realConfirmedSeal(),
            record: {
                ...realConfirmedSeal().record,
                block_time: "2026-11-13T23:05:03.000Z",
                block_height: 975_723,
            },
        };
        const pdf = new TextDecoder("latin1").decode(await buildCertificatePdf(seal));
        for (const a of seal.anchors) {
            expect(pdf).toContain(a.txid);
            expect(pdf).toContain(`/URI (${txUrl(a.txid)})`);
        }
        // Four anchors move the whole legal notice to a second page instead of off the first.
        expect(pdf.match(/\/Type \/Page\b/g)?.length).toBe(2);
        expect(pdf).toContain("evidentiary value");
        // Spec 169 §3: the certificate names no ledger technology.
        expect(pdf).not.toMatch(/bitcoin|blockchain/i);

        // Two anchors (two calendars in one block, the common case) still fit on one page.
        const two = new TextDecoder("latin1").decode(
            await buildCertificatePdf({ ...seal, anchors: seal.anchors.slice(0, 2) }),
        );
        expect(two.match(/\/Type \/Page\b/g)?.length).toBe(1);
    });
});
