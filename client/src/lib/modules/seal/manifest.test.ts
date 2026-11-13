import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    decodeManifest,
    encodeManifest,
    ManifestError,
    manifestDigest,
    newManifest,
} from "./manifest";
import { toHex } from "./ots-protocol";

const fixture = (name: string) =>
    new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)));

describe("manifest test vector", () => {
    const bytes = fixture("manifest.json");
    const capture = JSON.parse(new TextDecoder().decode(fixture("capture.json"))) as {
        manifest_sha256: string;
    };

    it("decodes the fixture and encodes it back to the same bytes", async () => {
        const m = decodeManifest(bytes);
        expect(m.seal_id).toBe("ea91cf4f-6a72-4c42-80e2-88b6ee280213");
        expect(toHex(encodeManifest(m))).toBe(toHex(bytes));
        expect(toHex(await manifestDigest(bytes))).toBe(capture.manifest_sha256);
    });

    it("names the sealed file by its plain SHA-256 and length", () => {
        const file = fixture("sealed-file.txt");
        const m = decodeManifest(bytes);
        expect(m.content_sha256).toBe(createHash("sha256").update(file).digest("hex"));
        expect(m.byte_length).toBe(file.length);
    });

    it("a fixed input always gives the same bytes", () => {
        const m = newManifest(
            { contentSha256: "ab".repeat(32), contentType: "application/pdf", byteLength: 1234 },
            new Date("2026-01-02T03:04:05.006Z"),
            "00000000-0000-4000-8000-000000000000",
        );
        expect(new TextDecoder().decode(encodeManifest(m))).toBe(
            '{"byte_length":1234,"content_sha256":"abababababababababababababababababababababababababababababababab",' +
                '"content_type":"application/pdf","schema":"zknotes-seal/1",' +
                '"seal_id":"00000000-0000-4000-8000-000000000000","sealed_at":"2026-01-02T03:04:05.006Z"}',
        );
    });
});

describe("validation", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const good = new TextDecoder().decode(fixture("manifest.json"));

    it("refuses non-canonical bytes of an otherwise valid manifest", () => {
        expect(() => decodeManifest(enc(good.replace(",", ", ")))).toThrow(ManifestError);
        const reordered = JSON.stringify({ schema: "zknotes-seal/1", ...JSON.parse(good) });
        expect(() => decodeManifest(enc(reordered))).toThrow(ManifestError);
    });

    it("refuses extra or missing fields and a wrong schema", () => {
        const obj = JSON.parse(good);
        expect(() => decodeManifest(enc(JSON.stringify({ ...obj, name: "x" })))).toThrow(
            ManifestError,
        );
        const { seal_id: _, ...missing } = obj;
        expect(() => decodeManifest(enc(JSON.stringify(missing)))).toThrow(ManifestError);
        expect(() => decodeManifest(enc(good.replace("zknotes-seal/1", "zknotes-seal/2")))).toThrow(
            ManifestError,
        );
    });

    it("falls back to octet-stream for an unusable content type", () => {
        const m = newManifest({ contentSha256: "00".repeat(32), contentType: "", byteLength: 0 });
        expect(m.content_type).toBe("application/octet-stream");
        expect(m.seal_id).toMatch(/^[0-9a-f-]{36}$/);
    });
});
