import { argon2id as nobleArgon2id } from "@noble/hashes/argon2.js";
import { describe, expect, it } from "vitest";
import {
    assertKdfParamsFloor,
    buildChunkAad,
    buildItemKeyAad,
    buildPayloadAad,
    buildShareWrapAad,
    DEFAULT_KDF_PARAMS,
    decryptChunk,
    decryptItemKey,
    decryptPayload,
    deriveAuthKey,
    deriveEncryptionKey,
    deriveMasterKey,
    deriveShareKey,
    deriveSharePasswordKeys,
    deriveShareViewProof,
    encryptChunk,
    encryptItemKey,
    encryptPayload,
    generateItemKey,
    generateNonce,
    generateSalt,
    generateShareLinkKey,
    kdfParamsBelowFloor,
    MAX_KDF_MEMORY_KIB,
    PRODUCTION_KDF_PARAMS,
    shareLinkKeyFromB64url,
    shareLinkKeyToB64url,
    shareViewProofToB64,
    viewProofB64FromFragmentKey,
    zeroize,
} from "./cryptography";

describe("Cryptography Utils", () => {
    it("should generate correct size nonces and salts", () => {
        expect(generateNonce().length).toBe(24);
        expect(generateSalt().length).toBe(16);
        expect(generateItemKey().length).toBe(32);
    });

    it("should deterministically derive master key", async () => {
        const password = "super_secure_password";
        const salt = generateSalt();

        // Fast KDF params for the tests
        const testParams = { m: 1024, t: 1, p: 1 };

        const key1 = await deriveMasterKey(password, salt, testParams);
        const key2 = await deriveMasterKey(password, salt, testParams);

        expect(key1).toEqual(key2);
        expect(key1.length).toBe(32);
    });

    it("hash-wasm Argon2id output matches @noble/hashes (RFC 9106 cross-check)", async () => {
        // Checks that moving from @noble/hashes to hash-wasm does not break the auth keys and
        // master keys already stored for active users.
        const password = "cross-library-compatibility-check";
        const salt = new Uint8Array(16).fill(0xab);
        const params = { m: 1024, t: 1, p: 1 };

        const passwordBytes = new TextEncoder().encode(password);
        const noble = nobleArgon2id(passwordBytes, salt, {
            t: params.t,
            m: params.m,
            p: params.p,
            dkLen: 32,
        });
        const wasm = await deriveMasterKey(password, salt, params);

        expect(wasm).toEqual(noble);
    });

    it("should derive auth and encryption keys from master key", async () => {
        const masterKey = new Uint8Array(32);
        crypto.getRandomValues(masterKey);

        const authKey = deriveAuthKey(masterKey);
        const encKey = deriveEncryptionKey(masterKey);

        expect(authKey.length).toBe(32);
        expect(encKey.length).toBe(32);

        // The keys must differ because the contexts differ
        expect(authKey).not.toEqual(encKey);
        // And they must be deterministic
        expect(deriveAuthKey(masterKey)).toEqual(authKey);
        expect(deriveEncryptionKey(masterKey)).toEqual(encKey);
    });

    it("should successfully encrypt and decrypt a payload", () => {
        const itemKey = generateItemKey();
        const payload = {
            title: "Test note",
            content: { type: "doc" },
            tags: ["test"],
        };

        const { ciphertext, nonce } = encryptPayload(payload, itemKey);
        expect(ciphertext).not.toEqual(new TextEncoder().encode(JSON.stringify(payload)));

        const decrypted = decryptPayload<typeof payload>(ciphertext, nonce, itemKey);
        expect(decrypted).toEqual(payload);
    });

    it("should fail to decrypt payload with wrong key", () => {
        const itemKey = generateItemKey();
        const wrongKey = generateItemKey();
        const payload = { test: 123 };

        const { ciphertext, nonce } = encryptPayload(payload, itemKey);

        expect(() => {
            decryptPayload(ciphertext, nonce, wrongKey);
        }).toThrow();
    });

    it("should successfully encrypt and decrypt an item key", () => {
        const encryptionKey = new Uint8Array(32);
        crypto.getRandomValues(encryptionKey);
        const itemKey = generateItemKey();

        const { ciphertext, nonce } = encryptItemKey(itemKey, encryptionKey);
        const decrypted = decryptItemKey(ciphertext, nonce, encryptionKey);

        expect(decrypted).toEqual(itemKey);
    });
});

