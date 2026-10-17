#!/usr/bin/env bash
# A smoke test: check the security headers on the web origin.
# A manual check against a live instance (./scripts/smoke-headers.sh https://notes.example.com).
# Note: the gate does NOT call it — `.github/workflows/ci.yml` runs check.sh and test.sh only.
#
# Exit code:
#   0 — every required header is present
#   1 — one or more headers are missing
#
# Note: you can run this against a local server while the dev stack is up:
#   ./scripts/smoke-headers.sh http://localhost:8080

set -euo pipefail

TARGET="${1:-https://notes.example.com}"

echo "▶ Fetching the headers from ${TARGET} ..."
HEADERS=$(curl -sI --max-time 10 "${TARGET}")

FAILED=0

check_header() {
    local name="$1"
    local expected="$2"
    # Search case-insensitively (HTTP/2 headers are lowercase)
    if echo "${HEADERS}" | grep -qi "${expected}"; then
        echo "  ✓ ${name}"
    else
        echo "  ✗ MISSING: ${name} (looked for: ${expected})"
        FAILED=1
    fi
}

# ── The required security headers ──────────────────────────────────────────
# Production: an enforcing CSP from web/nginx (script-src 'self' + the sha256 hashes of the SvelteKit
# bootstrap). Report-Only without enforcement is not enough.
if echo "${HEADERS}" | grep -qi "content-security-policy:.*script-src 'self'"; then
    if echo "${HEADERS}" | grep -qi "content-security-policy:.*sha256-"; then
        echo "  ✓ Content-Security-Policy (script-src 'self' + sha256 — enforce)"
    else
        echo "  ✓ Content-Security-Policy (script-src 'self' — enforced; no sha256 — fine if the shell has no inline scripts)"
    fi
    if echo "${HEADERS}" | grep -qi "content-security-policy:.*script-src[^;]*'unsafe-inline'"; then
        echo "  ✗ CSP script-src carries 'unsafe-inline' (not allowed for the app shell)"
        FAILED=1
    fi
else
    echo "  ✗ MISSING: Content-Security-Policy with script-src 'self' (enforcing)"
    FAILED=1
fi

check_header "Cross-Origin-Opener-Policy: same-origin" "cross-origin-opener-policy.*same-origin"
check_header "Strict-Transport-Security"                "strict-transport-security"
check_header "X-Content-Type-Options: nosniff"         "x-content-type-options.*nosniff"
check_header "frame-ancestors 'none' (in CSP)"          "frame-ancestors 'none'"

# ── Every page: Referrer-Policy no-referrer ───────────────────────────────────
# The page address names the open note, so any other policy sends it along with every request.
if echo "${HEADERS}" | grep -qiE "^referrer-policy: *no-referrer[[:space:]]*$"; then
    echo "  ✓ Referrer-Policy: no-referrer"
else
    echo "  ✗ Referrer-Policy is not exactly no-referrer:"
    echo "${HEADERS}" | grep -i "^referrer-policy:" | sed 's/^/      /'
    FAILED=1
fi

# ── A share page: one Referrer-Policy, and it is no-referrer ──────────────────
# The proxy has to replace the web container's policy on /s/*, not add a second header (the browser
# applies the last one).
SHARE_HEADERS=$(curl -sI --max-time 10 "${TARGET%/}/s/smoke-check")
REFERRER_POLICIES=$(echo "${SHARE_HEADERS}" | grep -ci "^referrer-policy:" || true)
if [ "${REFERRER_POLICIES}" -eq 1 ] && echo "${SHARE_HEADERS}" | grep -qiE "^referrer-policy: *no-referrer[[:space:]]*$"; then
    echo "  ✓ /s/*: exactly one Referrer-Policy, no-referrer"
else
    echo "  ✗ /s/*: expected exactly one 'Referrer-Policy: no-referrer', got ${REFERRER_POLICIES}:"
    echo "${SHARE_HEADERS}" | grep -i "^referrer-policy:" | sed 's/^/      /'
    FAILED=1
fi

echo ""
if [ "${FAILED}" -eq 0 ]; then
    echo "✅ Every required security header is present."
    exit 0
else
    echo "❌ One or more header checks failed."
    exit 1
fi
