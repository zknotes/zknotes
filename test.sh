#!/usr/bin/env bash
# Running the tests — ZKnotes
#
#   ./test.sh                  The default gate: api + unit + integration (~15s, no E2E)
#   ./test.sh --e2e            + a fast E2E smoke (no heavy specs, no PWA build)
#   ./test.sh --e2e-full       + every E2E (chromium + pwa) — before a merge, and for CI parity
#   ./test.sh --noe2e          Explicitly without E2E (the same as the default)
#   ./test.sh unit               shared + web unit (no docker)
#   ./test.sh integration        The web integration layer (fake-indexeddb, no docker)
#   ./test.sh api                The API's bun test (docker required)
#   ./test.sh e2e <name>         One targeted Playwright spec (docker required)
#   ./test.sh --last-failed      Re-run the last failures: the vitest files and Playwright tests that
#                                failed on their last run (the API's bun test always runs whole)
#
# Examples:
#   ./test.sh                    # often, while working
#   ./test.sh --e2e-full         # the full gate before a PR
#   ./test.sh e2e 17-offline-pwa

set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

FAIL=0
ERRORS=()
TOTAL=0
SKIPPED=()

MODE="all"
# E2E: 0=skip (the default), 1=a fast smoke, 2=full (chromium + pwa, the heavy specs included)
E2E_MODE=0
LAST_FAILED=0
E2E_TARGET=""

# The heavy/slow E2E specs — excluded from --e2e; --e2e-full runs everything.
# The executable list lives here (the runner has to know which files to skip).
E2E_HEAVY_SPECS=(
    "04-files-in-notes.spec.ts"
    "05-offline-sync.spec.ts"
    "07-history.spec.ts"
    # 08-export.spec.ts — a thin smoke (a note+file backup round trip); the matrix lives in the integration test
    "10-account.spec.ts"
    "12-files-upload.spec.ts"
    "14-files-edit.spec.ts"
    "15-files-undo.spec.ts"
    "17-offline-pwa.spec.ts"
    "19-share-link-attachments.spec.ts"
    "24-live-sync-flash.spec.ts"
    "27-multi-tab.spec.ts"
    "33-backup-restore-lifecycle.spec.ts"
)

usage() {
    cat <<EOF
Usage: ./test.sh [command] [options]

Commands:
  (default)       api + unit + integration (no E2E — fast dev gate)
  unit            Shared + web unit tests (no docker)
  integration     Web integration tests — fake-indexeddb (no docker)
  api             API tests — bun test (requires docker)
  e2e <name>      Run a specific E2E spec by name fragment (requires docker)

Options:
  --e2e           Add fast E2E smoke (excludes heavy/slow specs, no PWA build)
  --e2e-full      Add all E2E including heavy specs + PWA project (pre-merge/CI)
  --noe2e         Skip E2E (same as default)
  --last-failed   Re-run only what failed last time: Vitest per file (a layer with no
                  recorded failure is skipped), Playwright per test; the API always runs whole
  -h, --help      Show this help

Examples:
  ./test.sh
  ./test.sh --e2e
  ./test.sh --e2e-full
  ./test.sh e2e 23-conflict-inbox
EOF
}

