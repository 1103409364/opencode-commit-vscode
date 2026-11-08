#!/bin/sh
# Install (copy) this folder as a local VS Code extension.
# Re-run after editing the source, then "Developer: Reload Window".
set -e

SRC="$(cd "$(dirname "$0")" && pwd)"
EXT_ID="opencode.opencode-commit-message"
VERSION="$(node -p "require('$SRC/package.json').version")"

if [ -n "$VSCODE_EXTENSIONS_DIR" ]; then
  TARGET_ROOT="$VSCODE_EXTENSIONS_DIR"
elif [ -d "$HOME/.vscode-insiders/extensions" ]; then
  TARGET_ROOT="$HOME/.vscode-insiders/extensions"
else
  TARGET_ROOT="$HOME/.vscode/extensions"
fi

DEST="$TARGET_ROOT/$EXT_ID-$VERSION"
mkdir -p "$TARGET_ROOT"
rm -rf "$DEST"
mkdir -p "$DEST"
cp "$SRC/package.json" "$SRC/extension.js" "$SRC/README.md" "$DEST/"

echo "Installed $EXT_ID@$VERSION"
echo "  -> $DEST"
echo
echo 'Reload VS Code: Ctrl+Shift+P -> "Developer: Reload Window"'
echo "Then open the Source Control view and use the sparkle button (or Ctrl+Alt+G)."
