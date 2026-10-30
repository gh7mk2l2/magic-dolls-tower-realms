#!/usr/bin/env bash
# 把某个平台的 server/replay 二进制与前端、配置打成发布包。
# 用法: scripts/release/package.sh <版本> <target> <二进制目录> <dist目录> <输出目录>
# 产物: <输出目录>/magic-dolls-<版本>-<target>.tar.gz（Windows 为 .zip）
set -euo pipefail
VERSION="$1"; TARGET="$2"; BIN_DIR="$3"; DIST_DIR="$4"; OUT_DIR="$5"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EXE=""; [[ "$TARGET" == *windows* ]] && EXE=".exe"
NAME="magic-dolls-${VERSION}-${TARGET}"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
STAGE="$(mktemp -d)"
PKG="$STAGE/$NAME"
mkdir -p "$PKG/apps/client" "$PKG/logs"
install -m 755 "$BIN_DIR/server$EXE" "$PKG/server$EXE"
install -m 755 "$BIN_DIR/replay$EXE" "$PKG/replay$EXE"
cp -R "$ROOT/config" "$PKG/config"
cp -R "$DIST_DIR" "$PKG/apps/client/dist"
test -f "$PKG/apps/client/dist/index.html"
test -f "$PKG/apps/client/dist/sim.wasm"
sed -e "s/@VERSION@/$VERSION/g" -e "s/@TARGET@/$TARGET/g" "$ROOT/scripts/release/README.txt" > "$PKG/README.txt"
if [[ -n "$EXE" ]]; then
  cp "$ROOT/scripts/release/start.bat" "$PKG/start.bat"
  (cd "$STAGE" && rm -f "$OUT_DIR/$NAME.zip" && zip -qr "$OUT_DIR/$NAME.zip" "$NAME")
  echo "$OUT_DIR/$NAME.zip"
else
  install -m 755 "$ROOT/scripts/release/start.sh" "$PKG/start.sh"
  tar -C "$STAGE" -czf "$OUT_DIR/$NAME.tar.gz" "$NAME"
  echo "$OUT_DIR/$NAME.tar.gz"
fi
rm -rf "$STAGE"
