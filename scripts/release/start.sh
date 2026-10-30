#!/usr/bin/env sh
# 在包目录内启动服务端：自动托管前端，默认 http://localhost:8080
cd "$(dirname "$0")" || exit 1
export STATIC_DIR="${STATIC_DIR:-apps/client/dist}"
export GAME_CONFIG="${GAME_CONFIG:-config/game.toml}"
export SERVER_CONFIG="${SERVER_CONFIG:-config/server.toml}"
export RUST_LOG="${RUST_LOG:-info}"
exec ./server "$@"
