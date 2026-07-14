#!/usr/bin/env bash
# Re-vendor the Umber design system into packages/umber.
#
# Source of truth is github.com/DadJokez/umber-design-system, cloned locally at
# ~/design-system/umber. Never edit packages/umber sources directly — change
# the design system upstream (commit + push there), then re-run this script so
# Codex and Claude vendoring stay in lockstep.
set -euo pipefail

SRC="${UMBER_SRC:-$HOME/design-system/umber}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/packages/umber"

if [ ! -d "$SRC/tokens" ]; then
  echo "Umber design system not found at $SRC (set UMBER_SRC to override)" >&2
  exit 1
fi

mkdir -p "$DEST"
for dir in tokens components assets; do
  rsync -a --delete "$SRC/$dir/" "$DEST/$dir/"
done
cp "$SRC/styles.css" "$DEST/styles.css"
cp "$SRC/SKILL.md" "$DEST/SKILL.md"

echo "Vendored Umber from $SRC into $DEST"
echo "Upstream commit: $(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)"
