#!/usr/bin/env bash
# Check that a running ZKnotes instance serves the web client this repository builds.
#
# The instance names the commit it was built from (/_app/version.json). This script builds that
# commit itself — from a clone of the public repository, in the canonical Docker environment — and
# then fetches every file of that build from the instance and compares the bytes. The anchors are
# the public repository and your own machine; nothing the instance serves is trusted as a reference,
# only compared.
#
# Usage:
#   scripts/verify-live.sh <url> [--commit <sha>]
#
#   <url>            the instance, e.g. https://notes.example.com — the final address, not one
#                    that redirects (http:// → https://)
#   --commit <sha>   build this commit instead of the one the instance reports; its version.json
#                    is still compared as a file, so an instance built from another commit (or
#                    without APP_COMMIT) cannot match
#
# Requires docker, git, curl and this repository as a git clone with the public repository as
# `origin` (a commit the clone does not have is fetched from there). A full check builds the client
# once (a few minutes) and then makes one request per file.
#
# Exit code:
#   0 — every file the build produced, and `/`, came back byte-identical
#   1 — a file differs or is missing, or the commit cannot be fetched from the public repository
#   2 — the instance cannot be checked (its version is not a commit hash) or an environment
#       error: a missing tool, no network, a redirect, a request that failed
#
# What a match proves, and what it does not, is in docs/verifying-the-build.md.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TREE_HASH="${ROOT}/scripts/tree-hash.sh"
# shellcheck source=lib-build-web.sh
source "${ROOT}/scripts/lib-build-web.sh"

url=""
commit_arg=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --commit)
            [[ $# -ge 2 ]] || { echo "--commit needs a value" >&2; exit 2; }
            commit_arg="$2"
            shift 2
            ;;
        -h | --help)
            sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        -*)
            echo "unknown option: $1" >&2
            exit 2
            ;;
        *)
            [[ -z "$url" ]] || { echo "one url only" >&2; exit 2; }
            url="$1"
            shift
            ;;
    esac
done
[[ -n "$url" ]] || { echo "usage: scripts/verify-live.sh <url> [--commit <sha>]" >&2; exit 2; }
[[ "$url" =~ ^https?:// ]] || { echo "the url must start with http:// or https://" >&2; exit 2; }
url="${url%/}"

check_build_tools || exit 2
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 2; }
command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required" >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# One request, as a browser that accepts nothing but the bytes: no compression (so the body is the
# file itself), no cache, no redirect. Prints the HTTP status; a failed request prints "000".
fetch() { # $1 = path ("" for the root), $2 = output file
    local code
    code="$(curl -sS --max-time 60 \
        -H 'Accept-Encoding: identity' -H 'Cache-Control: no-cache' \
        -o "$2" -w '%{http_code}' "${url}/$1" 2>"$TMP/curl.err")" || code="000"
    echo "$code"
}

# ── 1. Which commit does the instance claim? ───────────────────────────────────
status="$(fetch "_app/version.json" "$TMP/version.json")"
case "$status" in
    200) ;;
    000)
        echo "✗ could not reach ${url}/_app/version.json: $(cat "$TMP/curl.err")" >&2
        exit 2
        ;;
    3*)
        echo "✗ ${url}/_app/version.json redirects (HTTP ${status}) — pass the final address, e.g. https://…" >&2
        exit 2
        ;;
    *)
        echo "✗ ${url}/_app/version.json answered HTTP ${status} — is this a ZKnotes instance?" >&2
        exit 2
        ;;
