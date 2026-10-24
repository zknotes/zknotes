import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The two "passes on this repository" tests run a gate over the whole of client/src — a few grep
// processes per file — which takes about three seconds here and more on a CI runner. They measure
// that the gate accepts the repository, not how fast it does, so they get a timeout of their own
// instead of vitest's five-second default, which a slow runner crossed.
const WHOLE_REPOSITORY_TIMEOUT_MS = 30_000;

/**
 * The two crypto-boundary gates are only worth having if they fail on the ways around them. Every
 * sample below runs through the real gate functions in a throwaway tree of its own; the bypasses
 * must fail, the legitimate forms must pass, and the repository itself must pass.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GATE = join(ROOT, "scripts/security-gate.sh");
const trees: string[] = [];

afterEach(() => {
    for (const t of trees.splice(0)) rmSync(t, { recursive: true, force: true });
});

/** A minimal tree with the directories the gates require, plus the given files. */
function tree(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "zknotes-gate-"));
    trees.push(root);
    for (const dir of ["client/src/lib/core/workers", "client/src/lib/core/crypto", "shared/src"]) {
        mkdirSync(join(root, dir), { recursive: true });
    }
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }
    return root;
}

function runGate(gate: "security_gate" | "crypto_primitives_gate", root: string): number {
    const res = spawnSync("bash", ["-c", `source "${GATE}" && ${gate}`], {
        env: { ...process.env, ROOT: root },
        encoding: "utf8",
    });
    return res.status ?? -1;
}

describe("crypto_primitives_gate", () => {
    const bypasses: Record<string, string> = {
        "a named import": `import { decryptPayload } from "@zknotes/shared";`,
        "a multi-line named import": `import {\n    normalizeEmail,\n    decryptPayload,\n} from "@zknotes/shared";`,
        "a namespace import": `import * as shared from "@zknotes/shared";\nshared.decryptPayload(a, b);`,
        "a deep path into shared": `import { decryptPayload } from "@zknotes/shared/src/cryptography";`,
        "a re-export": `export { decryptPayload } from "@zknotes/shared";`,
        "a star re-export": `export * from "@zknotes/shared";`,
        "a runtime import of a primitive": `const { decryptPayload } = await import("@zknotes/shared");`,
        "a runtime import of the whole module": `const shared = await import("@zknotes/shared");\nshared.decryptPayload(a, b);`,
        "an inline runtime import": `(await import("@zknotes/shared")).decryptPayload(a, b);`,
        "the cipher library directly": `import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";`,
        "the hash library directly": `import { hkdf } from "@noble/hashes/hkdf.js";`,
        "the Argon2 library directly": `import { argon2id } from "hash-wasm";`,
        "a runtime import() with .then": `return import("@zknotes/shared").then((m) => m.decryptPayload(a, b, c));`,
        "a runtime import() inside Promise.all": `const [shared] = await Promise.all([import("@zknotes/shared"), import("svelte")]);`,
        "a runtime import() assigned later": `let shared: typeof import("@zknotes/shared");\nshared = await import("@zknotes/shared");`,
        "a runtime import() behind a loader": `const loadShared = () => import("@zknotes/shared");`,
        "a template-literal specifier": "const shared = await import(`@zknotes/shared`);",
        "a template-literal library specifier":
            "const m = await import(`@noble/ciphers/chacha.js`);",
        "a relative path into shared": `import { decryptPayload } from "../../../shared/src/cryptography";`,
        "a share-key derivation": `import { deriveSharePasswordKeys } from "@zknotes/shared";`,
    };
    for (const [name, code] of Object.entries(bypasses)) {
        it(`fails on ${name}`, () => {
            expect(runGate("crypto_primitives_gate", tree({ "client/src/lib/x.ts": code }))).toBe(
                1,
            );
        });
    }

    it("fails on a .mts file", () => {
        const root = tree({
            "client/src/lib/x.mts": `import { decryptPayload } from "@zknotes/shared";`,
        });
        expect(runGate("crypto_primitives_gate", root)).toBe(1);
    });

    it("fails when an allowed caller hands a primitive on", () => {
        for (const file of [
            "client/src/lib/core/services/auth-service.ts",
            "client/src/lib/modules/export/backup-crypto.ts",
        ]) {
            const root = tree({ [file]: `export { decryptPayload } from "@zknotes/shared";` });
            expect(runGate("crypto_primitives_gate", root)).toBe(1);
        }
        const worker = tree({
            "client/src/lib/core/workers/crypto.worker.ts": `import { decryptPayload } from "@zknotes/shared";\nexport { decryptPayload };`,
        });
        expect(runGate("crypto_primitives_gate", worker)).toBe(1);
    });

    it("passes ordinary imports from shared and type-only import() expressions", () => {
        const root = tree({
            "client/src/lib/a.ts": `import { normalizeEmail, type KdfParams } from "@zknotes/shared";`,
            "client/src/lib/b.ts": `let k: import("@zknotes/shared").KdfParams | undefined;`,
            "client/src/lib/c.ts": `const { FILE_LIMITS } = await import("@zknotes/shared");`,
        });
        expect(runGate("crypto_primitives_gate", root)).toBe(0);
    });

    it("lets the crypto worker use the primitives and the libraries", () => {
        const root = tree({
            "client/src/lib/core/workers/crypto.worker.ts": `import * as shared from "@zknotes/shared";\nimport { argon2id } from "hash-wasm";`,
        });
        expect(runGate("crypto_primitives_gate", root)).toBe(0);
    });

    it(
        "passes on this repository",
        () => {
            expect(runGate("crypto_primitives_gate", ROOT)).toBe(0);
        },
        WHOLE_REPOSITORY_TIMEOUT_MS,
    );
});

