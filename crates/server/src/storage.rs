//! 可选的持久化层（同样是独立 task + 消息传递）：
//! - PostgreSQL：对局与玩家战绩（`matches` / `match_players`）。
//! - Redis：胜场排行榜（ZSET `mdtr:leaderboard:wins`）与最近对局缓存（LIST `mdtr:recent`）。
//!
//! 两者都未配置时退化为进程内内存排行，不影响对战。实时房间状态永远只在房间 task 内。

use serde::Serialize;
use shared::{MatchSummary, Team};
use std::collections::HashMap;
use tokio::sync::{mpsc, oneshot};

const LEADERBOARD_KEY: &str = "mdtr:leaderboard:wins";
const RECENT_KEY: &str = "mdtr:recent";

#[derive(Debug, Clone, Serialize)]
pub struct LeaderboardEntry {
    pub name: String,
    pub wins: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StorageStatus {
    pub postgres: bool,
    pub redis: bool,
}

enum StorageCommand {
    Record {
        room: String,
        summary: MatchSummary,
    },
    Leaderboard {
        reply: oneshot::Sender<Vec<LeaderboardEntry>>,
    },
    Recent {
        reply: oneshot::Sender<Vec<serde_json::Value>>,
    },
}

#[derive(Clone)]
pub struct StorageHandle {
    tx: mpsc::Sender<StorageCommand>,
    pub status: StorageStatus,
}

impl StorageHandle {
    pub fn record(&self, room: String, summary: MatchSummary) {
        if self
            .tx
            .try_send(StorageCommand::Record { room, summary })
            .is_err()
        {
            tracing::warn!("存储队列已满，丢弃一条对局记录");
        }
    }

    pub async fn leaderboard(&self) -> Vec<LeaderboardEntry> {
        let (reply, rx) = oneshot::channel();
        if self
            .tx
            .send(StorageCommand::Leaderboard { reply })
            .await
            .is_err()
        {
            return Vec::new();
        }
        rx.await.unwrap_or_default()
    }

    pub async fn recent(&self) -> Vec<serde_json::Value> {
        let (reply, rx) = oneshot::channel();
        if self
            .tx
            .send(StorageCommand::Recent { reply })
            .await
            .is_err()
        {
            return Vec::new();
        }
        rx.await.unwrap_or_default()
    }
}

struct Storage {
    pg: Option<sqlx::PgPool>,
    redis: Option<redis::aio::ConnectionManager>,
    memory_wins: HashMap<String, i64>,
    memory_recent: Vec<serde_json::Value>,
}

const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS matches (
        id BIGSERIAL PRIMARY KEY,
        room TEXT NOT NULL,
        winner TEXT,
        ticks INTEGER NOT NULL,
        red_score INTEGER NOT NULL,
        blue_score INTEGER NOT NULL,
        ended_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )",
    "CREATE TABLE IF NOT EXISTS match_players (
        match_id BIGINT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        team TEXT NOT NULL,
        hero TEXT NOT NULL,
        human BOOLEAN NOT NULL,
        kills INTEGER NOT NULL,
        deaths INTEGER NOT NULL,
        damage REAL NOT NULL,
        won BOOLEAN NOT NULL
    )",
    "CREATE INDEX IF NOT EXISTS match_players_name_idx ON match_players(name) WHERE human",
];

pub async fn spawn_storage(database_url: &str, redis_url: &str) -> StorageHandle {
    let pg = if database_url.is_empty() {
        None
    } else {
        match connect_pg(database_url).await {
            Ok(pool) => {
                tracing::info!("PostgreSQL 已连接");
                Some(pool)
            }
            Err(error) => {
                tracing::warn!(%error, "PostgreSQL 不可用，跳过持久化");
                None
            }
        }
    };
    let redis = if redis_url.is_empty() {
        None
    } else {
        match connect_redis(redis_url).await {
            Ok(manager) => {
                tracing::info!("Redis 已连接");
                Some(manager)
            }
            Err(error) => {
                tracing::warn!(%error, "Redis 不可用，跳过缓存");
                None
            }
        }
    };
    let status = StorageStatus {
        postgres: pg.is_some(),
        redis: redis.is_some(),
    };
    let (tx, mut rx) = mpsc::channel(256);
    let mut storage = Storage {
        pg,
        redis,
        memory_wins: HashMap::new(),
        memory_recent: Vec::new(),
    };
    tokio::spawn(async move {
        while let Some(command) = rx.recv().await {
            match command {
                StorageCommand::Record { room, summary } => storage.record(&room, &summary).await,
                StorageCommand::Leaderboard { reply } => {
                    let _ = reply.send(storage.leaderboard().await);
                }
                StorageCommand::Recent { reply } => {
                    let _ = reply.send(storage.recent().await);
                }
            }
        }
    });
    StorageHandle { tx, status }
}

async fn connect_pg(url: &str) -> Result<sqlx::PgPool, sqlx::Error> {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(std::time::Duration::from_secs(3))
        .connect(url)
        .await?;
    for statement in SCHEMA {
        sqlx::query(statement).execute(&pool).await?;
    }
    Ok(pool)
}

