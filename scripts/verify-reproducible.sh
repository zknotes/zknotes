#!/usr/bin/env bash
# Prove that the web client builds reproducibly: build docker/Dockerfile.web twice from the same
# source, in two separate directories and without the layer cache, and compare the web roots the two
# images would serve. Equal treeHash (scripts/tree-hash.sh) = byte-identical files.
#
# Usage:
#   scripts/verify-reproducible.sh [commit]   # a commit (default HEAD), built from `git archive`
#   scripts/verify-reproducible.sh --worktree # the working tree as it is, before a commit
#   scripts/verify-reproducible.sh --self-test [commit]
#                                             # the second build gets SOURCE_DATE_EPOCH + 1 and the
#                                             # script must report the difference — proof that the
#                                             # comparison measures something
#
# Inputs to the build, and the only ones: the source (filtered by .dockerignore), SOURCE_DATE_EPOCH
# (the commit's timestamp) and APP_COMMIT (the full commit hash). The canonical environment is the
# digest-pinned builder image in Dockerfile.web; a local `vite build` under Node is not covered.
#
# On success the last line is `TREE_HASH=<hash>`. Under GitHub Actions the result also goes to the
# job summary — a record of the hash that this repository's CI, not the operator, published.
#
# Exit code:
#   0 — the builds match (with --self-test: they differ, as they must)
#   1 — they do not (with --self-test: they match, so the check is blind)
#   2 — usage or environment error

set -euo pipefail
# A failing command inside $(…) must stop that subshell too; bash leaves errexit off there unless
# told otherwise (macOS' bash 3.2 does not know the option, and then the explicit checks below do
# the work).
shopt -s inherit_errexit 2>/dev/null || true

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TREE_HASH="${ROOT}/scripts/tree-hash.sh"
# The build itself (git archive → docker build → web root) lives in one place, shared with
# scripts/verify-live.sh.
# shellcheck source=lib-build-web.sh
source "${ROOT}/scripts/lib-build-web.sh"

self_test=0
worktree=0
ref=""
for arg in "$@"; do
    case "$arg" in
        --self-test) self_test=1 ;;
        --worktree) worktree=1 ;;
        -*) echo "unknown option: $arg" >&2; exit 2 ;;
        *) ref="$arg" ;;
    esac
done
if [[ "$worktree" == 1 && -n "$ref" ]]; then
    echo "--worktree and a commit are mutually exclusive" >&2
    exit 2
fi

check_build_tools || exit 2

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The source as a tree object. A commit is archived as is. The working tree goes through a temporary
# index, so tracked edits and untracked (not ignored) files are included and the real index is left
# alone; its timestamp and name come from HEAD, marked so the result is never mistaken for a commit.
if [[ "$worktree" == 1 ]]; then
    head="$(git -C "$ROOT" rev-parse HEAD)"
    GIT_INDEX_FILE="$TMP/index" git -C "$ROOT" read-tree HEAD
    GIT_INDEX_FILE="$TMP/index" git -C "$ROOT" add -A
    tree="$(GIT_INDEX_FILE="$TMP/index" git -C "$ROOT" write-tree)"
    app_commit="${head}-worktree"
    epoch="$(git -C "$ROOT" show -s --format=%ct "$head")"
else
    commit="$(git -C "$ROOT" rev-parse --verify "${ref:-HEAD}^{commit}")"
    tree="$commit"
    app_commit="$commit"
    epoch="$(git -C "$ROOT" show -s --format=%ct "$commit")"
fi

build() { # $1 = 1|2, $2 = SOURCE_DATE_EPOCH
    echo "▶ build $1 (SOURCE_DATE_EPOCH=$2) ..." >&2
    if ! build_web_root "$tree" "$app_commit" "$2" "$TMP/out-$1"; then
        echo "✗ build $1 failed — see the docker output above" >&2
        exit 2
    fi
    sh "$TREE_HASH" --list "$TMP/out-$1" >"$TMP/list-$1"
    sh "$TREE_HASH" "$TMP/out-$1"
}

epoch2="$epoch"
[[ "$self_test" == 1 ]] && epoch2=$((epoch + 1))

hash1="$(build 1 "$epoch")"
hash2="$(build 2 "$epoch2")"

echo "commit=${app_commit}"
echo "source_date_epoch=${epoch}"
echo "build_1=${hash1}"
echo "build_2=${hash2}"

if [[ "$hash1" == "$hash2" ]]; then
    if [[ "$self_test" == 1 ]]; then
        echo "✗ self-test: a different SOURCE_DATE_EPOCH gave the same treeHash — the check is blind" >&2
        exit 1
    fi
    echo "✓ reproducible: $(wc -l <"$TMP/list-1") files, byte-identical"
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
        {
            echo "### Reproducible web build"
            echo
            echo "| | |"
            echo "|---|---|"
            echo "| commit | \`${app_commit}\` |"
            echo "| SOURCE_DATE_EPOCH | \`${epoch}\` |"
            echo "| treeHash | \`${hash1}\` |"
        } >>"$GITHUB_STEP_SUMMARY"
    fi
    echo "TREE_HASH=${hash1}"
    exit 0
fi

if [[ "$self_test" == 1 ]]; then
    echo "✓ self-test: a different SOURCE_DATE_EPOCH changed the treeHash, as it must"
    exit 0
fi

echo "✗ NOT reproducible — files that differ between the two builds:" >&2
diff <(cut -c67- "$TMP/list-1") <(cut -c67- "$TMP/list-2") >&2 || true
join -1 2 -2 2 <(sort -k2 "$TMP/list-1") <(sort -k2 "$TMP/list-2") | awk '$2 != $3 { print "  changed: " $1 }' >&2
echo "Compare a pair with diffoscope (https://diffoscope.org) to see why." >&2
exit 1
