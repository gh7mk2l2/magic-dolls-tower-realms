# 魔法玩偶：塔域战争（Magic Dolls: Tower Realms War）

Web 端 2.5D 俯视角多人在线 MOBA-lite。客户端 **TypeScript + Phaser 3 + WebSocket**，服务端 **Rust（tokio + axum + hecs + MessagePack）**，PostgreSQL 持久化战绩、Redis 缓存排行榜。所有伤害、毒区结算、刷怪、流场寻路、胜负判定都在服务端模拟，客户端只上报输入并做预测/插值。

单机模式把**同一份 Rust 模拟**编译成 WebAssembly 在浏览器里运行，所以单机与联网的规则永远一致。

---

## 一键部署（Docker Compose）

```bash
docker compose up -d --build
# 打开 http://localhost:8080
```

会启动 3 个容器：`game`（Rust 服务端 + 前端静态文件 + sim.wasm）、`postgres`、`redis`。`config/` 以只读方式挂载进容器，改完数值执行 `docker compose restart game` 即可生效；对局日志写到 `./logs/`。

## 本地开发

需要 Rust 1.87+（含 `wasm32-unknown-unknown` 目标，脚本会自动添加）、Node.js 22+。

```bash
npm run setup        # 安装前端依赖 + 编译 sim.wasm
npm run dev          # 同时启动 cargo run -p server 与 Vite（http://localhost:5173）
```

Vite 会把 `/ws`、`/api` 代理到 `localhost:8080`。不启动服务端也可以直接点「单机演练」。

需要 PG/Redis 时：`docker compose up -d postgres redis`，然后 `cp .env.example .env` 并导出其中变量（或写进 `config/server.toml`）。两者都可选，连接失败只会打印警告并退回内存模式。

生产构建：`npm run build`，然后 `npm start`（axum 直接托管 `apps/client/dist`）。

## 操作

| 操作 | 键鼠 | 触屏 |
| --- | --- | --- |
| 移动 | WASD / 方向键 | 左下虚拟摇杆 |
| 瞄准 | 鼠标 | 自动瞄准最近敌人 |
| 普攻 | 按住鼠标左键（打击瞄准点附近的敌人） | 按住 ⚔ |
| 技能 | Q / E / R（或 1 / 2 / 3） | 点技能图标 |
| 战况表 | 按住 Tab | — |

> 原需求里技能键与 WASD 的 W 冲突，所以技能改成了 **Q / E / R**。

## 玩法实现对照

| 需求 | 实现 |
| --- | --- |
| 红/蓝各 2~4 人，各有 1 基地 + 2 魔法塔 | `max_team_size = 4`，人数不足时 AI 魔法玩偶补到 `ai_fill_to`；玩家加入会顶替 AI |
| 3 个可选魔法玩偶，移动/普攻/3 技能 | 星语术士（伤害/眩晕/新星）、月影游侠（伤害/位移/减速）、晨曦守卫（新星/冲锋/群疗），技能效果全由配置驱动 |
| 死亡后复活 | `respawn_seconds`（默认 3 秒，设为 0 即刻复活），在基地复活 |
| 两塔全毁基地才可被攻击 | 基地护盾 `INVULNERABLE`，HUD/画面显示护盾光罩 |
| 毒区：进入敌方塔辐射区每满 1 秒掉血，离开停止，塔毁后永久消失 | 毒区是独立的 ECS 实体（`PoisonZone`），跟随塔一起移除；英雄各自计时 |
| 每座塔每 30 秒产一批变异魔兽，沿路径进攻 | 每座存活塔各出一批，用以敌方基地为终点的 **64×64 流场**（8 方向 Dijkstra，绕开岩石）寻路，遇敌脱离流场接战 |
| 波次成长 | `hp/damage/speed_growth` 线性成长+上限，或填 `hp_curve` 显式曲线 |
| 15 分钟超时死斗 | 双方每座存活魔法塔孕育「超级双头变异魔兽」（免疫控制、无视一切、无视护盾直攻基地），被杀 45 秒后再孕育；死斗 4 分钟仍未分胜负时按基地剩余血量百分比判定 |
| 结算 | 胜负、击杀比分、摧毁塔数、每名玩家 K/D/伤害；写入 PG，胜场写入 Redis 排行榜 |

额外加了**基地防御魔晶**（`[base] damage/range`），避免出生点被蹲守、复活即阵亡；不需要可设 `damage = 0`。

## 架构

```text
crates/shared/    协议结构体（MessagePack），apps/client/src/protocol.ts 与之一一对应
crates/sim/       纯逻辑模拟，无 IO：hecs ECS、流场、技能、AI、规则测试
crates/sim-wasm/  sim 的 C ABI 导出（无 wasm-bindgen 依赖），供浏览器单机模式
crates/server/    axum 接入、房间注册表、房间 task、对局日志、PG/Redis 存储、replay 工具
apps/client/      Phaser 场景、HUD、小地图、预测/插值、断线重连、WebAudio 音效
config/           game.toml（全部数值）、server.toml（网络/存储）
```

**并发模型（没有任何全局锁）**

