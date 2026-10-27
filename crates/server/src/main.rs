use server::config::ServerConfig;
use server::{build_router, storage, AppState};
use sim::GameConfig;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,server=info")),
        )
        .init();
    let server = ServerConfig::load()?;
    let game = match std::fs::read_to_string(&server.game_config) {
        Ok(text) => GameConfig::from_toml(&text)?,
        Err(error) => {
            tracing::warn!(%error, path = %server.game_config.display(), "未找到数值配置，使用内置配置");
            GameConfig::default()
        }
    };
    let storage = storage::spawn_storage(&server.database_url, &server.redis_url).await;
    let addr = format!("{}:{}", server.host, server.port);
    let state = AppState::new(game, server, storage);
    let app = build_router(state);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("魔法玩偶：塔域战争 服务端监听 http://{addr}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("收到退出信号，正在关闭");
        })
        .await?;
    Ok(())
}
