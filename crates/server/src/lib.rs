//! 《魔法玩偶：塔域战争》权威服务端：axum WebSocket 接入 + 房间 task + 可选 PG/Redis。

pub mod config;
pub mod connection;
pub mod matchlog;
pub mod registry;
pub mod room;
pub mod storage;

use axum::extract::{State, WebSocketUpgrade};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use config::ServerConfig;
use registry::{spawn_registry, RegistryHandle};
use room::RoomContext;
use sim::{GameConfig, Simulation};
use std::sync::Arc;
use storage::StorageHandle;
use tower_http::services::{ServeDir, ServeFile};

/// 只读共享状态：所有可变状态都在各自的 task 中，这里只有句柄与不可变配置。
#[derive(Clone)]
pub struct AppState {
    pub registry: RegistryHandle,
    pub storage: StorageHandle,
    pub game: Arc<GameConfig>,
    pub server: Arc<ServerConfig>,
}

impl AppState {
    pub fn new(game: GameConfig, server: ServerConfig, storage: StorageHandle) -> Self {
        let game = Arc::new(game);
        let server = Arc::new(server);
        let ctx = RoomContext {
            game: game.clone(),
            server: server.clone(),
            storage: storage.clone(),
        };
        let registry = spawn_registry(ctx, server.max_rooms);
        Self {
            registry,
            storage,
            game,
            server,
        }
    }
}

pub fn build_router(state: AppState) -> Router {
    let static_dir = state.server.static_dir.clone();
    let index = static_dir.join("index.html");
    Router::new()
        .route("/ws", get(ws_handler))
        .route("/api/health", get(health))
        .route("/api/rooms", get(rooms))
        .route("/api/leaderboard", get(leaderboard))
        .route("/api/recent", get(recent))
        .route("/api/map", get(map))
        .fallback_service(ServeDir::new(static_dir).fallback(ServeFile::new(index)))
        .with_state(state)
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.max_message_size(16 * 1024)
        .on_upgrade(move |socket| connection::handle_socket(socket, state))
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    Json(serde_json::json!({
        "ok": true,
        "protocol": shared::PROTOCOL_VERSION,
        "tick_rate": shared::TICK_RATE,
        "storage": state.storage.status,
    }))
}

async fn rooms(State(state): State<AppState>) -> impl IntoResponse {
    Json(state.registry.list().await)
}

async fn leaderboard(State(state): State<AppState>) -> impl IntoResponse {
    Json(state.storage.leaderboard().await)
}

async fn recent(State(state): State<AppState>) -> impl IntoResponse {
    Json(state.storage.recent().await)
}

async fn map(State(state): State<AppState>) -> impl IntoResponse {
    let sim = Simulation::new((*state.game).clone());
    Json(sim.map_info())
}