async fn connect_redis(url: &str) -> redis::RedisResult<redis::aio::ConnectionManager> {
    let client = redis::Client::open(url)?;
    let manager = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        client.get_connection_manager(),
    )
    .await
    .map_err(|_| redis::RedisError::from((redis::ErrorKind::IoError, "连接超时")))??;
    Ok(manager)
}

fn team_name(team: Option<Team>) -> Option<&'static str> {
    team.map(|t| match t {
        Team::Red => "Red",
        Team::Blue => "Blue",
    })
}

impl Storage {
    async fn record(&mut self, room: &str, summary: &MatchSummary) {
        let winners: Vec<String> = summary
            .players
            .iter()
            .filter(|p| p.human && Some(p.team) == summary.winner)
            .map(|p| p.name.clone())
            .collect();
        let brief = serde_json::json!({
            "room": room,
            "winner": team_name(summary.winner),
            "seconds": summary.ticks / shared::TICK_RATE,
            "score": [summary.red_score, summary.blue_score],
            "players": summary.players.iter().filter(|p| p.human).map(|p| &p.name).collect::<Vec<_>>(),
        });
        for name in &winners {
            *self.memory_wins.entry(name.clone()).or_default() += 1;
        }
        self.memory_recent.insert(0, brief.clone());
        self.memory_recent.truncate(50);

        if let Some(pool) = &self.pg {
            if let Err(error) = insert_match(pool, room, summary).await {
                tracing::warn!(%error, "写入对局记录失败");
            }
        }
        if let Some(redis) = &mut self.redis {
            let mut pipe = redis::pipe();
            for name in &winners {
                pipe.zincr(LEADERBOARD_KEY, name, 1).ignore();
            }
            pipe.lpush(RECENT_KEY, brief.to_string()).ignore();
            pipe.ltrim(RECENT_KEY, 0, 49).ignore();
            let result: redis::RedisResult<()> = pipe.query_async(redis).await;
            if let Err(error) = result {
                tracing::warn!(%error, "写入 Redis 失败");
            }
        }
    }

    async fn leaderboard(&mut self) -> Vec<LeaderboardEntry> {
        if let Some(redis) = &mut self.redis {
            let result: redis::RedisResult<Vec<(String, i64)>> = redis::cmd("ZREVRANGE")
                .arg(LEADERBOARD_KEY)
                .arg(0)
                .arg(19)
                .arg("WITHSCORES")
                .query_async(redis)
                .await;
            if let Ok(rows) = result {
                return rows
                    .into_iter()
                    .map(|(name, wins)| LeaderboardEntry { name, wins })
                    .collect();
            }
        }
        if let Some(pool) = &self.pg {
            let rows: Result<Vec<(String, i64)>, _> = sqlx::query_as(
                "SELECT name, COUNT(*)::BIGINT AS wins FROM match_players WHERE human AND won
                 GROUP BY name ORDER BY wins DESC LIMIT 20",
            )
            .fetch_all(pool)
            .await;
            if let Ok(rows) = rows {
                return rows
                    .into_iter()
                    .map(|(name, wins)| LeaderboardEntry { name, wins })
                    .collect();
            }
        }
        let mut rows: Vec<LeaderboardEntry> = self
            .memory_wins
            .iter()
            .map(|(name, &wins)| LeaderboardEntry {
                name: name.clone(),
                wins,
            })
            .collect();
        rows.sort_by(|a, b| b.wins.cmp(&a.wins).then(a.name.cmp(&b.name)));
        rows.truncate(20);
        rows
    }

    async fn recent(&mut self) -> Vec<serde_json::Value> {
        if let Some(redis) = &mut self.redis {
            let result: redis::RedisResult<Vec<String>> = redis::cmd("LRANGE")
                .arg(RECENT_KEY)
                .arg(0)
                .arg(19)
                .query_async(redis)
                .await;
            if let Ok(rows) = result {
                return rows
                    .iter()
                    .filter_map(|r| serde_json::from_str(r).ok())
                    .collect();
            }
        }
        self.memory_recent.iter().take(20).cloned().collect()
    }
}

async fn insert_match(
    pool: &sqlx::PgPool,
    room: &str,
    summary: &MatchSummary,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    let (id,): (i64,) = sqlx::query_as(
        "INSERT INTO matches (room, winner, ticks, red_score, blue_score) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    )
    .bind(room)
    .bind(team_name(summary.winner))
    .bind(summary.ticks as i32)
    .bind(summary.red_score as i32)
    .bind(summary.blue_score as i32)
    .fetch_one(&mut *tx)
    .await?;
    for p in &summary.players {
        sqlx::query(
            "INSERT INTO match_players (match_id, name, team, hero, human, kills, deaths, damage, won)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(id)
        .bind(&p.name)
        .bind(team_name(Some(p.team)))
        .bind(format!("{:?}", p.hero))
        .bind(p.human)
        .bind(p.kills as i32)
        .bind(p.deaths as i32)
        .bind(p.damage)
        .bind(Some(p.team) == summary.winner)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}
