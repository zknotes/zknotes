import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { argon2id } from "hash-wasm";

export interface KdfParams {
    m: number; // memory cost (KiB)
    t: number; // iterations
    p: number; // parallelism
}

/** Plain copy — Svelte $state proxies do not survive structured clone through worker postMessage. */
export function toPlainKdfParams(params: KdfParams): KdfParams {
    return { m: params.m, t: params.t, p: params.p };
}

// KDF strength is chosen SOLELY from a build-time signal — never from a runtime hostname.
//
// Browser/Vitest: Vite writes import.meta.env.MODE at compile time;
//   "test"        → Vitest tests
//   "development" → local dev server (uses PRODUCTION parameters — the correct security posture)
//   "production"  → production bundle (always production parameters)
//
// Server/Bun: process.env.NODE_ENV is set by deployment scripts and test runners;
//   "test"         → bun test / API tests
//   anything else  → production posture
const isBuildTestMode =
    typeof (import.meta as any).env?.MODE === "string" && (import.meta as any).env.MODE === "test";
// `process` is typed LOCALLY instead of by pulling in Node's types: this package also goes into
// the client bundle, so `@types/node` here would mean browser-unsafe APIs suddenly type as
// available. This keeps the typecheck possible without that cost, and the runtime guard unchanged.
const nodeEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.NODE_ENV;
const isNodeTest = nodeEnv === "test";

/**
 * Production KDF parameters — the only authorised set for a real user vault.
 *
 * `/auth/kdf-params` answers an unknown address with these, so a real answer and a fake one look
 * alike only while every vault uses them. Raising them for new vaults alone would make each older
 * vault, still on the previous set, recognisable as an existing account. A raise has to move the
 * existing vaults and the fake answers together (re-deriving at the next sign-in, for instance).
 * The server test "kdf-params returns the same params for existing and unknown emails" guards it.
 */
export const PRODUCTION_KDF_PARAMS: KdfParams = { m: 65536, t: 3, p: 4 };

export const DEFAULT_KDF_PARAMS: KdfParams =
    isBuildTestMode || isNodeTest ? { m: 1024, t: 1, p: 1 } : PRODUCTION_KDF_PARAMS;

/**
 * Zeros out a Uint8Array in memory.
 * Note: JavaScript doesn't guarantee true memory zeroization due to garbage collection
 * and copy-on-write, but this limits the window where secrets are available.
 */
export function zeroize(buffer: Uint8Array): void {
    if (buffer) {
        buffer.fill(0);
    }
}

/**
 * Wrapper around WebCrypto getRandomValues.
 */
function randomBytes(length: number): Uint8Array {
    const arr = new Uint8Array(length);
    crypto.getRandomValues(arr);
    return arr;
}

export async function deriveMasterKey(
    password: string,
    salt: Uint8Array,
    params: KdfParams,
): Promise<Uint8Array> {
    const passwordBytes = new TextEncoder().encode(password);

    const masterKey = await argon2id({
        password: passwordBytes,
        salt,
        iterations: params.t,
        memorySize: params.m,
        parallelism: params.p,
        hashLength: 32,
        outputType: "binary",
    });

    zeroize(passwordBytes);
    return masterKey;
}

export function deriveAuthKey(masterKey: Uint8Array): Uint8Array {
    const context = new TextEncoder().encode("zknotes-auth-v1");
    // HKDF-SHA256
    return hkdf(sha256, masterKey, undefined, context, 32);
}

export function deriveEncryptionKey(masterKey: Uint8Array): Uint8Array {
    const context = new TextEncoder().encode("zknotes-enc-v1");
    return hkdf(sha256, masterKey, undefined, context, 32);
}

export function generateItemKey(): Uint8Array {
    return randomBytes(32);
}

/** 32B random link key — goes into the URL fragment (#k=...), NEVER to the server. */
export function generateShareLinkKey(): Uint8Array {
    return randomBytes(32);
}