# Parsing the arguments
ARGS=("$@")
i=0
while ((i < ${#ARGS[@]})); do
    arg="${ARGS[$i]}"
    case "$arg" in
        -h|--help)
            usage
            exit 0
            ;;
        --noe2e)
            E2E_MODE=0
            ;;
        --e2e-full)
            E2E_MODE=2
            ;;
        --e2e)
            E2E_MODE=1
            ;;
        --last-failed)
            LAST_FAILED=1
            ;;
        unit|api|integration)
            MODE="$arg"
            ;;
        e2e)
            MODE="e2e"
            ((i++)) || true
            if ((i >= ${#ARGS[@]})); then
                echo -e "${RED}ERROR: e2e needs a spec name (e.g. ./test.sh e2e 23-conflict-inbox)${NC}" >&2
                exit 1
            fi
            E2E_TARGET="${ARGS[$i]}"
            ;;
        *)
            echo -e "${RED}ERROR: Unknown argument: ${arg}${NC}" >&2
            usage >&2
            exit 1
            ;;
    esac
    ((i++)) || true
done

run_step() {
    local name="$1"
    shift
    echo -e "\n${CYAN}${BOLD}▶ ${name}${NC}"
    TOTAL=$((TOTAL + 1))
    if "$@"; then
        echo -e "${GREEN}✓ ${name} — OK${NC}"
    else
        echo -e "${RED}✗ ${name} — FAILED${NC}"
        ((FAIL++)) || true
        ERRORS+=("$name")
    fi
}

# The body of a vitest step: an optional note under the step's header, then the command in <dir>.
vitest_in() {
    local dir="$1" note="$2"
    shift 2
    [[ -n "$note" ]] && echo -e "  ${CYAN}${note}${NC}"
    (cd "$dir" && "$@")
}

# One vitest layer: run_vitest_step <name> <dir> <project> <scope> <vitest...>
#   <project>  the vitest project ("" for a config without projects)
#   <scope>    the path filter a normal run passes ("" for none)
#
# --last-failed: Vitest 4 has no such option — passing it through killed every vitest step with
# `CACError: Unknown option --lastFailed`. What vitest does keep is a results cache recording, per
# test file, whether it failed on its last run; scripts/vitest-last-failed.ts reads it, and the
# failed files replace <scope>. A layer with no recorded failure is skipped, and says so; a layer
# with no readable cache runs whole rather than being guessed at.
run_vitest_step() {
    local name="$1" dir="$2" project="$3" scope="$4"
    shift 4
    local -a cmd=("$@" run)
    [[ -n "$project" ]] && cmd+=(--project "$project")
    local -a targets=()
    [[ -n "$scope" ]] && targets+=("$scope")
    local note=""
    if ((LAST_FAILED == 1)); then
        local listed line
        if listed=$(bun run "${ROOT}/scripts/vitest-last-failed.ts" "$dir" "$project" "$scope"); then
            targets=()
            while IFS= read -r line; do
                [[ -n "$line" ]] && targets+=("$line")
            done <<<"$listed"
            if ((${#targets[@]} == 0)); then
                echo -e "\n${CYAN}${BOLD}▶ ${name} — SKIPPED${NC}"
                echo -e "  No failure recorded on its last run (--last-failed)"
                SKIPPED+=("$name")
                return
            fi
            note="--last-failed: ${#targets[@]} file(s) that failed on the last run"
        else
            note="--last-failed: no readable vitest results cache here — running the whole layer"
        fi
    fi
    run_step "$name" vitest_in "$dir" "$note" "${cmd[@]}" "${targets[@]}"
}

# The test ports Playwright uses (API/web-dev/preview). The user's real dev servers live on other
# ports (3000/5173/5174), so this leaves them alone.
E2E_PORTS=(3001 5188 4188)

e2e_cleanup() {
    pkill -9 -f "workerProcessEntry" 2>/dev/null || true
    pkill -9 -f "playwright_chromiumdev_profile" 2>/dev/null || true
    local p
    for p in "${E2E_PORTS[@]}"; do
        local pids
        pids=$(lsof -ti ":${p}" 2>/dev/null || true)
        [[ -n "$pids" ]] && echo "$pids" | xargs kill -9 2>/dev/null || true
    done
}

# The E2E project, with a watchdog against the Playwright teardown hang.
#
# The problem: the API runs on Bun, whose node:http compatibility does not close idle keep-alive
# connections the way Node does. A leftover `playwright.request` socket to the API can keep a
# Playwright worker alive, and with an owned server Playwright then waits up to 300s (5 minutes) for
# the worker to exit before force-killing it — "worker did not exit within 300000ms" plus a ~5-minute
# hang.
#
# IMPORTANT: that hang comes BEFORE the list reporter prints "N passed" (Playwright holds the summary
# back until the worker has stopped). So we do NOT wait for the summary — we count finished tests
# instead: "Running N tests" gives us the total, and every "✓/✘ <number> [" is one finished test. Once
# they are all finished the result is known, and if the process does not exit within the grace period
# (a healthy teardown takes a couple of seconds) we interrupt it and clean up.
# A failing test still fails properly — we ignore ONLY the teardown, and only after every test has
# finished.
run_e2e_project() {
    local name="$1"
    shift
    echo -e "\n${CYAN}${BOLD}▶ ${name}${NC}"
    TOTAL=$((TOTAL + 1))
    local logf
    logf="$(mktemp "${TMPDIR:-/tmp}/e2e.XXXXXX")"
    (cd "${ROOT}/client" && "$@") >"$logf" 2>&1 &
    local pid=$!
    tail -f "$logf" 2>/dev/null &
    local tpid=$!
    local total=0 grace=0 hung=0 done_n=0
    while kill -0 "$pid" 2>/dev/null; do
        if ((total == 0)); then
            total=$(grep -oE "Running [0-9]+ test" "$logf" 2>/dev/null | head -1 | grep -oE "[0-9]+")
            total=${total:-0}
        fi
        done_n=$(grep -cE "(✓|✘|✗)[[:space:]]+[0-9]+[[:space:]]+\[" "$logf" 2>/dev/null)
        done_n=${done_n:-0}
        local results_in=0
        ((total > 0 && done_n >= total)) && results_in=1
        grep -qE "[0-9]+ (passed|failed)" "$logf" 2>/dev/null && results_in=1
        if ((results_in == 1)); then
            ((grace++)) || true
            if ((grace >= 20)); then
                hung=1
                kill -9 "$pid" 2>/dev/null || true
                e2e_cleanup
                break
            fi
        fi
        sleep 1
    done
    kill "$tpid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    ((hung == 1)) && echo -e "  ${CYAN}(the teardown hung after the tests had finished — interrupted and cleaned up)${NC}"
    local failed_n
    failed_n=$(grep -cE "(✘|✗)[[:space:]]+[0-9]+[[:space:]]+\[" "$logf" 2>/dev/null)
    failed_n=${failed_n:-0}
    local ok=0
    if ((failed_n == 0)); then
        if grep -qE "[0-9]+ passed" "$logf" && ! grep -qE "[0-9]+ failed" "$logf"; then
            ok=1
        elif ((total > 0 && done_n >= total)); then
            ok=1
        fi
    fi
    rm -f "$logf"
    if ((ok == 1)); then
        echo -e "${GREEN}✓ ${name} — OK${NC}"
    else
        echo -e "${RED}✗ ${name} — FAILED${NC}"
        ((FAIL++)) || true
        ERRORS+=("$name")
    fi
}

needs_docker() {
    case "$MODE" in
        all|api|e2e) return 0 ;;
        *) return 1 ;;
    esac
}

start_docker_infra() {
    echo -e "\n${CYAN}${BOLD}▶ Starting test infrastructure...${NC}"
    if ! docker info >/dev/null 2>&1; then
        echo -e "  The Docker daemon is not running — trying to start it..."
        if [[ "$(uname)" == "Darwin" ]]; then
            open -a OrbStack >/dev/null 2>&1 || open -a Docker >/dev/null 2>&1 || true
            for _ in $(seq 1 30); do
                docker info >/dev/null 2>&1 && break
                sleep 2
            done
        fi
        if ! docker info >/dev/null 2>&1; then
            echo -e "\n${RED}${BOLD}ERROR: the Docker daemon is unreachable.${NC}"
            echo -e "  Start OrbStack or Docker Desktop, then run ./test.sh again"
            exit 1
        fi
    fi
    if ! docker compose up -d --wait db_test garage_test; then
        echo -e "\n${RED}${BOLD}ERROR: Failed to start test infrastructure.${NC}"
        exit 1
    fi
}

run_api_tests() {
    run_step "API tests (bun test)" bash -c \
        "cd '${ROOT}/server' && bun test --preload ./test/setup.ts --sequential"
}

run_shared_unit() {
    run_vitest_step "Shared package tests (vitest)" "${ROOT}/shared" "" "" bun vitest
}

run_web_unit() {
    run_vitest_step "Web unit tests (vitest)" "${ROOT}/client" unit "" bun vitest
    # The editor harness (TipTap/ProseMirror under jsdom); the same gate as unit.
    run_vitest_step "Web dom tests (vitest jsdom)" "${ROOT}/client" dom "" bun vitest
}

run_changelog_unit() {
    # The whole of `scripts/`, not only `scripts/changelog/`: a script broke silently on 2026-09-10
    # because no gate ran the scripts from the root.
    run_vitest_step "Root script tests (vitest)" "${ROOT}" "" scripts/ bunx vitest
}

run_web_integration() {
    run_vitest_step "Web integration tests (vitest)" "${ROOT}/client" integration "" bun vitest
}

e2e_is_heavy() {
    local base="$1"
    local h
    for h in "${E2E_HEAVY_SPECS[@]}"; do
        [[ "$base" == "$h" ]] && return 0
    done
    return 1
}

# Returns the relative paths of the e2e/*.spec.ts files that are NOT on the heavy list.
build_e2e_fast_specs() {
    local f base rel
    for f in "${ROOT}/client/e2e"/*.spec.ts; do
        [[ -f "$f" ]] || continue
        base=$(basename "$f")
        if e2e_is_heavy "$base"; then
            continue
        fi
        rel="e2e/${base}"
        printf '%s\n' "$rel"
    done
}

run_e2e_fast() {
    local pw_extra=()
    local -a specs=()
    if ((LAST_FAILED == 1)); then
        pw_extra+=(--last-failed)
    fi
    while IFS= read -r line; do
        [[ -n "$line" ]] && specs+=("$line")
    done < <(build_e2e_fast_specs)
    if ((${#specs[@]} == 0)); then
        echo -e "${RED}ERROR: there are no fast E2E specs${NC}" >&2
        return 1
    fi
    echo -e "  ${CYAN}Fast E2E: ${#specs[@]} spec(s); the heavy ones excluded (${#E2E_HEAVY_SPECS[@]})${NC}"
    run_e2e_project "E2E chromium smoke (playwright)" \
        env PW_NO_PREVIEW=1 bunx playwright test --project=chromium --reporter=list \
        "${pw_extra[@]}" "${specs[@]}"
}

run_e2e_all() {
    local pw_extra=()
    if ((LAST_FAILED == 1)); then
        pw_extra+=(--last-failed)
    fi
    # --e2e-full is CPU-bound: the client-side KDF under vite dev is the production Argon2id
    # (m=65536,t=3,p=4), so every registration or login asks for up to 4 threads.
    # The default workers=4 on a machine with fewer cores asks for more threads than there are cores
    # (4×4=16 on a 12-core Mac, say) — that oversubscription produced deterministic E2E timeouts
    # (always the same test/worker slot, see 07-history's embed-settle). Here workers = cores/4
    # (ARGON2_PARALLELISM), so the total demand for threads does not exceed the number of cores. An
    # explicit E2E_WORKERS override still takes precedence.
    local workers="${E2E_WORKERS:-}"
    if [[ -z "$workers" ]]; then
        local cores
        cores=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)
        workers=$((cores / 4))
        ((workers < 1)) && workers=1
        ((workers > 4)) && workers=4
    fi
    echo -e "  ${CYAN}E2E_WORKERS=${workers} (the full suite, a CPU-bound client-side KDF)${NC}"
    run_e2e_project "E2E chromium full (playwright)" \
        env PW_NO_PREVIEW=1 E2E_WORKERS="$workers" bunx playwright test --project=chromium --reporter=list "${pw_extra[@]}"
    run_e2e_project "E2E pwa (playwright)" \
        env E2E_WORKERS="$workers" bunx playwright test --project=pwa --reporter=list "${pw_extra[@]}"
}

resolve_e2e_spec() {
    local name="$1"
    local match
    match=$(find "${ROOT}/client/e2e" -maxdepth 1 -name "*${name}*.spec.ts" -print -quit)
    if [[ -z "$match" ]]; then
        echo -e "${RED}ERROR: there is no E2E spec matching '${name}'${NC}" >&2
        echo -e "  The available specs:" >&2
        ls -1 "${ROOT}/client/e2e"/*.spec.ts 2>/dev/null | xargs -n1 basename >&2
        exit 1
    fi
    basename "$match"
}

run_e2e_targeted() {
    local spec
    spec=$(resolve_e2e_spec "$E2E_TARGET")
    local rel="e2e/${spec}"
    local pw_extra=()
    if ((LAST_FAILED == 1)); then
        pw_extra+=(--last-failed)
    fi
    if [[ "$spec" == *"17-offline-pwa"* || "$spec" == *"29-csp-enforce"* ]]; then
        run_e2e_project "E2E pwa — ${spec}" \
            bunx playwright test --project=pwa --reporter=list "${pw_extra[@]}" "$rel"
    else
        run_e2e_project "E2E chromium — ${spec}" \
            env PW_NO_PREVIEW=1 bunx playwright test --project=chromium --reporter=list "${pw_extra[@]}" "$rel"
    fi
}

echo -e "${BOLD}═══════════════════════════════════════${NC}"
echo -e "${BOLD}  ZKnotes — Tests${NC}"
echo -e "${BOLD}═══════════════════════════════════════${NC}"

# A prerequisite, not a step: the server depends on shared through `file:../shared`, which Bun installs
# as a hard-linked copy. A new file, or one saved by replacing it (a git checkout, an editor's safe
# write), does not reach that copy until the next install, and the API tests and the E2E server would run
# a shared that is no longer there. --frozen-lockfile refreshes the copy and never rewrites bun.lock.
echo -e "\n${CYAN}${BOLD}▶ Refreshing the server's copy of shared (bun install --frozen-lockfile)...${NC}"
if ! (cd "${ROOT}" && bun install --frozen-lockfile); then
    echo -e "${RED}${BOLD}ERROR: bun install --frozen-lockfile failed — is bun.lock current? (Offline, the Bun cache has to hold every package.)${NC}"
    exit 1
fi

if needs_docker; then
    start_docker_infra
fi

case "$MODE" in
    unit)
        run_shared_unit
        run_changelog_unit
        run_web_unit
        ;;
    integration)
        run_web_integration
        ;;
    api)
        run_api_tests
        ;;
    e2e)
        run_e2e_targeted
        ;;
    all)
        run_api_tests
        run_shared_unit
        run_changelog_unit
        run_web_unit
        run_web_integration
        case "$E2E_MODE" in
            2)
                run_e2e_all
                ;;
            1)
                run_e2e_fast
                ;;
            *)
                echo -e "\n${CYAN}${BOLD}▶ E2E tests (playwright) — SKIPPED${NC}"
                echo -e "  Fast smoke:  ./test.sh --e2e"
                echo -e "  The full suite:  ./test.sh --e2e-full  (before a merge)"
                ;;
        esac
        ;;
esac

PASS=$((TOTAL - FAIL))

echo -e "\n${BOLD}═══════════════════════════════════════${NC}"
if [[ $FAIL -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}  All tests passed ✓ (${PASS}/${TOTAL})${NC}"
else
    echo -e "${RED}${BOLD}  ${FAIL} suite(s) failed (${PASS}/${TOTAL} OK)${NC}"
    for e in "${ERRORS[@]}"; do
        echo -e "${RED}    • ${e}${NC}"
    done
fi
if ((${#SKIPPED[@]} > 0)); then
    echo -e "${CYAN}  ${#SKIPPED[@]} suite(s) skipped by --last-failed — no failure on their last run:${NC}"
    for s in "${SKIPPED[@]}"; do
        echo -e "${CYAN}    • ${s}${NC}"
    done
fi
echo -e "${BOLD}═══════════════════════════════════════${NC}"

exit $FAIL