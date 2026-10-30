//! JSONL 对局日志：用于回放校验（`cargo run -p server --bin replay`）与数值分析。
//!
//! 每行一个 JSON 对象，`t` 为该记录生效时的模拟 tick：
//! - `header`：房间信息与完整数值配置（TOML 原文），回放时据此重建模拟。
//! - `join` / `leave` / `timeout` / `disconnect` / `reconnect`：玩家变动。
//! - `input`：被模拟接受的每一帧输入（在第 t 个 tick 之后、第 t+1 个 tick 之前生效）。
//! - `event`：关键事件（击杀、塔毁、兵波、死斗、胜负）。
//! - `stats`：每 5 秒的双方态势采样。
//! - `summary`：对局结算。
//!
//! 写文件在独立 task 中进行，房间 task 只做非阻塞 `try_send`，日志拥堵时丢弃并计数，绝不拖慢 tick。

use serde_json::{json, Value};
use shared::{EntityKind, EventKind, GameEvent, InputFrame, MatchSummary, Snapshot, Team};
use sim::GameConfig;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

pub struct MatchLog {
    tx: Option<mpsc::Sender<String>>,
    dropped: Arc<AtomicU64>,
}

impl MatchLog {
    pub fn disabled() -> Self {
        Self {
            tx: None,
            dropped: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn open(dir: &Path, room: &str, id: u64, config: &GameConfig, seed: u64) -> Self {
        if let Err(error) = std::fs::create_dir_all(dir) {
            tracing::warn!(%error, "无法创建日志目录，日志关闭");
            return Self::disabled();
        }
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let safe: String = room
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let path = dir.join(format!("{stamp}-{safe}-{id}.jsonl"));
        let (tx, mut rx) = mpsc::channel::<String>(8192);
        let dropped = Arc::new(AtomicU64::new(0));
        tokio::spawn(async move {
            let file = match tokio::fs::File::create(&path).await {
                Ok(f) => f,
                Err(error) => {
                    tracing::warn!(%error, path = %path.display(), "无法创建对局日志");
                    return;
                }
            };
            let mut writer = tokio::io::BufWriter::new(file);
            while let Some(line) = rx.recv().await {
                if writer.write_all(line.as_bytes()).await.is_err()
                    || writer.write_all(b"\n").await.is_err()
                {
                    break;
                }
                if rx.is_empty() {
                    let _ = writer.flush().await;
                }
            }
            let _ = writer.flush().await;
        });
        let log = Self {
            tx: Some(tx),
            dropped,
        };
        let config_toml = toml::to_string(config).unwrap_or_default();
        log.record(
            0,
            "header",
            json!({ "room": room, "room_id": id, "protocol": shared::PROTOCOL_VERSION, "seed": seed, "config": config_toml }),
        );
        log
    }

    pub fn record(&self, tick: u32, kind: &str, data: Value) {
        let Some(tx) = &self.tx else { return };
        let line = json!({ "t": tick, "type": kind, "data": data }).to_string();
        if tx.try_send(line).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn input(&self, tick: u32, player: u64, frame: &InputFrame) {
        self.record(
            tick,
            "input",
            json!({
                "player": player, "seq": frame.seq, "mx": frame.move_x, "my": frame.move_y,
                "ax": frame.aim_x, "ay": frame.aim_y, "atk": frame.attack, "sk": frame.skills
            }),
        );
    }

    pub fn events(&self, tick: u32, events: &[GameEvent]) {
        for event in events {
            if matches!(
                event.kind,
                EventKind::Death
                    | EventKind::TowerDestroyed
                    | EventKind::WaveSpawned
                    | EventKind::SuddenDeath
                    | EventKind::Victory
                    | EventKind::Skill
            ) {
                self.record(
                    tick,
                    "event",
                    json!({
                        "kind": event.kind, "team": event.team, "x": event.x, "y": event.y,
                        "value": event.value, "source": event.source, "target": event.target, "text": event.text
                    }),
                );
            }
        }
    }

    /// 态势采样（传入全量快照）。
    pub fn stats(&self, snapshot: &Snapshot) {
        let mut minions = [0u32; 2];
        let mut heroes_alive = [0u32; 2];
        let mut towers = [0u32; 2];
        let mut base_hp = [0f32; 2];
        for e in &snapshot.entities {
            let i = usize::from(e.team == Team::Blue);
            match e.kind {
                EntityKind::Minion => minions[i] += 1,
                EntityKind::Hero if e.respawn == 0 => heroes_alive[i] += 1,
                EntityKind::Tower => towers[i] += 1,
                EntityKind::Base => base_hp[i] = e.hp,
                _ => {}
            }
        }
        self.record(
            snapshot.tick,
            "stats",
            json!({
                "remaining": snapshot.remaining, "wave": snapshot.wave,
                "score": [snapshot.red_score, snapshot.blue_score],
                "minions": minions, "heroes_alive": heroes_alive,
                "towers": towers, "base_hp": base_hp,
            }),
        );
    }

    pub fn summary(&self, summary: &MatchSummary) {
        self.record(
            summary.ticks,
            "summary",
            serde_json::to_value(summary).unwrap_or(Value::Null),
        );
    }

    pub fn close(&self) {
        let dropped = self.dropped.load(Ordering::Relaxed);
        if dropped > 0 {
            tracing::warn!(dropped, "对局日志因拥堵丢弃了部分记录");
        }
    }
}