- **注册表**是一个 task：按房间名查找或创建房间，房间结束后下架；同名会创建新房间。横向扩展时可替换为按房间名路由到不同节点。
- **每个房间一个 task**，独占 `Simulation`，`tokio::time::interval` 20Hz 推进。连接通过 `mpsc` 投递 `Join/Input/Resync/Disconnect/Leave`；每个 tick 只编码一次快照，通过 `broadcast` 发给所有连接；个别连接的全量重同步走它自己的 `mpsc`。
- **存储**和**日志写盘**也各自是 task，房间只做非阻塞 `try_send`，IO 永远不会拖慢 tick。
- 连接层做了消息大小上限、每秒 60 条限流、20 秒空闲超时；房间输入队列满时丢帧而不是阻塞。

**同步策略**

- 20Hz 快照；每 20 tick 一次全量关键帧，其余是**增量**（只发与上次相比有变化的实体 + 删除列表，坐标量化到 0.1）。静止世界的增量快照为空。
- 客户端：远端实体 100ms 延迟插值（按服务端 tick 建时间轴，抗抖动）；本地玩偶**输入预测 + 服务端校正回滚**：服务端逐 tick 消费一帧输入并在快照里回传 `acks`，客户端回到权威位置重放未确认的输入，残差再做 90ms 平滑。客户端的碰撞网格与滑墙规则与 Rust 完全一致（有跨语言测试验证误差 < 0.5px）。
- 断线：AI 立即托管英雄；客户端指数退避重连，携带 token 在 `reconnect_seconds`（30 秒）内恢复原英雄，输入序号延续。广播滞后时自动请求全量同步。

## 数值调优

全部在 `config/game.toml`：地图与时限、基地/塔血量与攻击、毒区半径/伤害、兵波数量与成长曲线、超级魔兽属性与死斗时长、英雄属性、每个技能（效果、冷却、伤害、射程、半径、持续、数值）、地图阻挡矩形。服务端启动时加载并校验（缺技能、尺寸非法会直接报错），浏览器单机模式内置同一份文件（改完需 `npm run build:wasm`）。

## 对局日志 / 回放 / 分析

每个房间写一个 `logs/<时间戳>-<房间>-<id>.jsonl`：header（含完整数值配置原文）、玩家加入/断线/重连、**每一帧被接受的输入**、关键事件、每 5 秒态势采样、结算。

```bash
npm run replay -- logs/xxx.jsonl            # 分析报告：塔陨落时间、死斗时间、阵亡、每人 K/D/伤害
npm run replay -- logs/xxx.jsonl --verify   # 用日志里的配置和输入重新模拟，校验结果与线上完全一致
```

模拟是确定性的（固定种子、所有遍历按 ID 排序），所以日志就是可回放录像。

## API

| 路径 | 说明 |
| --- | --- |
| `GET /ws` | 对局 WebSocket（二进制 MessagePack） |
| `GET /api/health` | 状态、协议版本、PG/Redis 是否连接 |
| `GET /api/rooms` | 房间列表、人数、阶段、剩余时间 |
| `GET /api/leaderboard` | 胜场榜（Redis → PG → 内存，依次回退） |
| `GET /api/recent` | 最近对局 |
| `GET /api/map` | 地图与英雄技能信息 |

## 测试

```bash
./scripts/test.sh   # fmt、clippy、Rust 全部测试、编译 wasm、前端测试与构建
```

- `sim`：布局、流场绕障、AI 补位与托管、自动分队与满员、确定性回放、输入队列与确认、英雄撞墙、基地护盾与胜负、复活、毒区计时（己方不伤、离开即停）、塔毁毒区消失、兵波按塔生成与成长、魔兽推进、增量快照、技能伤害/眩晕/冷却、超级魔兽免控与限时结束、死斗超时判定、非法输入、4v4 全 AI 对局能完整结束。
- `server`：真实 axum 服务 + WebSocket 客户端端到端：加入、全量/增量快照、输入确认、Ping/Pong、断线 token 重连、协议版本与房间名校验。
- `client`：协议编解码、增量合并、插值、滑墙预测，以及在 Node 中加载 `sim.wasm` 的跨语言测试（协议一致 + 预测与权威位置误差 < 0.5px）。

## 美术资源

`apps/client/public/sprites/` 下 18 张精灵图（红蓝双方英雄/塔/基地/魔兽/超级魔兽，以及地面、树、岩石、水晶）由 agnes-image-2.5-flash 生成，再抠图、缩放到原纹理尺寸。文件名就是纹理键名，缺失或加载失败时自动回退到 `textures.ts` 里的程序化占位图。重新生成：`OPENAI_BASE`（OpenAI 兼容接口）可用时运行 `python3 scripts/gen-sprites.py` 生成原图到 `art-raw/`，再运行 `python3 scripts/process-sprites.py`（需 numpy、scipy、Pillow）。

## 接入 3D 模型

渲染与玩法完全分离：所有占位美术都在 `apps/client/src/textures.ts` 里程序化生成，纹理键名为 `hero-<英雄>-<阵营>`、`tower-<阵营>`、`base-<阵营>`、`minion-<阵营>`、`super-<阵营>`。拿到 3D 模型后，最省事的做法是离线渲染成 8 方向/多帧精灵图，在 `BattleScene.preload` 里用同名键加载即可替换；如果要实时 3D，可以只替换 `scene.ts` 的 `createView/renderEntity`，网络、预测、HUD 都不用动。

## 许可

代码 MIT。所有美术、粒子、音效都是程序化生成的占位内容，不依赖任何付费引擎或素材（Phaser 3 为 MIT 许可）。
