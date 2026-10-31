#!/usr/bin/env bash
# 把 sim crate 编译为浏览器单机模式使用的 sim.wasm
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
cargo build -p sim-wasm --target wasm32-unknown-unknown --profile wasm
mkdir -p apps/client/public
cp "${CARGO_TARGET_DIR:-target}/wasm32-unknown-unknown/wasm/sim_wasm.wasm" apps/client/public/sim.wasm
echo "sim.wasm -> apps/client/public/sim.wasm ($(du -h apps/client/public/sim.wasm | cut -f1))"
