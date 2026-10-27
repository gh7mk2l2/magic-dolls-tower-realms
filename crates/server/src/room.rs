//! 房间即任务：每个对局一个 tokio task，独占 `Simulation`，20Hz 定时推进。
//! - 输入：连接通过 `mpsc` 投递 [`RoomCommand`]。
//! - 输出：每 tick 编码一次快照，通过 `broadcast` 分发给所有连接（编码只做一次）；
//!   个别连接需要的全量同步通过它自己的 `mpsc` 直发。

use crate::config::ServerConfig;
use crate::matchlog::MatchLog;
use crate::registry::{RegistryHandle, RoomHandle};
use crate::storage::StorageHandle;
use bytes::Bytes;
use serde::Serialize;
use shared::{encode, InputFrame, JoinRequest, Phase, ServerMessage, Welcome, TICK_RATE};
use sim::{GameConfig, Simulation};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::time::MissedTickBehavior;

#[derive(Clone)]
pub struct RoomContext {
    pub game: Arc<GameConfig>,
    pub server: Arc<ServerConfig>,
    pub storage: StorageHandle,
}

pub struct JoinAccepted {
    pub player_id: u64,
    pub welcome: Bytes,
    pub initial: Bytes,
    pub snapshots: broadcast::Receiver<Bytes>,
}