describe("File chunk encryption", () => {
    const sampleChunk = () => {
        const bytes = new Uint8Array(4096);
        crypto.getRandomValues(bytes);
        return bytes;
    };

    it("should round-trip a chunk with matching AAD", () => {
        const itemKey = generateItemKey();
        const plaintext = sampleChunk();
        const aad = buildChunkAad("set-123", 0, 3);

        const { ciphertext, nonce } = encryptChunk(plaintext, itemKey, aad);
        expect(ciphertext).not.toEqual(plaintext);
        expect(nonce.length).toBe(24);

        const decrypted = decryptChunk(ciphertext, nonce, itemKey, aad);
        expect(decrypted).toEqual(plaintext);
    });

    it("should generate a fresh random nonce on every call (no reuse)", () => {
        const itemKey = generateItemKey();
        const plaintext = sampleChunk();
        const aad = buildChunkAad("set-123", 0, 1);

        const a = encryptChunk(plaintext, itemKey, aad);
        const b = encryptChunk(plaintext, itemKey, aad);

        // The same key + the same plaintext must NOT yield the same nonce or ciphertext
        expect(a.nonce).not.toEqual(b.nonce);
        expect(a.ciphertext).not.toEqual(b.ciphertext);
    });

    it("should fail to decrypt when the chunk index is wrong (reorder defense)", () => {
        const itemKey = generateItemKey();
        const plaintext = sampleChunk();
        const aadEnc = buildChunkAad("set-123", 0, 3);
        const aadWrongIndex = buildChunkAad("set-123", 1, 3);

        const { ciphertext, nonce } = encryptChunk(plaintext, itemKey, aadEnc);

        expect(() => decryptChunk(ciphertext, nonce, itemKey, aadWrongIndex)).toThrow();
    });

    it("should fail to decrypt when the chunk set id is wrong (cross-set defense)", () => {
        const itemKey = generateItemKey();
        const plaintext = sampleChunk();
        const aadEnc = buildChunkAad("set-123", 0, 3);
        const aadWrongSet = buildChunkAad("set-999", 0, 3);

        const { ciphertext, nonce } = encryptChunk(plaintext, itemKey, aadEnc);

        expect(() => decryptChunk(ciphertext, nonce, itemKey, aadWrongSet)).toThrow();
    });

    it("should fail to decrypt with the wrong item key", () => {
        const itemKey = generateItemKey();
        const wrongKey = generateItemKey();
        const plaintext = sampleChunk();
        const aad = buildChunkAad("set-123", 0, 1);

        const { ciphertext, nonce } = encryptChunk(plaintext, itemKey, aad);

        expect(() => decryptChunk(ciphertext, nonce, wrongKey, aad)).toThrow();
    });
});

describe("KDF params — hostname detection removed", () => {
    it("PRODUCTION_KDF_PARAMS is m=65536, t=3, p=4", () => {
        // Regression check: changing this constant must be a deliberate decision.
        // A production build ALWAYS uses these parameters.
        expect(PRODUCTION_KDF_PARAMS).toEqual({ m: 65536, t: 3, p: 4 });
    });

    it("DEFAULT_KDF_PARAMS uses weaker parameters in a test build (isTestBuild=true)", () => {
        // Vitest sets import.meta.env.MODE='test' and/or NODE_ENV='test' →
        // DEFAULT_KDF_PARAMS must be the weaker set so the tests stay fast.
        // Proof that the test-detection logic works without a hostname check.
        expect(DEFAULT_KDF_PARAMS).toEqual({ m: 1024, t: 1, p: 1 });
        expect(DEFAULT_KDF_PARAMS).not.toEqual(PRODUCTION_KDF_PARAMS);
    });
});

