#!/usr/bin/env bash
# Button UX gate — a blunt grep with an allow-list.
# A bare <button> is permitted only in the files listed above.
# It deliberately does not cover a <button inside a comment or a string — the diff is reviewed by
# hand.

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FAIL=0

is_button_allowlisted() {
    local file="$1"
    case "$file" in
        client/src/lib/core/ui/Button.svelte) return 0 ;;
        client/src/lib/modules/editor/ToolbarButton.svelte) return 0 ;;
        client/src/lib/modules/editor/popovers/*) return 0 ;;
        client/src/lib/core/ui/ThemePicker.svelte) return 0 ;;
        # Appearance theme cards — per-theme inline colors (path has (app)/[[tab]])
        *AppearanceSection.svelte) return 0 ;;
        client/src/lib/core/ui/UiZoomPicker.svelte) return 0 ;;
        client/src/lib/core/ui/ItemContextMenu.svelte) return 0 ;;
        client/src/lib/core/ui/SidebarAppMenu.svelte) return 0 ;;
        client/src/lib/modules/editor/NoteActionsMenu.svelte) return 0 ;;
        client/src/lib/modules/files/VirtualFiles.svelte) return 0 ;;
        client/src/lib/modules/files/dev/*) return 0 ;;
        client/src/lib/core/ui/dev/*) return 0 ;;
        client/src/routes/dev/*) return 0 ;;
    esac
    return 1
}

echo "▶ Button UX — a raw <button> outside the allow-list"
while IFS= read -r -d '' file; do
    if is_button_allowlisted "$file"; then
        continue
    fi
    if grep -nE '<button\b' "$file" >/dev/null 2>&1; then
        echo "  ✗ $file"
        grep -nE '<button\b' "$file" | head -5
        ((FAIL++)) || true
    fi
done < <(find client/src -name '*.svelte' -print0)

echo "▶ Button UX — a Dialog footer has to use DialogActions"
while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    if grep -qE '<Dialog\b|import Dialog from' "$file" && grep -q 'snippet footer' "$file"; then
        if ! grep -q 'DialogActions' "$file"; then
            echo "  ✗ $file (a Dialog + footer snippet with no DialogActions)"
            ((FAIL++)) || true
        fi
    fi
done < <(find client/src -name '*.svelte')

if [[ $FAIL -eq 0 ]]; then
    echo "✓ Button UX gate — OK"
    exit 0
fi

echo "✗ Button UX gate — $FAIL problem(a)"
exit 1