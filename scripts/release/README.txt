魔法玩偶：塔域战争 (Magic Dolls: Tower Realms War) @VERSION@ — @TARGET@

目录内容
  server / server.exe   游戏服务端（同时托管网页前端与 sim.wasm）
  replay / replay.exe   对局日志回放工具：replay <logs/xxx.jsonl>
  config/               server.toml（端口、数据库等）与 game.toml（数值）
  apps/client/dist/     已构建的网页前端（含单机模式 sim.wasm）
  start.sh / start.bat  启动脚本（会先切到本目录，再设置 STATIC_DIR 等变量）

启动
  Linux / macOS:  ./start.sh
  Windows:        双击 start.bat（或在 PowerShell 中运行 .\start.bat）
  然后浏览器打开 http://localhost:8080

  macOS 首次运行若提示“无法验证开发者”，执行：
    xattr -dr com.apple.quarantine .

常用环境变量（也可直接改 config/server.toml）
  PORT=8080                    监听端口
  HOST=0.0.0.0                 监听地址
  STATIC_DIR=apps/client/dist  前端目录（相对当前工作目录）
  GAME_CONFIG=config/game.toml 数值配置
  LOG_DIR=logs                 JSONL 对局日志目录
  DATABASE_URL=postgres://...  可选：PostgreSQL 战绩持久化（留空为内存模式）
  REDIS_URL=redis://...        可选：Redis 排行榜缓存（留空为内存模式）

示例：PORT=9000 ./start.sh

注意：直接运行 ./server 时，config/ 与 apps/client/dist 按“当前工作目录”解析，
请先 cd 到本目录，或用 start 脚本启动。
