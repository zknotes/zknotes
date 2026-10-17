#!/usr/bin/env bash
# The two crypto-boundary gates: ./check.sh runs them (steps 1 and 2), and
# scripts/security-gate.test.ts runs the known ways around them through them.
#
# Source this file with ROOT set to the repository root; it defines functions only:
#
#   security_gate          — the Vault Key must not leak into persistent storage: the
#                            "vault_key" storage-key literal (in any quoting) appears nowhere in
#                            client/src or shared/src except lib/core/crypto/session-key.ts; in that
#                            file every line naming VAULT_KEY also names sessionStorage, and no other
#                            storage API appears; no persistent storage API (sessionStorage,
#                            localStorage, IndexedDB and the idb wrapper, the Cache API, OPFS,
#                            cookies) is touched inside lib/core/workers/ or lib/core/crypto/ —
#                            except by the OPFS staging worker, whose job it is; and the crypto
#                            worker and lib/core/crypto/ do not import the app's storage helpers.
#   crypto_primitives_gate — the shared crypto primitives are imported only inside the crypto
#                            worker and the two allowlisted callers (login derivation, the backup
#                            passphrase), and re-exported by none of them; everything else must go
#                            through the worker RPC. A named import or re-export of a primitive, a
#                            namespace or star import, a deep or relative path into the package, a
#                            runtime import() in any form but a destructuring of other exports, and
#                            the crypto libraries themselves (@noble/ciphers, @noble/hashes,
#                            hash-wasm) all count.
#
# These are text checks: they catch the ordinary ways around the boundary, not a determined one
# (a computed property name, a string built at runtime, a wrapper exported under another name). Both
# fail closed: a missing directory or a grep error is a failure, never a pass.
# scripts/security-gate.test.ts runs each bypass through them.