describe("AAD tamper tests (payload AAD = id, item-key AAD = id)", () => {
    const ID_A = "11111111-1111-7111-8111-111111111111";
    const ID_B = "22222222-2222-7222-8222-222222222222";

    it("Test 1 (swap): swapping (encrypted_payload, nonce) between two items → decrypt throws", () => {
        // The server cannot serve the content of note A under id B without decryption failing.
        const ikA = generateItemKey();
        const ikB = generateItemKey();
        const payload = { title: "secret", content: "hello" };

        const aadA = buildPayloadAad(ID_A, 1);
        const aadB = buildPayloadAad(ID_B, 1);

        const encA = encryptPayload(payload, ikA, aadA);
        const encB = encryptPayload(payload, ikB, aadB);

        // A normal decrypt works
        expect(() => decryptPayload(encA.ciphertext, encA.nonce, ikA, aadA)).not.toThrow();
        expect(() => decryptPayload(encB.ciphertext, encB.nonce, ikB, aadB)).not.toThrow();

        // Swap: A's ciphertext decrypted with A's key but under B's AAD → throws
        expect(() => decryptPayload(encA.ciphertext, encA.nonce, ikA, aadB)).toThrow();
        // Swap: B's ciphertext under A's AAD → throws
        expect(() => decryptPayload(encB.ciphertext, encB.nonce, ikB, aadA)).toThrow();
    });

    it("item-key wrap AAD = id only, not version — swapping wrapped keys throws", () => {
        // The server cannot swap a wrapped Item Key between items.
        const vk = generateItemKey(); // simulates the Vault Key
        const ikA = generateItemKey();
        const ikB = generateItemKey();

        const wrappedA = encryptItemKey(ikA, vk, buildItemKeyAad(ID_A));
        const wrappedB = encryptItemKey(ikB, vk, buildItemKeyAad(ID_B));

        // A normal unwrap works
        expect(() =>
            decryptItemKey(wrappedA.ciphertext, wrappedA.nonce, vk, buildItemKeyAad(ID_A)),
        ).not.toThrow();
        expect(() =>
            decryptItemKey(wrappedB.ciphertext, wrappedB.nonce, vk, buildItemKeyAad(ID_B)),
        ).not.toThrow();

        // Swap: A's wrapped key with B's AAD → throws
        expect(() =>
            decryptItemKey(wrappedA.ciphertext, wrappedA.nonce, vk, buildItemKeyAad(ID_B)),
        ).toThrow();
        expect(() =>
            decryptItemKey(wrappedB.ciphertext, wrappedB.nonce, vk, buildItemKeyAad(ID_A)),
        ).toThrow();
    });

    it("re-wrap IK under new itemId AAD (file conflict clone) works; raw key identical", () => {
        const vk = generateItemKey();
        const ik = generateItemKey();
        const wrappedA = encryptItemKey(ik, vk, buildItemKeyAad(ID_A));

        // Simulating CLONE_ITEM_KEY: unwrap A → rewrap B
        const raw = decryptItemKey(wrappedA.ciphertext, wrappedA.nonce, vk, buildItemKeyAad(ID_A));
        const wrappedB = encryptItemKey(raw, vk, buildItemKeyAad(ID_B));
        const rawB = decryptItemKey(wrappedB.ciphertext, wrappedB.nonce, vk, buildItemKeyAad(ID_B));
        expect(Array.from(rawB)).toEqual(Array.from(ik));
        // The old wrap under the new AAD still throws (regression)
        expect(() =>
            decryptItemKey(wrappedA.ciphertext, wrappedA.nonce, vk, buildItemKeyAad(ID_B)),
        ).toThrow();
    });
});

