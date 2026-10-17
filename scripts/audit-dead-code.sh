#!/usr/bin/env bash
# audit-dead-code.sh — a manual dead-code audit of this repository.
#
# Two passes:
#   1. knip    — unused exports, files and dependencies (a static analysis of the graph)
#   2. methods — public class methods with no callers (knip does not track class members)
#
# It is NOT part of ./check.sh or of CI — it is a heuristic, so check every finding by hand.
# Options: --quick (knip only) | --no-fail (always exit 0) | --help
#
# Deliberately WITHOUT `set -e`: a non-zero exit from grep/knip/python is a normal signal ("there are
# findings"), not a failure of the script. Real failures are caught explicitly (knip_rc, methods_rc).

set -uo pipefail

# The repository root, one level above scripts/ (the file moved there in a198840 and still resolved
# its own directory, so knip ran where there is no package.json).
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

QUICK=false
NO_FAIL=false

for arg in "$@"; do
    case "$arg" in
        --quick) QUICK=true ;;
        --no-fail) NO_FAIL=true ;;
        --help)
            echo "audit-dead-code.sh — a dead-code audit (knip + class methods)"
            echo
            echo "A heuristic for a local, manual audit. NOT part of ./check.sh or of CI."
            echo "Exit 0 only when there are no findings; otherwise 1 (unless --no-fail)."
            echo
            echo "Options:"
            echo "  --quick    knip only; it skips the methods pass"
            echo "  --no-fail  Always exit 0 (for exploration)"
            echo "  --help     Show this help"
            exit 0
            ;;
        *)
            echo "Unknown option: $arg (see --help)" >&2
            exit 2
            ;;
    esac
done

BOLD="\033[1m"
CYAN="\033[36m"
YELLOW="\033[33m"
GREEN="\033[32m"
RED="\033[31m"
DIM="\033[2m"
RESET="\033[0m"

echo -e "\n${BOLD}${CYAN}▶ Dead-code audit${RESET}\n"

# ─── 1. knip ────────────────────────────────────────────────────────────────
echo -e "${BOLD}1/2  knip — unused exports, files and dependencies${RESET}"
echo -e "${DIM}     (the entry points and the ignore list live in knip.json — we do not filter the output)${RESET}"
echo

# A dummy DATABASE_URL: server/drizzle.config.ts throws at load time if there is none, and knip's
# drizzle plugin loads that file. Knip never connects to the database — the URL only has to parse.
# It is set for this process alone, and only if the environment does not already have one.
KNIP_OUT=$(DATABASE_URL="${DATABASE_URL:-postgresql://knip:knip@127.0.0.1/knip}" bunx knip 2>&1)
knip_rc=$?

if [[ -n "$KNIP_OUT" ]]; then
    echo "$KNIP_OUT"
elif [[ "$knip_rc" -eq 0 ]]; then
    echo -e "  ${GREEN}No findings.${RESET}"
else
    echo -e "  ${RED}knip failed (exit ${knip_rc}) with no output — the result is NOT dependable.${RESET}"
fi

# ─── 2. Class methods with no callers ──────────────────────────────────────
SRC_DIRS="client/src server/src shared/src"
FOUND=0
methods_rc=0