describe("security_gate", () => {
    const inWorker: Record<string, string> = {
        sessionStorage: `sessionStorage.setItem("k", v);`,
        localStorage: `localStorage.getItem("k");`,
        IndexedDB: `indexedDB.open("x");`,
        "the idb wrapper": `import { openDB } from "idb";`,
        "the Cache API": `await caches.open("k");`,
        OPFS: `await navigator.storage.getDirectory();`,
    };
    for (const [name, code] of Object.entries(inWorker)) {
        it(`fails on ${name} inside the crypto worker`, () => {
            const root = tree({ "client/src/lib/core/workers/crypto.worker.ts": code });
            expect(runGate("security_gate", root)).toBe(1);
        });
        it(`fails on ${name} inside lib/core/crypto`, () => {
            const root = tree({ "client/src/lib/core/crypto/keys.ts": code });
            expect(runGate("security_gate", root)).toBe(1);
        });
    }

    it("fails on the vault_key storage key in any quoting, outside session-key.ts", () => {
        for (const literal of [`"vault_key"`, `'vault_key'`, "`vault_key`"]) {
            const root = tree({ "client/src/lib/x.ts": `sessionStorage.getItem(${literal});` });
            expect(runGate("security_gate", root)).toBe(1);
        }
    });

    it("fails on a Cache API call however it is written", () => {
        for (const code of [
            `await caches\n        .open("k")\n        .then((c) => c.put(r, v));`,
            `await self.caches?.open("vk");`,
            `const { caches: store } = self;`,
            `document.cookie = "vk=" + b64;`,
        ]) {
            const root = tree({ "client/src/lib/core/workers/crypto.worker.ts": code });
            expect(runGate("security_gate", root)).toBe(1);
        }
    });

    it("fails on a storage helper imported where the Vault Key lives", () => {
        const worker = tree({
            "client/src/lib/core/workers/crypto.worker.ts": `import { getDB } from "$lib/core/db";\nawait (await getDB()).put("metadata", vk, "k");`,
        });
        expect(runGate("security_gate", worker)).toBe(1);
        const crypto = tree({
            "client/src/lib/core/crypto/keys.ts": `import { savePersisted } from "$lib/core/utils/persisted";`,
        });
        expect(runGate("security_gate", crypto)).toBe(1);
    });

    it("fails when session-key.ts keeps the Vault Key anywhere but sessionStorage", () => {
        const decl = `const VAULT_KEY = "vault_key";\n`;
        for (const body of [
            `localStorage.setItem(VAULT_KEY, base64Key);`,
            `sessionStorage.setItem(VAULT_KEY, k);\nconst db = indexedDB.open("x");`,
        ]) {
            const root = tree({ "client/src/lib/core/crypto/session-key.ts": decl + body });
            expect(runGate("security_gate", root)).toBe(1);
        }
    });

    it("lets session-key.ts keep the Vault Key in sessionStorage and the logout marker in localStorage", () => {
        const root = tree({
            "client/src/lib/core/crypto/session-key.ts": `const VAULT_KEY = "vault_key";\nsessionStorage.setItem(VAULT_KEY, k);\nsessionStorage.removeItem(VAULT_KEY);\nlocalStorage.getItem(SESSION_GEN_KEY);`,
        });
        expect(runGate("security_gate", root)).toBe(0);
    });

    it("exempts only the real session-key.ts, not another file of that name", () => {
        const root = tree({
            "client/src/lib/modules/share/session-key.ts": `sessionStorage.getItem("vault_key");`,
        });
        expect(runGate("security_gate", root)).toBe(1);
    });

    it("fails on storage in a .mts worker file", () => {
        const root = tree({
            "client/src/lib/core/workers/x.worker.mts": `localStorage.getItem("k");`,
        });
        expect(runGate("security_gate", root)).toBe(1);
    });

    it("lets the OPFS staging worker use OPFS", () => {
        const root = tree({
            "client/src/lib/core/workers/opfs-io.worker.ts": `await navigator.storage.getDirectory();`,
            "client/src/lib/core/workers/opfs-io-rpc.ts": `typeof navigator?.storage?.getDirectory;`,
        });
        expect(runGate("security_gate", root)).toBe(0);
    });

    it(
        "passes on this repository",
        () => {
            expect(runGate("security_gate", ROOT)).toBe(0);
        },
        WHOLE_REPOSITORY_TIMEOUT_MS,
    );
});