describe("Share cryptography", () => {
    const SHARE_ID = "01900000-0000-7000-8000-000000000001";
    const ITEM_ID = "01900000-0000-7000-8000-000000000002";
    const testParams = { m: 1024, t: 1, p: 1 };

    it("shareLinkKey b64url roundtrips", () => {
        const linkKey = generateShareLinkKey();
        const encoded = shareLinkKeyToB64url(linkKey);
        expect(encoded).not.toContain("+");
        expect(encoded).not.toContain("=");
        expect(shareLinkKeyFromB64url(encoded)).toEqual(linkKey);
    });

    it("deriveShareViewProof is deterministic and 32 bytes", () => {
        const linkKey = generateShareLinkKey();
        const a = deriveShareViewProof(linkKey);
        const b = deriveShareViewProof(linkKey);
        expect(a).toEqual(b);
        expect(a.length).toBe(32);
        expect(shareViewProofToB64(a).length).toBe(44);
        const frag = shareLinkKeyToB64url(linkKey);
        expect(viewProofB64FromFragmentKey(frag)).toBe(shareViewProofToB64(a));
    });

    it("deriveShareKey differs with and without password enc key", () => {
        const linkKey = generateShareLinkKey();
        const encKey = generateItemKey();
        const withoutPwd = deriveShareKey(linkKey);
        const withPwd = deriveShareKey(linkKey, encKey);
        expect(withoutPwd).not.toEqual(withPwd);
    });

    it("wraps and unwraps item key with buildShareWrapAad", () => {
        const linkKey = generateShareLinkKey();
        const shareKey = deriveShareKey(linkKey);
        const itemKey = generateItemKey();
        const wrapped = encryptItemKey(itemKey, shareKey, buildShareWrapAad(SHARE_ID, ITEM_ID));
        const unwrapped = decryptItemKey(
            wrapped.ciphertext,
            wrapped.nonce,
            shareKey,
            buildShareWrapAad(SHARE_ID, ITEM_ID),
        );
        expect(unwrapped).toEqual(itemKey);
    });

    it("AAD mismatch on share wrap throws", () => {
        const linkKey = generateShareLinkKey();
        const shareKey = deriveShareKey(linkKey);
        const itemKey = generateItemKey();
        const wrapped = encryptItemKey(itemKey, shareKey, buildShareWrapAad(SHARE_ID, ITEM_ID));
        expect(() =>
            decryptItemKey(
                wrapped.ciphertext,
                wrapped.nonce,
                shareKey,
                buildShareWrapAad(SHARE_ID, "01900000-0000-7000-8000-000000000099"),
            ),
        ).toThrow();
    });

    it("deriveSharePasswordKeys splits auth and enc keys", async () => {
        const salt = generateSalt();
        const { shareAuthKey, shareEncKey } = await deriveSharePasswordKeys(
            "share-password",
            salt,
            testParams,
        );
        expect(shareAuthKey).not.toEqual(shareEncKey);
        expect(shareAuthKey.length).toBe(32);
        expect(shareEncKey.length).toBe(32);
    });

    it("assertKdfParamsFloor allows test params in test mode", () => {
        expect(() => assertKdfParamsFloor(testParams)).not.toThrow();
    });

    it("kdfParamsBelowFloor rejects params below the production floor", () => {
        expect(kdfParamsBelowFloor({ m: 1024, t: 1, p: 1 })).toBe(true);
        expect(kdfParamsBelowFloor({ m: 65535, t: 3, p: 4 })).toBe(true);
        expect(kdfParamsBelowFloor(PRODUCTION_KDF_PARAMS)).toBe(false);
        expect(kdfParamsBelowFloor({ m: 131072, t: 3, p: 4 })).toBe(false);
    });

    it("password-protected share unwrap uses PRODUCTION_KDF_PARAMS fallback", async () => {
        const linkKey = generateShareLinkKey();
        const itemKey = generateItemKey();
        const pwd = "share-pass-123";
        const salt = generateSalt();
        const params = PRODUCTION_KDF_PARAMS;

        const { shareEncKey } = await deriveSharePasswordKeys(pwd, salt, params);
        const shareKeyWrap = deriveShareKey(linkKey, shareEncKey);
        const wrapped = encryptItemKey(itemKey, shareKeyWrap, buildShareWrapAad(SHARE_ID, ITEM_ID));
        zeroize(shareKeyWrap);
        zeroize(shareEncKey);

        const { shareEncKey: enc2 } = await deriveSharePasswordKeys(pwd, salt, params);
        const shareKeyUnwrap = deriveShareKey(linkKey, enc2);
        const itemKey2 = decryptItemKey(
            wrapped.ciphertext,
            wrapped.nonce,
            shareKeyUnwrap,
            buildShareWrapAad(SHARE_ID, ITEM_ID),
        );
        expect(itemKey2).toEqual(itemKey);

        const shareKeyNoParams = deriveShareKey(linkKey);
        expect(() =>
            decryptItemKey(
                wrapped.ciphertext,
                wrapped.nonce,
                shareKeyNoParams,
                buildShareWrapAad(SHARE_ID, ITEM_ID),
            ),
        ).toThrow();
    });
});

/**
 * Known-answer vectors for the frozen protocol. Every existing vault derives its keys and opens its
 * data with exactly these constructions — the Argon2id call, the HKDF context strings, the AEAD and
 * the AAD each one is bound to. A change here is a protocol break that locks every account out, so
 * NEVER update an expected value to make a test pass; fix the code instead.
 *
 * The values were produced independently of this code, from libsodium (XChaCha20-Poly1305 and
 * Argon2id) and the Python `cryptography` package (HKDF-SHA-256), and this module reproduces them.
 * The ciphertexts come from libsodium too: the encrypt functions draw a fresh random nonce by
 * design, so the vectors are checked in the decrypt direction. Argon2id uses small parameters to
 * keep the test fast; the algorithm and the 32-byte output are what is pinned.
 */
