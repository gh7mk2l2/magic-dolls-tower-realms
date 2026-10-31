#!/usr/bin/env bash
# AI 对 AI 平衡批量模拟：并行跑 N 局全 AI 4v4，逐局写 JSONL 并汇总。
# 用法: scripts/balance.sh [总局数=400] [并行数=CPU 核数]
# 可选环境变量：BALANCE_CONFIG=<另一份 game.toml>  BALANCE_RESPAWN_CAP=<秒，试验复活上限>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
TOTAL="${1:-400}"
JOBS="${2:-$(nproc 2>/dev/null || echo 2)}"
OUT="logs/balance"
mkdir -p "$OUT"
rm -f "$OUT"/part-*.jsonl
cargo test -p sim --release --no-run >/dev/null
PER=$(( (TOTAL + JOBS - 1) / JOBS ))
for ((i = 0; i < JOBS; i++)); do
  BALANCE_MATCHES=$PER BALANCE_OFFSET=$((i * PER)) BALANCE_OUT="$OUT/part-$i.jsonl" \
    cargo test -p sim --release -q -- --ignored balance_report >/dev/null 2>&1 &
done
wait
python3 scripts/balance-agg.py "$OUT"/part-*.jsonl
