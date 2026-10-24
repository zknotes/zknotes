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
#   <url>            the instance root, e.g. https://notes.example.com — the final address, not one
#                    that redirects (http:// → https://), and not a page inside the app
#   --commit <sha>   build this commit instead of the one the instance reports; its version.json
#                    is still compared as a file, so an instance built from another commit (or
#                    without APP_COMMIT) cannot match
#
# Requires bash, docker, git, curl, tar and sha256sum, and this repository as a git clone with the
# public repository as `origin` (a commit the clone does not have is fetched from there). A full
# check builds the client once (a few minutes) and then makes one request per file and per route.
#
# What is fetched: every file the build produced, `/`, and a fixed set of paths a browser opens as
# a document (/login, /create-vault, /settings, a share link, a note, a trailing slash, and one
# random path). A browser gets the SPA shell from whatever path it was opened at, so each of those
# has to be the built index.html too — checking `/` alone would leave /login, where the password
# is typed, unverified.
#
# Exit code:
#   0 — every file, `/` and every route came back byte-identical
#   1 — a file or route differs, is missing or answers another status, or the public repository
#       does not hand out the commit. A difference wins over a failed request: a run with both
#       exits 1 and lists the failed requests separately
#   2 — the instance cannot be checked (its version is not a commit hash, or the url is not an
#       instance root) or an environment error: a missing tool, no network, no `origin` remote,
#       a redirect, or a request that failed while nothing else differed
#
# What a match proves, and what it does not, is in docs/verifying-the-build.md.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TREE_HASH="${ROOT}/scripts/tree-hash.sh"
# shellcheck source=lib-build-web.sh
source "${ROOT}/scripts/lib-build-web.sh"

# The paths a browser opens as a document, besides `/`. nginx answers every one of them with the
# SPA shell (try_files … /index.html), so every one has to be the built index.html. The list is
# fixed on purpose — it is not read from the instance — and a random path is added at run time so
# a server cannot special-case the known names.
ROUTES=(login create-vault settings s/x note/x login/)

# The request looks like a browser's, not like curl's. That removes the cheapest way for a server
# to tell a verifier from a visitor (the User-Agent), nothing more: the TLS fingerprint still says
# curl, and docs/verifying-the-build.md says so.
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

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
# file itself), no cache, no redirect. "navigate" asks the way a browser asks for a document; the
# default asks the way it asks for a script or an asset. Prints the HTTP status; a failed request
# prints "000". The response headers land in $TMP/headers.
fetch() { # $1 = path ("" for the root), $2 = output file, $3 = "navigate" or ""
    local code
    local -a headers=(-A "$UA" -H 'Accept-Encoding: identity' -H 'Cache-Control: no-cache')
    if [[ "${3:-}" == navigate ]]; then
        headers+=(-H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Site: none'
            -H 'Sec-Fetch-User: ?1')
    else
        headers+=(-H 'Accept: */*' -H 'Sec-Fetch-Mode: no-cors' -H 'Sec-Fetch-Dest: empty'
            -H 'Sec-Fetch-Site: same-origin')
    fi
    code="$(curl -sS --max-time 60 "${headers[@]}" \
        -D "$TMP/headers" -o "$2" -w '%{http_code}' "${url}/$1" 2>"$TMP/curl.err")" || code="000"
    echo "$code"
}

