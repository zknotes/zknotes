#!/bin/sh
# The one definition of `treeHash`: a single sha256 over every file in a directory — its path and its
# content. Two web roots with the same treeHash serve the same bytes.
#
# Usage:
#   scripts/tree-hash.sh <dir>          # prints the treeHash
#   scripts/tree-hash.sh --list <dir>   # prints "sha256  ./path" per file (the input to the hash)
#
# It is POSIX sh on purpose: the deploy runs it inside the nginx image (BusyBox), the reproducibility
# check and CI run it on a full Linux. Every caller uses this file instead of repeating the pipeline,
# so the hash cannot quietly mean two different things. `LC_ALL=C` is not decoration — the locale
# changes the sort order, and with it the hash.
#
# A file that cannot be read is an error, not a shorter list: the listing is written out first and
# checked, and only then hashed. POSIX sh has no pipefail, so a pipeline straight into sha256sum
# would print a hash over whatever the loop managed to read and exit 0.

set -eu

list=0
if [ "${1:-}" = "--list" ]; then
    list=1
    shift
fi
dir="${1:?usage: tree-hash.sh [--list] <dir>}"
cd "$dir"

# sha256sum (coreutils, BusyBox) or shasum -a 256 (macOS). scripts/lib-build-web.sh has the same
# choice for the bash scripts; it is repeated here because this file is sourced by nothing and runs
# where nothing else of the repository is present.
sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1"
    else
        shasum -a 256 "$1"
    fi
}

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

# One sha256 per file rather than xargs, so a path with a space stays one path. The loop runs in a
# subshell (it is the tail of a pipeline), so its exit status is checked through the `||` and the
# line count rather than through set -e.
find . -type f | LC_ALL=C sort | {
    while IFS= read -r f; do
        sha256_of "$f" || exit 1
    done
} >"$tmp" || {
    echo "tree-hash.sh: a file in $dir could not be read" >&2
    exit 1
}
expected="$(find . -type f | wc -l | tr -d ' ')"
got="$(wc -l <"$tmp" | tr -d ' ')"
if [ "$expected" != "$got" ]; then
    echo "tree-hash.sh: listed $got of $expected files in $dir" >&2
    exit 1
fi
# A web root always has at least index.html; an empty listing means `find` failed or the wrong
# directory was given, and the hash of nothing must not pass for a hash of something.
if [ "$got" = 0 ]; then
    echo "tree-hash.sh: no files in $dir" >&2
    exit 1
fi

if [ "$list" = 1 ]; then
    cat "$tmp"
else
    sha256_of "$tmp" | cut -d' ' -f1
fi
