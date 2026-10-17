# @zknotes/shared

Code **imported on both client and server**: Zod schemas, crypto primitives
(`@noble/ciphers`, `hash-wasm`, `@noble/hashes`), and folder cycle detection.

> ⚠️ Keep this package **dependency-light** and isomorphic — no Node-only (`node:fs`, …) or
> browser-only (`window`, `localStorage`, …) APIs. Anything here runs in both environments.

Key modules (`src/`):

- `cryptography.ts` — `deriveMasterKey` (hash-wasm Argon2id), `deriveAuthKey`, `deriveEncryptionKey`,
  `encryptPayload`, `encryptItemKey`, `decrypt*`, `zeroize`. The `-v1` HKDF context strings guard
  against future KDF collisions — don't change them casually.
- `cycle-detection.ts` — `createsCycle(id, newParentId, parentMap)`, shared by client and server.
  Any endpoint that moves folders must call it.
- Zod schemas — the single source of truth for wire/DB shapes used on both sides.

```bash
bun run test                                         # vitest — crypto & cycle detection
bunx vitest run src/cryptography.test.ts             # single file
bunx vitest run -t "decryptPayload"                  # single test by name
```

## Key hierarchy

```
Password → Argon2id → Master Key                  (never stored, never sent)
  ├─ HKDF-SHA256 "zknotes-auth-v1" → Auth Key      (sent to the server for login; it stores only an
  │                                                 Argon2id hash of it)
  └─ HKDF-SHA256 "zknotes-enc-v1"  → Encryption Key (unwraps the Vault Key, then zeroized)
Vault Key   (random 32 bytes, stored on the server wrapped by the Encryption Key)
  └─ wraps each Item Key (random 32 bytes, one per item)
       └─ XChaCha20-Poly1305(payload, Item Key)
```

`deriveMasterKey`, `deriveAuthKey` and `deriveEncryptionKey` implement the first part;
`encryptItemKey` / `decryptItemKey` wrap both the Vault Key and the Item Keys; `encryptPayload` /
`decryptPayload` encrypt the item itself. The HKDF context strings are protocol constants — changing
one makes every existing account undecryptable.

> Conventions and commands are in the [repository README](../README.md).