describe("Known-answer vectors — the frozen protocol", () => {
    const hex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
    const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    const range = (from: number, to: number) =>
        Uint8Array.from({ length: to - from }, (_, i) => from + i);

    const PASSWORD = "correct horse battery staple";
    const SALT = range(0xa0, 0xb0);
    const KDF = { m: 1024, t: 2, p: 1 };
    const MASTER = "dc49f8515375c5df165bcefb41825849eda4b4d669183e528c1d637ae3fa0791";
    const AUTH = "a427902cf20fdf2b7ff0a0fc376e0921b11933759ae083bc89541e81596d6ed9";
    const ENC = "b952e711f56eb0b7aa7d4d69737efc7047259f47c25933324858ac0e96fd9ea1";
    const VAULT_KEY = range(0x60, 0x80);
    const ITEM_KEY = range(0x20, 0x40);
    const ITEM_ID = "0190f6a0-0000-7000-8000-00000000000a";
    const CHUNK_SET = "0190f6a0-0000-7000-8000-00000000000b";
    const LINK_KEY = range(0x10, 0x30);

    it("Argon2id derives the Master Key", async () => {
        expect(toHex(await deriveMasterKey(PASSWORD, SALT, KDF))).toBe(MASTER);
    });

    it("HKDF-SHA-256 with zknotes-auth-v1 and zknotes-enc-v1 splits it", () => {
        expect(toHex(deriveAuthKey(hex(MASTER)))).toBe(AUTH);
        expect(toHex(deriveEncryptionKey(hex(MASTER)))).toBe(ENC);
    });

    it("the Encryption Key unwraps the Vault Key (no AAD)", () => {
        const wrapped = hex(
            "2ca997377fd66645c9f72f2939dc6b428edd78c314c1bd4b1d28123278d1ffe94590a7c5a6c033b31bd3134f9ffc1314",
        );
        expect(decryptItemKey(wrapped, range(0xc0, 0xd8), hex(ENC))).toEqual(VAULT_KEY);
    });

    it("the Vault Key unwraps an Item Key bound to the item id", () => {
        const wrapped = hex(
            "8b22ca6eb47ed9e1171320f91c955a1c71de4bdd5d91c880e325d033970c189fe994c623b0a0ddae24b4852d6c91a271",
        );
        const nonce = range(0xe0, 0xf8);
        expect(decryptItemKey(wrapped, nonce, VAULT_KEY, buildItemKeyAad(ITEM_ID))).toEqual(
            ITEM_KEY,
        );
    });

    it("the Item Key opens a JSON payload bound to the item id", () => {
        const ciphertext = hex(
            "410319c0520a98fd4d5ca4568b148c05983bb494b365206f16e2ae41fa5aa766a811638f0ceb8634659e81c84dd4e26bc5dba6a1e8d9933059de897e5bd0d619fcb3ca",
        );
        const payload = decryptPayload(
            ciphertext,
            range(0x40, 0x58),
            ITEM_KEY,
            buildPayloadAad(ITEM_ID, 1),
        );
        expect(payload).toEqual({ title: "Known answer", content: "<p>zknotes</p>" });
    });

    it("the Item Key opens a file chunk bound to chunkSetId:index:total", () => {
        const ciphertext = hex(
            "4a989ef35ab12a893821b51f0f0953ced54bc60a15daf537bcab1bdbd08b0c56851810089f869419bbe40cf6c49fb5049bd329aae097e847a1e5aa9ba15835aaa6c75a3e2c58e0bf5ca1131b6cc2b9e5",
        );
        const aad = buildChunkAad(CHUNK_SET, 3, 7);
        expect(decryptChunk(ciphertext, range(0xc0, 0xd8), ITEM_KEY, aad)).toEqual(range(0, 64));
    });

    it("a share link key derives the share key and the view proof", () => {
        expect(toHex(deriveShareKey(LINK_KEY))).toBe(
            "dbdfef021792913d2ef55eff4298bb56583befbb4ea2c60e8e8319b6dc28c18b",
        );
        expect(toHex(deriveShareViewProof(LINK_KEY))).toBe(
            "1c52cd8a62a6e13a2078ca0d40132edf731f020a1b3140781bd2b4f8f2ef2034",
        );
    });

    it("a share password splits into auth and enc keys, and the enc key joins the share key", async () => {
        const { shareAuthKey, shareEncKey } = await deriveSharePasswordKeys(
            "share password",
            SALT,
            KDF,
        );
        expect(toHex(shareAuthKey)).toBe(
            "615e5354bc1a2a27f1bb0893074e449295583bac4d6236b1a7c718363a1a9711",
        );
        expect(toHex(shareEncKey)).toBe(
            "fe362b7c7aa50b5dceeaa74213290983f16490de70906041462dddffbc77f906",
        );
        expect(toHex(deriveShareKey(LINK_KEY, shareEncKey))).toBe(
            "030961e0b6a93aac5cccc7d2f7f2928fe361539abe78d013849b9049513d684a",
        );
    });
});
