import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    appendOp,
    bitcoinHeights,
    createSealTree,
    fromHex,
    HEADER_MAGIC,
    mergeAt,
    OP,
    OtsError,
    parseDetached,
    parseTimestamp,
    pendingAttestations,
    serializeDetached,
    serializeTimestamp,
    sha256Op,
    Timestamp,
    toHex,
} from "./ots-protocol";

// Fixtures captured once from the live calendars — see __fixtures__/README.md.
const fixture = (name: string) =>
    new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)));
const capture = JSON.parse(new TextDecoder().decode(fixture("capture.json"))) as {
    manifest_sha256: string;
    nonce: string;
    commitment: string;
    calendars: Record<string, { url: string; pending: [string, string][] }>;
};
const CALENDARS = Object.keys(capture.calendars);

describe("detached proof round trip", () => {
    it("the official client's pending proof re-serializes byte for byte", async () => {
        const bytes = fixture("official.pending.ots");
        expect(toHex(bytes.slice(0, HEADER_MAGIC.length))).toBe(toHex(HEADER_MAGIC));
        const proof = await parseDetached(bytes);
        const manifestSha = createHash("sha256").update(fixture("manifest.json")).digest("hex");
        expect(toHex(proof.timestamp.msg)).toBe(manifestSha);
        expect(toHex(serializeDetached(proof))).toBe(toHex(bytes));
    });

    it("finds one pending attestation per calendar and no Bitcoin block yet", async () => {
        const proof = await parseDetached(fixture("official.pending.ots"));
        const uris = pendingAttestations(proof.timestamp).map((p) => p.uri);
        expect(uris.sort()).toEqual(CALENDARS.map((c) => capture.calendars[c]?.url).sort());
        expect(bitcoinHeights(proof.timestamp)).toEqual([]);
    });
});

describe("calendar replies", () => {
    it.each(CALENDARS)(
        "%s: the bare reply parses at the commitment and round-trips",
        async (name) => {
            const bytes = fixture(`calendar-${name}.pending.bin`);
            const t = await parseTimestamp(bytes, fromHex(capture.commitment));
            expect(toHex(serializeTimestamp(t))).toBe(toHex(bytes));
            const pending = pendingAttestations(t);
            expect(pending.map((p) => [toHex(p.msg), p.uri])).toEqual(
                capture.calendars[name]?.pending,
            );
        },
    );

    it("merging all four replies equals the reference implementation's proof, byte for byte", async () => {
        const { root, commitment } = await createSealTree(
            fromHex(capture.manifest_sha256),
            fromHex(capture.nonce),
        );
        expect(toHex(commitment.msg)).toBe(capture.commitment);
        // A different arrival order must not change the result: serialization is canonical.
        for (const name of [...CALENDARS].reverse()) {
            await mergeAt(root, commitment.msg, fixture(`calendar-${name}.pending.bin`));
        }
        const merged = serializeDetached({ hashOp: OP.sha256, timestamp: root });
        expect(toHex(merged)).toBe(toHex(fixture("reference-merged.pending.ots")));
    });

    it("merging the same reply twice changes nothing", async () => {
        const { root, commitment } = await createSealTree(
            fromHex(capture.manifest_sha256),
            fromHex(capture.nonce),
        );
        const reply = fixture("calendar-alice.pending.bin");
        await mergeAt(root, commitment.msg, reply);
        const once = serializeTimestamp(root);
        await mergeAt(root, commitment.msg, reply);
        expect(toHex(serializeTimestamp(root))).toBe(toHex(once));
    });

    it("refuses a reply for a message the proof does not contain", async () => {
        const { root } = await createSealTree(new Uint8Array(32), new Uint8Array(16));
        await expect(
            mergeAt(root, new Uint8Array(32).fill(7), fixture("calendar-bob.pending.bin")),
        ).rejects.toThrow(OtsError);
    });
});

describe("malformed input", () => {
    const valid = fixture("official.pending.ots");

    it("rejects a wrong magic, an unknown version and trailing bytes", async () => {
        const badMagic = valid.slice();
        badMagic[1] = 0;
        await expect(parseDetached(badMagic)).rejects.toThrow(OtsError);
        const badVersion = valid.slice();
        badVersion[HEADER_MAGIC.length] = 2;
        await expect(parseDetached(badVersion)).rejects.toThrow(OtsError);
        await expect(parseDetached(new Uint8Array([...valid, 0]))).rejects.toThrow(OtsError);
    });

    it("rejects every truncation instead of reading past the end", async () => {
        for (let n = 0; n < valid.length; n++) {
            await expect(parseDetached(valid.slice(0, n))).rejects.toThrow(OtsError);
        }
    });

    it("rejects an unknown op tag, an empty append argument and an unsupported hash", async () => {
        const msg = new Uint8Array(32);
        await expect(parseTimestamp(new Uint8Array([0x55]), msg)).rejects.toThrow(OtsError);
        await expect(parseTimestamp(new Uint8Array([0xf0, 0x00]), msg)).rejects.toThrow(OtsError);
        const keccakThenPending = new Uint8Array([
            OP.keccak256,
            0x00,
            ...fromHex("83dfe30d2ef90c8e"),
            2,
            1,
            0x61,
        ]);
        await expect(parseTimestamp(keccakThenPending, msg)).rejects.toThrow(OtsError);
    });

    it("rejects a pending URI with a disallowed character", async () => {
        // 0x00 = attestation, pending tag, payload = varbytes(varbytes("a b"))
        const bytes = new Uint8Array([
            0x00,
            ...fromHex("83dfe30d2ef90c8e"),
            4,
            3,
            0x61,
            0x20,
            0x62,
        ]);
        await expect(parseTimestamp(bytes, new Uint8Array(32))).rejects.toThrow(OtsError);
    });

    it("keeps an unknown attestation as opaque bytes and writes it back unchanged", async () => {
        const bytes = new Uint8Array([0x00, 1, 2, 3, 4, 5, 6, 7, 8, 2, 0xaa, 0xbb]);
        const t = await parseTimestamp(bytes, new Uint8Array(32));
        expect(toHex(serializeTimestamp(t))).toBe(toHex(bytes));
    });
});

describe("tree basics", () => {
    it("a Bitcoin attestation with a multi-byte height round-trips", async () => {
        const t = new Timestamp(new Uint8Array(32));
        const leaf = await (await t.addOp(appendOp(new Uint8Array([1])))).addOp(sha256Op);
        leaf.addAttestation({ kind: "bitcoin", height: 923_456 });
        const back = await parseTimestamp(serializeTimestamp(t), t.msg);
        expect(bitcoinHeights(back)).toEqual([923_456]);
    });

    it("an empty tree cannot be serialized", () => {
        expect(() => serializeTimestamp(new Timestamp(new Uint8Array(32)))).toThrow(OtsError);
    });
});
