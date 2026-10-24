#!/usr/bin/env bash
# The one place that builds the web root from a tree. scripts/verify-reproducible.sh and
# scripts/verify-live.sh both `source` this file; neither carries a copy of the build, so the two
# cannot quietly build differently and compare different things.
#
#   build_web_root <tree-ish> <app_commit> <source_date_epoch> <out_dir>
#
# Archives <tree-ish> from this repository into a fresh directory next to <out_dir>, builds
# docker/Dockerfile.web there without the layer cache, copies the web root the image would serve
# (/usr/share/nginx/html) to <out_dir>, and removes the image and the archive again. <out_dir> must
# not exist yet. The exit status is the first failing step's.
#
# The inputs to the bytes, and the only ones: the tree (filtered by .dockerignore), APP_COMMIT and
# SOURCE_DATE_EPOCH. The canonical build environment is the digest-pinned builder image in
# Dockerfile.web — a local `vite build` under Node is not covered.
#
#   check_build_tools
#
# Prints what is missing (docker, git, tar, a sha256 tool) and returns 1; the callers turn that
# into exit 2.
#
#   sha256_file <file>
#
# The file's sha256 as 64 hex characters, with `sha256sum` (coreutils, BusyBox) or `shasum -a 256`
# (macOS ships only the latter). scripts/tree-hash.sh carries the same two lines on its own, because
# it is POSIX sh and runs inside the nginx image where nothing is sourced.

LIB_BUILD_WEB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

check_build_tools() {
    local tool missing=0
    for tool in docker git tar; do
        if ! command -v "$tool" >/dev/null 2>&1; then
            echo "$tool is required" >&2
            missing=1
        fi
    done
    if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
        echo "sha256sum (or shasum) is required" >&2
        missing=1
    fi
    return "$missing"
}

sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    else
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

build_web_root() {
    local tree="$1" app_commit="$2" epoch="$3" out="$4"
    local ctx tag cid="" status=0
    # A fresh, randomly named directory per build, next to the output: the checkout path must not
    # reach the bytes either, and the caller's cleanup of its temp directory takes it along.
    ctx="$(mktemp -d "$(dirname "$out")/source-XXXXXX")"
    tag="zknotes-web-build-$$-$RANDOM"
    # --no-cache: a cached layer would make a second build match the first by construction, which
    # proves nothing.
    # No end-of-line conversion on the way out, whatever the verifier's git is configured to do:
    # .gitattributes says the same for a checkout, and this covers a clone made before it existed.
    if git -C "$LIB_BUILD_WEB_ROOT" -c core.autocrlf=false -c core.eol=lf archive "$tree" | tar -x -C "$ctx" \
        && docker build --no-cache -q \
            -f "$ctx/docker/Dockerfile.web" \
            --build-arg "APP_COMMIT=${app_commit}" \
            --build-arg "SOURCE_DATE_EPOCH=${epoch}" \
            -t "$tag" "$ctx" >/dev/null \
        && cid="$(docker create "$tag")" \
        && docker cp "$cid:/usr/share/nginx/html" "$out" >/dev/null; then
        status=0
    else
        status=$?
    fi
    [[ -n "$cid" ]] && docker rm "$cid" >/dev/null 2>&1
    docker rmi -f "$tag" >/dev/null 2>&1 || true
    rm -rf "$ctx"
    return "$status"
}
