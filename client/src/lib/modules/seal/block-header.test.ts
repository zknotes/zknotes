import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BlockHeaderError, checkBlockHeader, MIN_DIFFICULTY, targetFromBits } from "./block-header";
import { fromHex, parseDetached } from "./ots-protocol";

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));
const header = (h: number) => fixture(`block-${h}.header.hex`).toString().trim();

/** The Merkle root the confirmed proof commits to at each height (internal byte order). */
async function rootsByHeight(): Promise<Map<number, Uint8Array>> {
    const proof = await parseDetached(new Uint8Array(fixture("reference-merged.confirmed.ots")));
    const out = new Map<number, Uint8Array>();
    for (const { msg, attestation } of proof.timestamp.allAttestations()) {
        if (attestation.kind === "bitcoin") out.set(attestation.height, msg);
    }
    return out;
}

// The block times a public explorer showed for the fixture's blocks.
const TIMES: Record<number, number> = {
    975_723: 1_794_611_103,
    975_735: 1_794_624_493,
    975_749: 1_794_635_294,
};

describe("checkBlockHeader", () => {
    it.each(Object.keys(TIMES).map(Number))(
        "block %i: real header, real proof → its time",
        async (h) => {
            const roots = await rootsByHeight();
            expect(await checkBlockHeader(header(h), roots.get(h) as Uint8Array)).toBe(TIMES[h]);
        },
    );

    it("refuses a real header that is not the block the proof names", async () => {
        const roots = await rootsByHeight();
        await expect(
            checkBlockHeader(header(975_735), roots.get(975_723) as Uint8Array),
        ).rejects.toThrow(/not for the block/);
    });

    it("refuses a header whose time was changed (the proof of work no longer holds)", async () => {
        const roots = await rootsByHeight();
        const bytes = fromHex(header(975_723));
        bytes[68] = (bytes[68] as number) ^ 0x01;
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
        await expect(checkBlockHeader(hex, roots.get(975_723) as Uint8Array)).rejects.toThrow(
            /proof of work/,
        );
    });

    it("refuses a header that claims an easy target, before any hashing", async () => {
        const roots = await rootsByHeight();
        const bytes = fromHex(header(975_723));
        // bits 0x1d00ffff = difficulty 1, trivially minable
        bytes.set([0xff, 0xff, 0x00, 0x1d], 72);
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
        await expect(checkBlockHeader(hex, roots.get(975_723) as Uint8Array)).rejects.toThrow(
            BlockHeaderError,
        );
    });

    it("refuses anything that is not 80 bytes of hex", async () => {
        await expect(checkBlockHeader("00", new Uint8Array(32))).rejects.toThrow(BlockHeaderError);
        await expect(checkBlockHeader("zz".repeat(80), new Uint8Array(32))).rejects.toThrow(
            BlockHeaderError,
        );
    });

    it("the real chain's difficulty is well above the floor", () => {
        const target = targetFromBits(0x1701e5ac) as bigint;
        const maxTarget = 0xffffn << (8n * (0x1dn - 3n));
        expect(maxTarget / target).toBeGreaterThan(MIN_DIFFICULTY * 10n);
    });
});