# Every source extension Vite resolves, plus Svelte components.
_gate_sources() {
    find "$@" \( -name '*.ts' -o -name '*.mts' -o -name '*.cts' -o -name '*.tsx' \
        -o -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.jsx' \
        -o -name '*.svelte' \) -print0
}

security_gate() {
    local client_src="${ROOT}/client/src"
    local shared_src="${ROOT}/shared/src"
    local workers="${ROOT}/client/src/lib/core/workers"
    local crypto="${ROOT}/client/src/lib/core/crypto"
    local session_key="client/src/lib/core/crypto/session-key.ts"

    local dir
    for dir in "$client_src" "$shared_src" "$workers" "$crypto"; do
        if [[ ! -d "$dir" ]]; then
            echo "Security gate: missing directory $dir" >&2
            return 1
        fi
    done

    local q="[\"'\`]"
    local sp="[[:space:]]"
    # Quoted storage-key literal only — comments / encrypted_vault_key / vault_key_nonce must not trip this.
    local vault_literal="${q}vault_key${q}"
    # Storage APIs. Matched on the whole file flattened to one line, so a call Biome wraps across
    # lines (`caches\n    .open(…)`) is still one match.
    local storage="sessionStorage|localStorage|indexedDB|openDB|cookieStore|document$sp*\\.$sp*cookie"
    storage+="|from$sp*${q}idb${q}|caches$sp*\\??\\.|caches$sp*\\[|\\{[^}]*\\bcaches\\b[^}]*\\}$sp*=|getDirectory"
    # The app's own storage helpers, which the Vault Key's home must not import either.
    local helpers="from$sp*${q}[^\"'\`]*(core/db|/db|utils/persisted|/persisted)(/index)?(\\.ts)?${q}"

    local fail=0
    local file rel flat
    while IFS= read -r -d '' file; do
        rel="${file#"$ROOT"/}"
        case "$rel" in
            *.test.ts|*.spec.ts|*.testkit.ts) continue ;;
        esac
        flat="$(tr '\n' ' ' < "$file")"

        if [[ "$rel" != "$session_key" ]] && grep -Eq "$vault_literal" <<<"$flat"; then
            echo "Security gate: the vault_key storage key outside $session_key, in $rel" >&2
            fail=1
        fi

        case "$rel" in
            client/src/lib/core/workers/* | client/src/lib/core/crypto/*) ;;
            *) continue ;;
        esac
        case "$rel" in
            "$session_key")
                # The one file that keeps the Vault Key: every line that names it also names
                # sessionStorage (localStorage holds only the logout generation marker here), and
                # no other storage API appears at all.
                local stray
                stray="$(grep -nE '\bVAULT_KEY\b' "$file" | grep -v 'sessionStorage' \
                    | grep -vE 'const VAULT_KEY = "vault_key";' || true)"
                if [[ -n "$stray" ]]; then
                    echo "Security gate: VAULT_KEY outside sessionStorage in $rel:" >&2
                    echo "$stray" >&2
                    fail=1
                fi
                if grep -Eq "indexedDB|openDB|cookieStore|document$sp*\\.$sp*cookie|caches$sp*\\??\\.|getDirectory|from$sp*${q}idb${q}" <<<"$flat"; then
                    echo "Security gate: a persistent storage API in $rel" >&2
                    fail=1
                fi
                continue
                ;;
            client/src/lib/core/workers/opfs-io.worker.ts | client/src/lib/core/workers/opfs-io-rpc.ts)
                continue
                ;;
        esac
        if grep -Eq "$storage" <<<"$flat"; then
            echo "Security gate: a persistent storage API in workers/crypto: $rel" >&2
            fail=1
        fi
        case "$rel" in
            client/src/lib/core/workers/crypto.worker.ts | client/src/lib/core/crypto/*)
                if grep -Eq "$helpers" <<<"$flat"; then
                    echo "Security gate: a storage helper imported where the Vault Key lives: $rel" >&2
                    fail=1
                fi
                ;;
        esac
    done < <(_gate_sources "$client_src" "$shared_src")

    return "$fail"
}

crypto_primitives_gate() {
    local src="${ROOT}/client/src"
    if [[ ! -d "$src" ]]; then
        echo "Crypto primitives gate: missing directory $src" >&2
        return 1
    fi

    local prims='decryptPayload|encryptPayload|decryptItemKey|encryptItemKey|decryptChunk|encryptChunk'
    prims+='|deriveMasterKey|deriveAuthKey|deriveEncryptionKey|generateItemKey|generateShareLinkKey'
    prims+='|deriveShareKey|deriveSharePasswordKeys|deriveShareViewProof'
    local q="[\"'\`]"
    local sp="[[:space:]]"
    local pkg="${q}@zknotes/shared${q}"
    # Ways to reach the primitives without naming the worker RPC:
    local named_import="import$sp+(type$sp+)?\\{[^}]*\\b($prims)\\b[^}]*\\}$sp+from$sp+$pkg"
    local reexport="export$sp*(type$sp+)?\\{[^}]*\\b($prims)\\b[^}]*\\}"
    local star="(import|export)$sp+\\*($sp+as$sp+[A-Za-z_\\$][A-Za-z0-9_\\$]*)?$sp+from$sp+$pkg"
    local deep="${q}@zknotes/shared/|${q}(\\.\\./)+shared/"
    # A runtime import() of the package. Two forms are allowed, and every other one counts: the
    # type-level `import("@zknotes/shared").SomeType` after a `:`, `<`, `|`, `&` or `typeof`, and a
    # destructuring of exports that are not primitives (`const { FILE_LIMITS } = await import(…)`).
    local dyn="import\\($sp*$pkg$sp*\\)"
    local dyn_type="([:<|&]|typeof)$sp*$dyn\\.[A-Z]"
    local dyn_destructure="\\{[^}]*\\}$sp*=$sp*await$sp+$dyn"
    local dyn_primitive="\\{[^}]*\\b($prims)\\b[^}]*\\}$sp*=$sp*await$sp+$dyn"
    # ...and the libraries they are built on, which only the crypto worker may load.
    local libs="${q}(@noble/ciphers|@noble/hashes|hash-wasm)(/[^\"'\`]*)?${q}"
    local fail=0
    local file rel flat all allowed
    while IFS= read -r -d '' file; do
        rel="${file#"$ROOT"/}"
        case "$rel" in
            *.test.ts|*.spec.ts|*.testkit.ts) continue ;;
        esac
        flat="$(tr '\n' ' ' < "$file")"
        # Not even the files allowed to use a primitive may hand it on.
        if grep -Eq "$reexport" <<<"$flat"; then
            echo "Crypto primitives gate: a shared primitive re-exported from $rel" >&2
            fail=1
        fi
        case "$rel" in
            client/src/lib/core/workers/crypto.worker.ts) continue ;;
        esac
        if grep -Eq "$libs" <<<"$flat"; then
            echo "Crypto primitives gate: a crypto library imported off the worker in $rel" >&2
            fail=1
        fi
        case "$rel" in
            client/src/lib/core/services/auth-service.ts) continue ;;
            client/src/lib/modules/export/backup-crypto.ts) continue ;;
        esac
        if grep -Eq "$named_import|$star|$deep|$dyn_primitive" <<<"$flat"; then
            echo "Crypto primitives gate: off-worker access to the shared primitives in $rel" >&2
            fail=1
        fi
        all="$(grep -oE "$dyn" <<<"$flat" | wc -l)"
        allowed="$(( $(grep -oE "$dyn_type" <<<"$flat" | wc -l) + $(grep -oE "$dyn_destructure" <<<"$flat" | wc -l) ))"
        if (( all > allowed )); then
            echo "Crypto primitives gate: a runtime import() of the shared package in $rel" >&2
            fail=1
        fi
    done < <(_gate_sources "$src")

    return "$fail"
}