esac
served_version="$(sed -n 's/.*"version":"\([^"]*\)".*/\1/p' "$TMP/version.json")"

if [[ -n "$commit_arg" ]]; then
    commit_ref="$commit_arg"
elif [[ "$served_version" =~ ^[0-9a-f]{40}$ ]]; then
    commit_ref="$served_version"
else
    echo "✗ cannot verify: the instance reports version \"${served_version}\", which is not a commit hash." >&2
    echo "  It was built without APP_COMMIT (a build timestamp names the version instead), so there is no" >&2
    echo "  commit to rebuild. Ask the operator to build with APP_COMMIT=\$(git rev-parse HEAD) and" >&2
    echo "  SOURCE_DATE_EPOCH=\$(git show -s --format=%ct HEAD) — docker/README.md, \"Updating\"." >&2
    exit 2
fi

# ── 2. The commit has to exist in the public repository ────────────────────────
if ! commit="$(git -C "$ROOT" rev-parse --verify --quiet "${commit_ref}^{commit}")"; then
    origin="$(git -C "$ROOT" remote get-url origin 2>/dev/null || echo "(no origin)")"
    echo "▶ ${commit_ref} is not in this clone — fetching it from ${origin} ..." >&2
    if ! git -C "$ROOT" fetch --quiet origin "$commit_ref" 2>"$TMP/fetch.err" \
        || ! commit="$(git -C "$ROOT" rev-parse --verify --quiet "${commit_ref}^{commit}")"; then
        echo "✗ commit ${commit_ref} cannot be fetched from ${origin}:" >&2
        sed 's/^/  /' "$TMP/fetch.err" >&2
        echo "  The instance claims a commit the public repository does not have — a build nobody can" >&2
        echo "  reproduce is itself a finding. (If the instance runs a fork, clone that fork instead.)" >&2
        exit 1
    fi
fi
epoch="$(git -C "$ROOT" show -s --format=%ct "$commit")"
commit_date="$(git -C "$ROOT" show -s --format=%cI "$commit")"

# Where the commit sits is information, not a verdict: a self-hosted instance may run a branch or
# a fork. But a hosted service serving an old commit is worth noticing, so say whether it is on
# origin/main (as last fetched; the fetch may fail offline, and then the local view is used).
git -C "$ROOT" fetch --quiet origin main >/dev/null 2>&1 || true
on_main="unknown (no origin/main in this clone)"
if git -C "$ROOT" rev-parse --verify --quiet origin/main >/dev/null; then
    if git -C "$ROOT" merge-base --is-ancestor "$commit" origin/main; then
        behind="$(git -C "$ROOT" rev-list --count "${commit}..origin/main")"
        on_main="yes, ${behind} commit(s) behind origin/main"
    else
        on_main="no — not an ancestor of origin/main (a branch or a fork?)"
    fi
fi

echo "commit=${commit}"
echo "commit_date=${commit_date}"
echo "on_origin_main=${on_main}"
echo "source_date_epoch=${epoch}"

# ── 3. Build it ourselves ──────────────────────────────────────────────────────
echo "▶ building ${commit:0:12} (docker, a few minutes) ..." >&2
if ! build_web_root "$commit" "$commit" "$epoch" "$TMP/build"; then
    echo "✗ the build failed — see the docker output above" >&2
    exit 2
fi
sh "$TREE_HASH" --list "$TMP/build" >"$TMP/list"
tree_hash="$(sh "$TREE_HASH" "$TMP/build")"
total="$(wc -l <"$TMP/list")"
echo "tree_hash=${tree_hash}"
index_hash="$(sha256sum "$TMP/build/index.html" | cut -d' ' -f1)"

# ── 4. Fetch every file and compare ────────────────────────────────────────────
echo "▶ fetching ${total} files + / from ${url} ..." >&2
match=0
failed=0
: >"$TMP/mismatches"

compare() { # $1 = path as served ("" for /), $2 = expected sha256, $3 = label
    local status got
    status="$(fetch "$1" "$TMP/got")"
    if [[ "$status" == "000" ]]; then
        echo "  ${3}: request failed — $(cat "$TMP/curl.err")" >>"$TMP/mismatches"
        failed=$((failed + 1))
        return
    fi
    got="$(sha256sum "$TMP/got" | cut -d' ' -f1)"
    if [[ "$status" == "200" && "$got" == "$2" ]]; then
        match=$((match + 1))
        return
    fi
    if [[ "$status" != "200" ]]; then
        echo "  ${3}: HTTP ${status}" >>"$TMP/mismatches"
    elif [[ "$got" == "$index_hash" && "$1" != "index.html" && "$1" != "" ]]; then
        # nginx answers a path it has no file for with the SPA shell and a 200, so a file that is
        # missing on the server looks like a different file unless it is named.
        echo "  ${3}: missing — the server answered with the SPA shell (index.html) instead" >>"$TMP/mismatches"
    else
        echo "  ${3}: differs" >>"$TMP/mismatches"
        echo "      expected ${2}" >>"$TMP/mismatches"
        echo "      served   ${got}" >>"$TMP/mismatches"
    fi
}

while read -r expected path; do
    path="${path#./}"
    compare "$path" "$expected" "/${path}"
done <"$TMP/list"
# What a browser gets for the root is the fallback document; it has to be the built index.html.
compare "" "$index_hash" "/ (index.html)"

checked=$((total + 1))
echo "match=${match}/${checked}"
if [[ "$match" -eq "$checked" ]]; then
    echo "✓ ${url} serves the build of ${commit} — ${total} files and / are byte-identical"
    echo "  treeHash ${tree_hash} is the number this commit's CI run publishes."
    exit 0
fi

echo "✗ ${url} does not match the build of ${commit}:"
cat "$TMP/mismatches"
if [[ "$failed" -gt 0 ]]; then
    echo "  ${failed} request(s) failed — run it again; a network error is not a finding." >&2
    exit 2
fi
echo "  Compare a pair with diffoscope (https://diffoscope.org) to see how they differ, and read" >&2
echo "  docs/verifying-the-build.md (\"When it does not match\")." >&2
exit 1