/** base64url → 32B link key (browser/worker). */
export function shareLinkKeyFromB64url(fragmentKeyB64url: string): Uint8Array {
    let b64 = fragmentKeyB64url.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    const binary = atob(b64);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** 32B link key → base64url for the URL fragment. */
export function shareLinkKeyToB64url(linkKey: Uint8Array): string {
    let binary = "";
    for (const b of linkKey) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Share Key for wrapping an existing Item Key (of a note and of every attached file).
 * The password is an ADDITIONAL input, not a replacement.
 */
export function deriveShareKey(linkKey: Uint8Array, passwordEncKey?: Uint8Array): Uint8Array {
    let ikm: Uint8Array;
    if (passwordEncKey) {
        ikm = new Uint8Array(linkKey.length + passwordEncKey.length);
        ikm.set(linkKey, 0);
        ikm.set(passwordEncKey, linkKey.length);
    } else {
        ikm = linkKey;
    }
    const context = new TextEncoder().encode("zknotes-share-key-v1");
    const shareKey = hkdf(sha256, ikm, undefined, context, 32);
    if (passwordEncKey) zeroize(ikm);
    return shareKey;
}

/**
 * Share password → Argon2id → master → HKDF split (the same pattern as the vault Auth/Encryption split).
 */
export async function deriveSharePasswordKeys(
    password: string,
    salt: Uint8Array,
    params: KdfParams,
): Promise<{ shareAuthKey: Uint8Array; shareEncKey: Uint8Array }> {
    const masterKey = await deriveMasterKey(password, salt, params);
    const authContext = new TextEncoder().encode("zknotes-share-auth-v1");
    const encContext = new TextEncoder().encode("zknotes-share-enc-v1");
    const shareAuthKey = hkdf(sha256, masterKey, undefined, authContext, 32);
    const shareEncKey = hkdf(sha256, masterKey, undefined, encContext, 32);
    zeroize(masterKey);
    return { shareAuthKey, shareEncKey };
}

/** AAD for the wrapped Item Key inside a share — anti-swap between share/item pairs. */
export function buildShareWrapAad(shareId: string, itemId: string): Uint8Array {
    return new TextEncoder().encode(`zknotes-share-wrap-v1|${shareId}|${itemId}`);
}

/**
 * Proof of possession of the fragment link key for POST /shares/:id/view (anti-burn without the key).
 * The server stores only the SHA-256 hash of this proof; the link key itself never goes on the wire.
 */
export function deriveShareViewProof(linkKey: Uint8Array): Uint8Array {
    const context = new TextEncoder().encode("zknotes-share-view-proof-v1");
    return hkdf(sha256, linkKey, undefined, context, 32);
}

/** 32B view proof → standard base64 (44 characters, padded) for the create/view body. */
export function shareViewProofToB64(proof: Uint8Array): string {
    let binary = "";
    for (const b of proof) binary += String.fromCharCode(b);
    return btoa(binary);
}

/** base64 view proof → 32B (browser/worker). */
export function shareViewProofFromB64(b64: string): Uint8Array {
    const binary = atob(b64);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** Derive the wire `view_proof` from the fragment base64url key (create + view). */
export function viewProofB64FromFragmentKey(fragmentKeyB64url: string): string {
    const linkKey = shareLinkKeyFromB64url(fragmentKeyB64url);
    const proof = deriveShareViewProof(linkKey);
    const b64 = shareViewProofToB64(proof);
    zeroize(linkKey);
    zeroize(proof);
    return b64;
}

/** Maximum memory in KiB allowed for untrusted backup headers (256 MiB). Anti-DoS cap. */
export const MAX_KDF_MEMORY_KIB = 262144;

/** Pure check: true when the parameters are weaker than the floor (default: PRODUCTION_KDF_PARAMS). */
export function kdfParamsBelowFloor(
    params: KdfParams,
    floor: KdfParams = PRODUCTION_KDF_PARAMS,
): boolean {
    return params.m < floor.m || params.t < floor.t || params.p < floor.p;
}

/** Rejects KDF parameters weaker than the production floor (test mode is exempt). */
export function assertKdfParamsFloor(params: KdfParams): void {
    if (isBuildTestMode || isNodeTest) return;
    if (kdfParamsBelowFloor(params, PRODUCTION_KDF_PARAMS)) {
        throw new Error("weak_kdf_params");
    }
}

export function generateNonce(): Uint8Array {
    // 24 bytes for XChaCha20
    return randomBytes(24);
}

export function generateSalt(): Uint8Array {
    // 16 bytes for the Argon2 salt
    return randomBytes(16);
}

export function encryptPayload(
    payload: object,
    itemKey: Uint8Array,
    aad?: Uint8Array,
): { ciphertext: Uint8Array; nonce: Uint8Array } {
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    const nonce = generateNonce();

    const cipher = xchacha20poly1305(itemKey, nonce, aad);
    const ciphertext = cipher.encrypt(payloadBytes);

    zeroize(payloadBytes);
    return { ciphertext, nonce };
}

export function decryptPayload<T>(
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    itemKey: Uint8Array,
    aad?: Uint8Array,
): T {
    const cipher = xchacha20poly1305(itemKey, nonce, aad);
    const plaintextBytes = cipher.decrypt(ciphertext);
    const plaintext = new TextDecoder().decode(plaintextBytes);

    const parsed = JSON.parse(plaintext) as T;
    zeroize(plaintextBytes);
    return parsed;
}

// Convention: the same functions wrap both Item Keys and the Vault Key.
// VK wrap: encryptItemKey(vaultKey, encryptionKey) → { ciphertext, nonce } → sent to the server.
// VK unwrap: decryptItemKey(ciphertext, nonce, encryptionKey) → vaultKey (used for IK operations).
export function encryptItemKey(
    itemKey: Uint8Array,
    encryptionKey: Uint8Array,
    aad?: Uint8Array,
): { ciphertext: Uint8Array; nonce: Uint8Array } {
    const nonce = generateNonce();
    const cipher = xchacha20poly1305(encryptionKey, nonce, aad);
    const ciphertext = cipher.encrypt(itemKey);
    return { ciphertext, nonce };
}

export function decryptItemKey(
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    encryptionKey: Uint8Array,
    aad?: Uint8Array,
): Uint8Array {
    const cipher = xchacha20poly1305(encryptionKey, nonce, aad);
    return cipher.decrypt(ciphertext);
}

/**
 * Builds AAD for an item payload: `<itemId>`.
 *
 * Binding the id prevents swap attacks (server cannot serve item A's ciphertext under item B's id).
 * NOTE: version is NOT included because the server controls version bumping — binding `id|version`
 * would cause tag failure after every push (server returns version N+1 but ciphertext was encrypted
 * with version N's AAD). Per-item rollback protection uses the sync engine's no-downgrade rule
 * (serverItem.version > local.version) as the second layer.
 * The caller MUST use locally-held id, never server-supplied fields directly.
 * Acknowledged limits: reparent, whole-vault rollback, fresh-device rollback.
 */
export function buildPayloadAad(itemId: string, _version: number): Uint8Array {
    return new TextEncoder().encode(itemId);
}

/**
 * Builds AAD for an item key wrap: `<itemId>` only — no version.
 *
 * Item Key is stable across versions; binding version would force re-wrap on every update.
 * Only the id is bound to prevent swapping wrapped keys between items.
 */
export function buildItemKeyAad(itemId: string): Uint8Array {
    return new TextEncoder().encode(itemId);
}

/**
 * Builds the Associated Data (AAD) that binds a file chunk to its position.
 * Format: `<chunkSetId>:<chunkIndex>:<totalChunks>`.
 *
 * AAD is authenticated but NOT encrypted. Binding the chunk's position prevents a
 * malicious server from reordering or truncating chunks: a chunk served at the wrong
 * index makes the Poly1305 tag fail. We bind `chunkSetId` (NOT item_id) because conflict
 * copies share the same immutable chunk set under different item ids.
 */
export function buildChunkAad(
    chunkSetId: string,
    chunkIndex: number,
    totalChunks: number,
): Uint8Array {
    return new TextEncoder().encode(`${chunkSetId}:${chunkIndex}:${totalChunks}`);
}

/**
 * Encrypts a single file chunk with the Item Key and position-binding AAD.
 *
 * Operates on raw bytes (unlike `encryptPayload`, which JSON-encodes). The nonce is
 * generated here on purpose: the Item Key is shared across all chunks of a file (and across
 * a Replace, which re-encrypts new content under the same key), so a fresh 24-byte random
 * nonce per chunk is mandatory — reusing/hardcoding a nonce would break confidentiality.
 * The caller MUST NOT be able to supply the nonce for encryption.
 */
export function encryptChunk(
    plaintext: Uint8Array,
    itemKey: Uint8Array,
    aad: Uint8Array,
): { ciphertext: Uint8Array; nonce: Uint8Array } {
    const nonce = generateNonce();
    const cipher = xchacha20poly1305(itemKey, nonce, aad);
    const ciphertext = cipher.encrypt(plaintext);
    return { ciphertext, nonce };
}

/**
 * Decrypts a single file chunk. `aad` must be rebuilt with `buildChunkAad` from the
 * authenticated manifest values (chunkSetId from the decrypted payload),
 * not from any server-supplied plaintext. A mismatch throws (Poly1305 verification fails).
 */
export function decryptChunk(
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    itemKey: Uint8Array,
    aad: Uint8Array,
): Uint8Array {
    const cipher = xchacha20poly1305(itemKey, nonce, aad);
    return cipher.decrypt(ciphertext);
}

/**
 * Generates deterministic fake KDF metadata for anti-enumeration.
 * Returns a 16-byte fake salt and PRODUCTION KDF params (never DEFAULT_*,
 * which weakens in test builds and would create an existence oracle).
 */
export function generateDeterministicFakeKdfMetadata(
    email: string,
    fakeSeed: string,
): { salt: Uint8Array; params: KdfParams } {
    const seedBytes = new TextEncoder().encode(fakeSeed);
    const emailBytes = new TextEncoder().encode(email);
    // HMAC-SHA256 deterministically generates a 16-byte fake salt
    const salt = hmac(sha256, seedBytes, emailBytes).slice(0, 16);

    return {
        salt,
        // Always production params — DEFAULT_KDF_PARAMS drops to weak values in a test build,
        // which would create a binary "does this account exist" oracle once the two diverge.
        params: PRODUCTION_KDF_PARAMS,
    };
}