if ! $QUICK; then
    echo -e "\n${BOLD}2/2  class methods with no callers${RESET}"
    echo -e "${DIM}     (a heuristic: it skips private/#/tests; dynamic calls are invisible to it)${RESET}"
    echo

    if ! command -v python3 >/dev/null 2>&1; then
        echo -e "  ${RED}python3 is unavailable — the methods pass did NOT run.${RESET}"
        methods_rc=127
    else
        # shellcheck disable=SC2086
        METHODS_OUT=$(python3 - $SRC_DIRS <<'PYEOF'
# The heuristic: public class methods for which no `.name` appears anywhere in the tree.
# The key rule: a class member is ONLY a line at depth 0 inside the class body.
# A call inside a method body (depth >= 1) is not a declaration — that was the bug the old collector
# had (it reported clearTimeout, untrack, String and friends).
import os
import re
import sys

SRC_DIRS = sys.argv[1:]
EXTS = (".ts", ".svelte")

RESERVED = {
    "constructor", "return", "const", "let", "var", "if", "else", "for", "while",
    "switch", "case", "throw", "try", "catch", "finally", "import", "export",
    "async", "await", "super", "this", "new", "typeof", "instanceof", "void",
    "null", "true", "false", "undefined", "default", "break", "continue",
    "delete", "in", "of", "do", "debugger", "function", "class", "yield",
    "static", "get", "set", "public", "private", "protected", "readonly",
    "abstract", "override", "declare", "enum", "interface", "type", "namespace",
}

MODS = r"(?:public|static|async|override|abstract|readonly|declare)\s+"
METHOD_RE = re.compile(
    r"^(?:" + MODS + r")*(?:(?:get|set)\s+)?(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)"
    r"\s*(?:<[^<>]*>)?\s*\("
)
FIELD_RE = re.compile(
    r"^(?:" + MODS + r")*(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]*)?=\s*"
    r"(?:async\s+)?(?:\([^)]*\)\s*(?::[^=]*)?=>|function\b)"
)
CLASS_RE = re.compile(r"(?:^|[^\w$])class(?:\s+[A-Za-z_$][A-Za-z0-9_$]*)?")
CALL_RE = re.compile(r"\.\s*([A-Za-z_$][A-Za-z0-9_$]*)")


def strip_noise(line, in_block, in_template):
    """Strip the comments and the contents of strings; return (the clean line, the states)."""
    out = []
    i, n = 0, len(line)
    while i < n:
        if in_block:
            j = line.find("*/", i)
            if j < 0:
                return "".join(out), True, in_template
            i, in_block = j + 2, False
            continue
        if in_template:
            j = line.find("`", i)
            if j < 0:
                return "".join(out), in_block, True
            i, in_template = j + 1, False
            continue
        c = line[i]
        if c == "/" and i + 1 < n:
            if line[i + 1] == "/":
                break
            if line[i + 1] == "*":
                i, in_block = i + 2, True
                continue
        if c in "\"'`":
            i += 1
            closed = False
            while i < n:
                if line[i] == "\\":
                    i += 2
                    continue
                if line[i] == c:
                    i, closed = i + 1, True
                    break
                i += 1
            if not closed and c == "`":
                in_template = True
            out.append('""')
            continue
        out.append(c)
        i += 1
    return "".join(out), in_block, in_template


def scan():
    methods = []   # (path, name) — the declarations
    calls = {}     # name -> set(path) — one index of every call site
    for src in SRC_DIRS:
        for root, _dirs, files in os.walk(src):
            for f in sorted(files):
                if not f.endswith(EXTS) or ".test." in f or ".spec." in f:
                    continue
                path = os.path.join(root, f)
                try:
                    with open(path, "r", encoding="utf-8") as fh:
                        text = fh.read()
                except (OSError, UnicodeDecodeError):
                    continue

                depth = 0
                class_stack = []
                in_block = in_template = False
                for raw in text.split("\n"):
                    clean, in_block, in_template = strip_noise(raw, in_block, in_template)
                    stripped = clean.strip()

                    for name in CALL_RE.findall(clean):
                        calls.setdefault(name, set()).add(path)

                    if (
                        class_stack
                        and depth == class_stack[-1] + 1
                        and stripped
                        and not stripped.startswith(
                            ("private", "protected", "#", "}", ")", "]", "@")
                        )
                    ):
                        m = METHOD_RE.match(stripped) or FIELD_RE.match(stripped)
                        if m and m.group("name") not in RESERVED:
                            methods.append((path, m.group("name")))

                    if "{" in clean and CLASS_RE.search(clean):
                        class_stack.append(depth)
                    depth += clean.count("{") - clean.count("}")
                    while class_stack and depth <= class_stack[-1]:
                        class_stack.pop()
    return methods, calls


methods, calls = scan()
seen = set()
for path, name in methods:
    if (path, name) in seen:
        continue
    seen.add((path, name))
    # We count callers in the file itself too: a declaration has no leading dot, while
    # `this.foo()` / `wrapper.foo()` in the same module IS a real call (the crypto-rpc.ts pattern: an
    # exported function wrapping a class method).
    if not calls.get(name):
        print("%s\t%s" % (path, name))
PYEOF
        )
        methods_rc=$?

        if [[ "$methods_rc" -ne 0 ]]; then
            echo -e "  ${RED}The methods pass broke (python3 exit ${methods_rc}) — the result is NOT dependable.${RESET}"
        elif [[ -z "$METHODS_OUT" ]]; then
            echo -e "  ${GREEN}No suspects.${RESET}"
        else
            while IFS=$'\t' read -r path name; do
                [[ -z "$name" ]] && continue
                echo -e "  ${YELLOW}⚠${RESET}  ${BOLD}${name}${RESET}  ←  ${DIM}${path}${RESET}"
                FOUND=$((FOUND + 1))
            done <<< "$METHODS_OUT"
            echo
            echo -e "  ${DIM}Note: dynamic calls (bracket notation, event dispatch, framework hooks)${RESET}"
            echo -e "  ${DIM}are invisible here. A method only the tests call is reported too.${RESET}"
        fi
    fi
fi

# ─── Summary ────────────────────────────────────────────────────────────────
knip_count() {
    local n
    n=$(echo "$KNIP_OUT" | sed -n "s/^Unused $1 (\([0-9][0-9]*\)).*/\1/p" | head -1)
    echo "${n:-0}"
}

echo
echo -e "${DIM}Summary: files=$(knip_count "files") deps=$(knip_count "dependencies") devDeps=$(knip_count "devDependencies") exports=$(knip_count "exports") types=$(knip_count "exported types") methods=${FOUND}${RESET}"
echo

if $NO_FAIL; then
    exit 0
fi
if [[ "$knip_rc" -ne 0 ]] || [[ "$methods_rc" -ne 0 ]] || [[ "$FOUND" -gt 0 ]]; then
    exit 1
fi
exit 0