pub enum RoomCommand {
    Join {
        request: JoinRequest,
        conn_id: u64,
        direct: mpsc::Sender<Bytes>,
        reply: oneshot::Sender<Result<JoinAccepted, String>>,
    },
    Input {
        player_id: u64,
        frame: InputFrame,
    },
    Resync {
        player_id: u64,
    },
    Disconnect {
        player_id: u64,
        conn_id: u64,
    },
    Leave {
        player_id: u64,
    },
    Info {
        reply: oneshot::Sender<RoomInfo>,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct RoomInfo {
    pub id: u64,
    pub name: String,
    pub players: usize,
    pub connected: usize,
    pub red_heroes: usize,
    pub blue_heroes: usize,
    pub phase: String,
    pub remaining: u32,
}

struct PlayerSlot {
    token: String,
    conn_id: Option<u64>,
    direct: Option<mpsc::Sender<Bytes>>,
    disconnected_at: Option<Instant>,
}

struct Room {
    id: u64,
    name: String,
    ctx: RoomContext,
    registry: RegistryHandle,
    sim: Simulation,
    players: HashMap<u64, PlayerSlot>,
    tokens: HashMap<String, u64>,
    next_player_id: u64,
    broadcast: broadcast::Sender<Bytes>,
    ticks_since_full: u32,
    empty_since: Option<Instant>,
    ended_at: Option<Instant>,
    log: MatchLog,
    created: Instant,
}

pub fn spawn_room(id: u64, name: String, ctx: RoomContext, registry: RegistryHandle) -> RoomHandle {
    let (tx, rx) = mpsc::channel(1024);
    let (broadcast, _) = broadcast::channel(64);
    let log = MatchLog::open(&ctx.server.log_dir, &name, id, &ctx.game);
    let room = Room {
        id,
        name: name.clone(),
        sim: Simulation::new((*ctx.game).clone()),
        ctx,
        registry,
        players: HashMap::new(),
        tokens: HashMap::new(),
        next_player_id: 1,
        broadcast,
        ticks_since_full: 0,
        empty_since: Some(Instant::now()),
        ended_at: None,
        log,
        created: Instant::now(),
    };
    tokio::spawn(room.run(rx));
    RoomHandle { id, name, tx }
}

impl Room {
    async fn run(mut self, mut rx: mpsc::Receiver<RoomCommand>) {
        let mut ticker = tokio::time::interval(Duration::from_millis(1000 / u64::from(TICK_RATE)));
        ticker.set_missed_tick_behavior(MissedTickBehavior::Burst);
        loop {
            tokio::select! {
                biased;
                _ = ticker.tick() => {
                    if !self.tick() {
                        break;
                    }
                }
                command = rx.recv() => match command {
                    Some(command) => self.handle(command),
                    None => break,
                },
            }
        }
        self.registry.unlist(self.name.clone(), self.id);
        self.log.close();
        tracing::info!(room = %self.name, id = self.id, uptime = ?self.created.elapsed(), "房间关闭");
    }

    fn handle(&mut self, command: RoomCommand) {
        match command {
            RoomCommand::Join {
                request,
                conn_id,
                direct,
                reply,
            } => {
                let result = self.join(request, conn_id, direct);
                let _ = reply.send(result);
            }
            RoomCommand::Input { player_id, frame } => {
                let tick = self.sim.tick();
                if self.sim.set_input(player_id, frame.clone()) {
                    self.log.input(tick, player_id, &frame);
                }
            }
            RoomCommand::Resync { player_id } => self.send_full(player_id),
            RoomCommand::Disconnect { player_id, conn_id } => {
                if let Some(slot) = self.players.get_mut(&player_id) {
                    if slot.conn_id == Some(conn_id) {
                        slot.conn_id = None;
                        slot.direct = None;
                        slot.disconnected_at = Some(Instant::now());
                        self.sim.set_disconnected(player_id, true);
                        self.log.record(
                            self.sim.tick(),
                            "disconnect",
                            serde_json::json!({ "player": player_id }),
                        );
                        tracing::info!(room = %self.name, player_id, "玩家断线，AI 托管");
                    }
                }
            }
            RoomCommand::Leave { player_id } => self.remove(player_id, "leave"),
            RoomCommand::Info { reply } => {
                let _ = reply.send(self.info());
            }
        }
    }

    fn join(
        &mut self,
        request: JoinRequest,
        conn_id: u64,
        direct: mpsc::Sender<Bytes>,
    ) -> Result<JoinAccepted, String> {
        if request.version != shared::PROTOCOL_VERSION {
            return Err(format!(
                "协议版本不匹配：客户端 v{}，服务端 v{}，请刷新页面",
                request.version,
                shared::PROTOCOL_VERSION
            ));
        }
        if self.sim.is_over() {
            return Err("该房间对局已结束".into());
        }
        // 断线重连：携带有效 token 时恢复原英雄。
        let reconnect = request
            .token
            .as_ref()
            .and_then(|t| self.tokens.get(t).copied())
            .filter(|id| self.players.contains_key(id));
        let (player_id, token) = if let Some(player_id) = reconnect {
            let slot = self.players.get_mut(&player_id).expect("checked");
            slot.conn_id = Some(conn_id);
            slot.direct = Some(direct);
            slot.disconnected_at = None;
            self.sim.set_disconnected(player_id, false);
            self.log.record(
                self.sim.tick(),
                "reconnect",
                serde_json::json!({ "player": player_id }),
            );
            tracing::info!(room = %self.name, player_id, "玩家重连");
            (player_id, slot.token.clone())
        } else {
            let player_id = self.next_player_id;
            self.next_player_id += 1;
            let tick = self.sim.tick();
            let (_, team) = self
                .sim
                .add_player(player_id, &request.name, request.team, request.hero)
                .map_err(|e| e.to_string())?;
            if let Some(team_name) = request.team_name.as_deref() {
                self.sim.set_team_name(team, team_name);
            }
            let token = new_token();
            self.tokens.insert(token.clone(), player_id);
            self.players.insert(
                player_id,
                PlayerSlot {
                    token: token.clone(),
                    conn_id: Some(conn_id),
                    direct: Some(direct),
                    disconnected_at: None,
                },
            );
            self.log.record(
                tick,
                "join",
                serde_json::json!({
                    "player": player_id, "name": request.name, "team": team,
                    "requested_team": request.team, "hero": request.hero,
                    "team_name": request.team_name
                }),
            );
            tracing::info!(room = %self.name, player_id, ?team, hero = ?request.hero, "玩家加入");
            (player_id, token)
        };
        self.empty_since = None;
        let entity_id = self.sim.player_entity(player_id).unwrap_or(0);
        let team = self.sim.player_team(player_id).unwrap_or(shared::Team::Red);
        let welcome = Welcome {
            player_id,
            entity_id,
            team,
            room: self.name.clone(),
            token,
            tick_rate: TICK_RATE,
            map: self.sim.map_info(),
        };
        let welcome = Bytes::from(
            encode(&ServerMessage::Welcome(Box::new(welcome))).map_err(|e| e.to_string())?,
        );
        let initial = Bytes::from(
            encode(&ServerMessage::Snapshot(self.sim.peek_full())).map_err(|e| e.to_string())?,
        );
        Ok(JoinAccepted {
            player_id,
            welcome,
            initial,
            snapshots: self.broadcast.subscribe(),
        })
    }

    fn send_full(&mut self, player_id: u64) {
        let Some(direct) = self.players.get(&player_id).and_then(|s| s.direct.clone()) else {
            return;
        };
        if let Ok(bytes) = encode(&ServerMessage::Snapshot(self.sim.peek_full())) {
            let _ = direct.try_send(Bytes::from(bytes));
        }
    }

    fn remove(&mut self, player_id: u64, reason: &str) {
        if let Some(slot) = self.players.remove(&player_id) {
            self.tokens.remove(&slot.token);
            self.sim.remove_player(player_id);
            self.log.record(
                self.sim.tick(),
                reason,
                serde_json::json!({ "player": player_id }),
            );
            tracing::info!(room = %self.name, player_id, reason, "玩家移出房间");
        }
    }

    /// 返回 false 表示房间应当关闭。
    fn tick(&mut self) -> bool {
        let now = Instant::now();
        // 断线超过保留期的玩家移出对局。
        let reconnect = Duration::from_secs(self.ctx.server.reconnect_seconds);
        let expired: Vec<u64> = self
            .players
            .iter()
            .filter(|(_, s)| {
                s.disconnected_at
                    .map(|t| now - t > reconnect)
                    .unwrap_or(false)
            })
            .map(|(&id, _)| id)
            .collect();
        for id in expired {
            self.remove(id, "timeout");
        }
        let connected = self
            .players
            .values()
            .filter(|s| s.conn_id.is_some())
            .count();
        if connected == 0 {
            let since = *self.empty_since.get_or_insert(now);
            if now - since > Duration::from_secs(self.ctx.server.idle_room_seconds) {
                return false;
            }
        } else {
            self.empty_since = None;
        }
        if let Some(ended) = self.ended_at {
            // 结束后保留一段时间供观战与结算展示。
            return !(connected == 0 || now - ended > Duration::from_secs(120));
        }
        // 无人连接时暂停模拟，节省 CPU（断线保留期内仍推进，让 AI 托管）。
        let anyone = !self.players.is_empty();
        if !anyone {
            return true;
        }
        let was_over = self.sim.is_over();
        self.sim.step();
        self.ticks_since_full += 1;
        let full = self.ticks_since_full >= self.ctx.server.full_snapshot_interval;
        if full {
            self.ticks_since_full = 0;
        }
        let snapshot = self.sim.snapshot(full);
        self.log.events(snapshot.tick, &snapshot.events);
        let sample = snapshot.tick.is_multiple_of(TICK_RATE * 5);
        match encode(&ServerMessage::Snapshot(snapshot)) {
            Ok(bytes) => {
                // 没有订阅者时 send 返回 Err，可以忽略。
                let _ = self.broadcast.send(Bytes::from(bytes));
            }
            Err(error) => tracing::error!(%error, "快照编码失败"),
        }
        if sample {
            self.log.stats(&self.sim.peek_full());
        }
        if !was_over && self.sim.is_over() {
            self.on_match_end();
        }
        true
    }

    fn on_match_end(&mut self) {
        self.ended_at = Some(Instant::now());
        let summary = self.sim.summary();
        tracing::info!(room = %self.name, winner = ?summary.winner, ticks = summary.ticks, "对局结束");
        self.log.summary(&summary);
        self.ctx.storage.record(self.name.clone(), summary.clone());
        if let Ok(bytes) = encode(&ServerMessage::MatchEnd(summary)) {
            let _ = self.broadcast.send(Bytes::from(bytes));
        }
        // 结束的房间不再接受新玩家；同名新房间会重新创建。
        self.registry.unlist(self.name.clone(), self.id);
    }

    fn info(&self) -> RoomInfo {
        RoomInfo {
            id: self.id,
            name: self.name.clone(),
            players: self.players.len(),
            connected: self
                .players
                .values()
                .filter(|s| s.conn_id.is_some())
                .count(),
            red_heroes: self.sim.human_count(shared::Team::Red),
            blue_heroes: self.sim.human_count(shared::Team::Blue),
            phase: match self.sim.phase() {
                Phase::Battle => "battle",
                Phase::SuddenDeath => "sudden_death",
                Phase::Ended => "ended",
            }
            .into(),
            remaining: self.sim.remaining_seconds(),
        }
    }
}

fn new_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..32)
        .map(|_| char::from_digit(rng.gen_range(0..36), 36).unwrap_or('0'))
        .collect()
}
