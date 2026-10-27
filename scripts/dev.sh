#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[[ -d node_modules ]] || npm install
[[ -d apps/client/node_modules ]] || npm install --prefix apps/client
[[ -f apps/client/public/sim.wasm ]] || bash scripts/build-wasm.sh
npm run dev
