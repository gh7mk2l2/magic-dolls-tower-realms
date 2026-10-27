use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub full_snapshot_interval: u32,
    pub reconnect_seconds: u64,
    pub idle_room_seconds: u64,
    pub max_rooms: usize,
    pub log_dir: PathBuf,
    pub static_dir: PathBuf,
    pub game_config: PathBuf,
    pub database_url: String,
    pub redis_url: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            host: "0.0.0.0".into(),
            port: 8080,
            full_snapshot_interval: 20,
            reconnect_seconds: 30,
            idle_room_seconds: 60,
            max_rooms: 200,
            log_dir: "logs".into(),
            static_dir: "apps/client/dist".into(),
            game_config: "config/game.toml".into(),
            database_url: String::new(),
            redis_url: String::new(),
        }
    }
}

impl ServerConfig {
    /// 读取 `SERVER_CONFIG`（默认 `config/server.toml`），文件不存在时使用默认值，最后应用环境变量覆盖。
    pub fn load() -> anyhow::Result<Self> {
        let path = std::env::var("SERVER_CONFIG").unwrap_or_else(|_| "config/server.toml".into());
        let mut config: Self = match std::fs::read_to_string(&path) {
            Ok(text) => toml::from_str(&text)?,
            Err(_) => Self::default(),
        };
        let env = |key: &str| std::env::var(key).ok().filter(|v| !v.is_empty());
        if let Some(v) = env("HOST") {
            config.host = v;
        }
        if let Some(v) = env("PORT").and_then(|v| v.parse().ok()) {
            config.port = v;
        }
        if let Some(v) = env("LOG_DIR") {
            config.log_dir = v.into();
        }
        if let Some(v) = env("STATIC_DIR") {
            config.static_dir = v.into();
        }
        if let Some(v) = env("GAME_CONFIG") {
            config.game_config = v.into();
        }
        if let Some(v) = env("DATABASE_URL") {
            config.database_url = v;
        }
        if let Some(v) = env("REDIS_URL") {
            config.redis_url = v;
        }
        config.full_snapshot_interval = config.full_snapshot_interval.max(1);
        Ok(config)
    }
}
