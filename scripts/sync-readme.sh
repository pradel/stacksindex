#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_README="$ROOT_DIR/README.md"
PACKAGE_README="$ROOT_DIR/packages/stacksindex/README.md"

if [ "${1:-}" = "--check" ]; then
  if ! cmp -s "$ROOT_README" "$PACKAGE_README"; then
    echo "packages/stacksindex/README.md is out of sync with README.md."
    echo "Run: vp run readme:sync"
    exit 1
  fi

  echo "README.md and packages/stacksindex/README.md are in sync."
  exit 0
fi

cp "$ROOT_README" "$PACKAGE_README"
echo "Copied README.md to packages/stacksindex/README.md."
