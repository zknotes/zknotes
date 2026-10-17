import {
    buildShareWrapAad,
    decryptItemKey,
    deriveShareKey,
    deriveSharePasswordKeys,
    encryptItemKey,
    generateItemKey,
    generateSalt,
    generateShareLinkKey,
    PRODUCTION_KDF_PARAMS,
    shareLinkKeyFromB64url,
    shareLinkKeyToB64url,
} from "@zknotes/shared";
import { describe, expect, it } from "vitest";
import { resolveSharePasswordKdf } from "./share-crypto";

describe("resolveSharePasswordKdf", () => {
    it("falls back to PRODUCTION_KDF_PARAMS when params missing", () => {
        const res = resolveSharePasswordKdf({ kdfSalt: "abc", kdfParams: undefined });
        expect(res.kdfParams).toEqual(PRODUCTION_KDF_PARAMS);
        expect(res.kdfSaltB64).toBe("abc");
    });
});

describe("password-protected share roundtrip", () => {
    it("unwraps with same password path used by share page", async () => {
        const shareId = "01900000-0000-7000-8000-000000000001";
        const itemId = "01900000-0000-7000-8000-000000000002";
        const pwd = "correct-share-password";
        const salt = generateSalt();
        const saltB64 = btoa(String.fromCharCode(...salt));
        const kdf = resolveSharePasswordKdf({ kdfSalt: saltB64, kdfParams: undefined });

        const linkKey = generateShareLinkKey();
        const fragment = shareLinkKeyToB64url(linkKey);
        const itemKey = generateItemKey();

        const { shareEncKey } = await deriveSharePasswordKeys(pwd, salt, kdf.kdfParams);
        const shareKey = deriveShareKey(linkKey, shareEncKey);
        const wrapped = encryptItemKey(itemKey, shareKey, buildShareWrapAad(shareId, itemId));

        const { shareEncKey: enc2 } = await deriveSharePasswordKeys(pwd, salt, kdf.kdfParams);
        const shareKey2 = deriveShareKey(shareLinkKeyFromB64url(fragment), enc2);
        const unwrapped = decryptItemKey(
            wrapped.ciphertext,
            wrapped.nonce,
            shareKey2,
            buildShareWrapAad(shareId, itemId),
        );
        expect(unwrapped).toEqual(itemKey);
    });
});
