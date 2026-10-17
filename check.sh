#!/usr/bin/env bash
# Run with: ./check.sh
# Every code check (9 steps): security gate, crypto-primitives gate, Biome, tsc (server), tsc (shared),
# svelte-check, Button UX, Form UX, clean build
#
# This script does not run tests — use ./test.sh, or `bun run test` inside client/. Do not run a bare
# `bun test` there: it invokes Bun's own test runner instead of vitest, and the client's tests
# (vi.useFakeTimers/advanceTimersByTimeAsync) can hang forever under it instead of failing fast.

set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

FAIL=0
TOTAL=0
ERRORS=()

run_step() {
    local name="$1"
    shift
    ((TOTAL++)) || true
    echo -e "\n${CYAN}${BOLD}▶ ${name}${NC}"
    if "$@"; then
        echo -e "${GREEN}✓ ${name} — OK${NC}"
    else
        echo -e "${RED}✗ ${name} — FAILED${NC}"
        ((FAIL++)) || true
        ERRORS+=("$name")
    fi
}

echo -e "${BOLD}═══════════════════════════════════════${NC}"
echo -e "${BOLD}  ZKnotes — Code Quality Check${NC}"
echo -e "${BOLD}═══════════════════════════════════════${NC}"

# A prerequisite, not a step: the server depends on shared through `file:../shared`, which Bun installs
# as a hard-linked copy. A new file, or one saved by replacing it (a git checkout, an editor's safe
# write), does not reach that copy until the next install, and the gate would check a shared the server
# does not run. --frozen-lockfile refreshes the copy and never rewrites bun.lock.
echo -e "\n${CYAN}${BOLD}▶ Refreshing the server's copy of shared (bun install --frozen-lockfile)...${NC}"
if ! (cd "${ROOT}" && bun install --frozen-lockfile); then
    echo -e "${RED}${BOLD}ERROR: bun install --frozen-lockfile failed — is bun.lock current? (Offline, the Bun cache has to hold every package.)${NC}"
    exit 1
fi

# The two crypto-boundary gates live in a file of their own, so scripts/security-gate.test.ts can run
# the very same functions against the known ways around them.
# shellcheck source=scripts/security-gate.sh
source "${ROOT}/scripts/security-gate.sh"

# 1. Security gate — the Vault Key must not reach persistent storage from the workers or crypto code
run_step "Security gate (no storage API in workers)" security_gate

# 1b. Crypto primitives must stay inside the worker (allowlisted exceptions only)
run_step "Crypto primitives off-worker gate" crypto_primitives_gate

# 2. Biome — formatting (a safe --write) + linting (a check only, no auto-fix)
#    Do NOT use `biome check --write --unsafe` — the unsafe fixes delete Svelte imports and rename
#    variables Biome cannot see in the <template> (loading → _loading, for instance).
run_step "Biome format & lint" bash -c \
    "cd '${ROOT}' && bunx biome format --write . && bunx biome lint ."

# 3. TypeScript — the API (the shared package is covered because the API imports it)
# `server/tsconfig.json` has no `include`, so tsc looks only at `server/` — which is why these are two
# steps. While they were one (named "server + shared"), `shared/` was typed NOWHERE except
# transitively through the client's svelte-check, which does not look at its tests.
run_step "tsc — server" bash -c \
    "cd '${ROOT}' && bunx tsc --noEmit -p server/tsconfig.json"

# The crypto primitives. It covers the `*.test.ts` files in the package too — a dead import in a test
# once survived a schema move precisely because this step did not exist.
run_step "tsc — shared" bash -c \
    "cd '${ROOT}' && bunx tsc --noEmit -p shared/tsconfig.json"

# 4. svelte-check — the web client (it covers the shared package imported from the web too)
run_step "svelte-check — client" bash -c \
    "cd '${ROOT}/client' && bunx svelte-kit sync && bunx svelte-check --tsconfig ./tsconfig.json"




# 5. Button UX gate — <Button> / DialogActions instead of a bare <button>
run_step "Button UX gate" bash "${ROOT}/scripts/check-button-ux.sh"

# 6. Form UX gate — the canonical classes on <input>/<select>/<textarea>
run_step "Form UX gate" bun run "${ROOT}/scripts/check-form-ux.ts"

# 7. Clean build gate — the public repository has to build ON ITS OWN. A static check of the
#    graph; alongside it, CI builds the client in a clean container, which catches what a manifest
#    does not admit to.
run_step "Clean build gate" bun run "${ROOT}/scripts/check-clean-build.ts"

# TOTAL counts the `run_step` calls itself. It used to be hardcoded and showed 6/6 after the steps had
# become seven — a counter that does not follow reality hides exactly the step just added.
PASS=$((TOTAL - FAIL))

echo -e "\n${BOLD}═══════════════════════════════════════${NC}"
if [[ $FAIL -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}  All checks passed ✓ (${PASS}/${TOTAL})${NC}"
else
    echo -e "${RED}${BOLD}  ${FAIL} check(s) failed (${PASS}/${TOTAL} OK)${NC}"
    for e in "${ERRORS[@]}"; do
        echo -e "${RED}    • ${e}${NC}"
    done
fi
echo -e "${BOLD}═══════════════════════════════════════${NC}"

exit $FAIL
