import { describe, expect, it } from "vitest";
import { fromBase64, toBase64 } from "./base64";

describe("toBase64 / fromBase64", () => {
    it("round-trips a random Uint8Array", () => {
        const bytes = new Uint8Array(64);
        crypto.getRandomValues(bytes);
        expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    });

    it("an empty Uint8Array encodes to an empty string", () => {
        expect(toBase64(new Uint8Array(0))).toBe("");
    });

    it("an empty string decodes to a Uint8Array of length 0", () => {
        expect(fromBase64("")).toEqual(new Uint8Array(0));
    });

    it("a known value: 'Hello' → 'SGVsbG8='", () => {
        const hello = new Uint8Array([72, 101, 108, 108, 111]);
        expect(toBase64(hello)).toBe("SGVsbG8=");
    });

    it("a known value: 'SGVsbG8=' → [72, 101, 108, 108, 111]", () => {
        expect(fromBase64("SGVsbG8=")).toEqual(new Uint8Array([72, 101, 108, 108, 111]));
    });

    it("every byte value 0-255 round-trips without loss", () => {
        const allBytes = new Uint8Array(256);
        for (let i = 0; i < 256; i++) allBytes[i] = i;
        expect(fromBase64(toBase64(allBytes))).toEqual(allBytes);
    });

    it("a 16-byte nonce round trip (the typical case in the crypto code)", () => {
        const nonce = new Uint8Array(24);
        crypto.getRandomValues(nonce);
        expect(fromBase64(toBase64(nonce))).toEqual(nonce);
    });
});
