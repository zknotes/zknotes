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

describe("confirmed proofs (the calendars' answers once the stamp reached a block)", () => {
    /**
     * The Merkle roots of the blocks the fixture reached, as a public block explorer shows them
     * (checked by hand when the fixtures were captured). The attestation's message is the root in
     * the block header's internal byte order, which is the reverse of how explorers print it.
     */
    const BLOCK_ROOTS: Record<number, string> = {
        975_723: "1065c893e473b750ba9025f9b521464f7a45cfc3496f83416d7382a636f5ef61",
        975_735: "556a65b1425a60a76b0947234fa0eae6ec16a475e5a7bd83edc45359f633db67",
        975_749: "76109e3749fdf60f1ffe7832fe83e61c87b3117e69cc7d928931b519e34c3d0a",
    };

    it("AC2: the official client's upgraded proof re-serializes byte for byte", async () => {
        const bytes = fixture("official.confirmed.ots");
        const proof = await parseDetached(bytes);
        expect(toHex(serializeDetached(proof))).toBe(toHex(bytes));
        expect(bitcoinHeights(proof.timestamp)).toEqual([975_723]);
    });

    it.each(CALENDARS)(
        "%s: the completed reply parses at its pending message and round-trips",
        async (name) => {
            const [message] = capture.calendars[name]?.pending[0] ?? [];
            const bytes = fixture(`calendar-${name}.upgrade.bin`);
            const t = await parseTimestamp(bytes, fromHex(message as string));
            expect(toHex(serializeTimestamp(t))).toBe(toHex(bytes));
            expect(bitcoinHeights(t).length).toBe(1);
        },
    );

    it("AC2: pending replies plus every upgrade merge into the reference implementation's bytes", async () => {
        const { root, commitment } = await createSealTree(
            fromHex(capture.manifest_sha256),
            fromHex(capture.nonce),
        );
        for (const name of CALENDARS) {
            await mergeAt(root, commitment.msg, fixture(`calendar-${name}.pending.bin`));
        }
        // The client asks with the pending message the proof itself names, never a stored one.
        for (const { uri, msg } of pendingAttestations(root)) {
            const name = CALENDARS.find((c) => capture.calendars[c]?.url === uri) as string;
            await mergeAt(root, msg, fixture(`calendar-${name}.upgrade.bin`));
        }
        const merged = serializeDetached({ hashOp: OP.sha256, timestamp: root });
        expect(toHex(merged)).toBe(toHex(fixture("reference-merged.confirmed.ots")));
        expect(bitcoinHeights(root)).toEqual([975_723, 975_735, 975_749]);
    });

    it("every Bitcoin attestation's message is that block's Merkle root", async () => {
        const proof = await parseDetached(fixture("reference-merged.confirmed.ots"));
        for (const { msg, attestation } of proof.timestamp.allAttestations()) {
            if (attestation.kind !== "bitcoin") continue;
            expect(toHex(msg.slice().reverse())).toBe(BLOCK_ROOTS[attestation.height]);
        }
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
