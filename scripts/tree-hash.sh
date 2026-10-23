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

set -eu

list=0
if [ "${1:-}" = "--list" ]; then
    list=1
    shift
fi
dir="${1:?usage: tree-hash.sh [--list] <dir>}"
cd "$dir"

# One sha256sum per file rather than xargs, so a path with a space stays one path.
listing() {
    find . -type f | LC_ALL=C sort | while IFS= read -r f; do
        sha256sum "$f"
    done
}

if [ "$list" = 1 ]; then
    listing
else
    listing | sha256sum | cut -d' ' -f1
fi