# The Content-Encoding of the last response, lower-cased; empty when the server sent none.
content_encoding() {
    sed -n 's/^[Cc]ontent-[Ee]ncoding:[[:space:]]*//p' "$TMP/headers" 2>/dev/null \
        | tail -n 1 | tr -d '\r' | tr '[:upper:]' '[:lower:]'
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
# A url that points inside the app (…/login) gets the SPA shell here, with a 200, because nginx
# answers every unknown path with it. That is not a version file.
if ! grep -q '"version"' "$TMP/version.json"; then
    echo "✗ ${url}/_app/version.json is not a ZKnotes version file (no \"version\" field in the answer)." >&2
    echo "  Is ${url} the instance root? Pass the address the app is served from, without a page path." >&2
    exit 2
fi
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
    echo "  On an instance that says it can be verified, a version that is not a commit is itself worth a" >&2
    echo "  question. --commit <sha> forces the comparison: its version.json is then compared as a file." >&2
    exit 2
fi

# ── 2. The commit has to exist in the public repository ────────────────────────
if ! commit="$(git -C "$ROOT" rev-parse --verify --quiet "${commit_ref}^{commit}")"; then
    if ! origin="$(git -C "$ROOT" remote get-url origin 2>/dev/null)"; then
        echo "✗ ${commit_ref} is not in this clone, and the clone has no remote named origin to fetch it from." >&2
        echo "  Run the check from a clone of the public repository (git clone https://github.com/zknotes/zknotes.git)." >&2
        exit 2
    fi
    echo "▶ ${commit_ref} is not in this clone — fetching it from ${origin} ..." >&2
    if ! git -C "$ROOT" fetch --quiet origin "$commit_ref" 2>"$TMP/fetch.err" \
        || ! commit="$(git -C "$ROOT" rev-parse --verify --quiet "${commit_ref}^{commit}")"; then
        # No answer from the remote is an environment error; an answer without the commit is a finding.
        if grep -qiE 'could not resolve|connection refused|connection timed out|unable to access|network is unreachable|could not read from remote' "$TMP/fetch.err"; then
            echo "✗ could not reach ${origin} to fetch ${commit_ref}:" >&2
            sed 's/^/  /' "$TMP/fetch.err" >&2
            echo "  No network, or the remote is unreachable — an environment error, not a finding." >&2
            exit 2
        fi
        echo "✗ commit ${commit_ref} cannot be fetched from ${origin}:" >&2
        sed 's/^/  /' "$TMP/fetch.err" >&2
        echo "  The public repository did not hand out the commit the instance claims — a build that cannot" >&2
        echo "  be fetched is itself a finding. (If the instance runs a fork, clone that fork instead.)" >&2
        exit 1
    fi
fi
epoch="$(git -C "$ROOT" show -s --format=%ct "$commit")"
commit_date="$(git -C "$ROOT" show -s --format=%cI "$commit")"

# Where the commit sits is information, not a verdict: a self-hosted instance may run a branch or
# a fork. But a hosted service serving an old commit is worth noticing, so say whether it is on
# origin/main (as last fetched; the fetch may fail offline, and then the local view is used). A
# shallow clone cannot tell: the history it has may end before the commit.
git -C "$ROOT" fetch --quiet origin main >/dev/null 2>&1 || true
on_main="unknown (no origin/main in this clone)"
if [[ "$(git -C "$ROOT" rev-parse --is-shallow-repository 2>/dev/null)" == true ]]; then
    on_main="unknown (shallow clone — git fetch --unshallow to find out)"
elif git -C "$ROOT" rev-parse --verify --quiet origin/main >/dev/null; then
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
total=$((total))
echo "tree_hash=${tree_hash}"
index_hash="$(sha256sum "$TMP/build/index.html" | cut -d' ' -f1)"

# ── 4. Fetch every file, `/` and the routes, and compare ───────────────────────
ROUTES+=("verify-$(od -An -tx1 -N8 /dev/urandom | tr -d ' \n')")
echo "▶ fetching ${total} files, / and ${#ROUTES[@]} routes from ${url} ..." >&2
match=0
failed=0
: >"$TMP/mismatches"

compare() { # $1 = path as served ("" for /), $2 = expected sha256, $3 = label, $4 = fetch mode
    local status got encoding
    status="$(fetch "$1" "$TMP/got" "${4:-}")"
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
    encoding="$(content_encoding)"
    if [[ "$status" == 3* && "${4:-}" == navigate ]]; then
        echo "  ${3}: HTTP ${status} — the route redirects, so a browser opening this address does not get the shell from here" >>"$TMP/mismatches"
    elif [[ "$status" != "200" ]]; then
        echo "  ${3}: HTTP ${status}" >>"$TMP/mismatches"
    elif [[ "$got" == "$index_hash" && "$1" != "index.html" && "$1" != "" ]]; then
        # nginx answers a path it has no file for with the SPA shell and a 200, so a file that is
        # missing on the server looks like a different file unless it is named.
        echo "  ${3}: missing — the server answered with the SPA shell (index.html) instead" >>"$TMP/mismatches"
    elif [[ -n "$encoding" && "$encoding" != identity ]]; then
        # The bytes compared are the compressed ones, so they cannot match; say why instead of
        # sending the reader to diffoscope.
        echo "  ${3}: differs — the server compressed the answer (Content-Encoding: ${encoding}) despite" >>"$TMP/mismatches"
        echo "      Accept-Encoding: identity; a proxy in front of nginx? The compared bytes are the compressed ones." >>"$TMP/mismatches"
        echo "      expected ${2}" >>"$TMP/mismatches"
        echo "      served   ${got}" >>"$TMP/mismatches"
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
# What a browser gets for the root, and for every route, is the fallback document; it has to be
# the built index.html.
compare "" "$index_hash" "/ (index.html)" navigate
for route in "${ROUTES[@]}"; do
    compare "$route" "$index_hash" "/${route} (route → index.html)" navigate
done

checked=$((total + 1 + ${#ROUTES[@]}))
echo "match=${match}/${checked}"
if [[ "$match" -eq "$checked" ]]; then
    echo "✓ ${url} serves the build of ${commit} — ${total} files, / and ${#ROUTES[@]} routes are byte-identical"
    echo "  treeHash ${tree_hash} is the number this commit's CI run publishes."
    exit 0
fi

echo "✗ ${url} does not match the build of ${commit}:"
cat "$TMP/mismatches"
if [[ $((match + failed)) -eq "$checked" ]]; then
    echo "  ${failed} request(s) failed and nothing else differs — run it again; a network error is not a finding." >&2
    exit 2
fi
if [[ "$failed" -gt 0 ]]; then
    echo "  ${failed} request(s) failed — repeat the run for those; the differences above stand regardless." >&2
fi
echo "  Compare a pair with diffoscope (https://diffoscope.org) to see how they differ, and read" >&2
echo "  docs/verifying-the-build.md (\"When it does not match\")." >&2
exit 1
