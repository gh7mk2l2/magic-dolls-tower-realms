//! 端到端测试：真实 axum 服务 + WebSocket 客户端。

use futures_util::{SinkExt, StreamExt};
use server::config::ServerConfig;
use server::{build_router, storage, AppState};
use shared::{
    decode_server, encode, ClientMessage, HeroKind, InputFrame, JoinRequest, ServerMessage, Team,
    PROTOCOL_VERSION,
};
use sim::GameConfig;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn start() -> String {
    let server = ServerConfig {
        log_dir: std::env::temp_dir().join("mdtr-test-logs"),
        ..ServerConfig::default()
    };
    let storage = storage::spawn_storage("", "").await;
    let state = AppState::new(GameConfig::default(), server, storage);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, build_router(state)).await.unwrap() });
    format!("ws://{addr}/ws")
}

async fn send(ws: &mut Ws, message: ClientMessage) {
    ws.send(Message::Binary(encode(&message).unwrap()))
        .await
        .unwrap();
}

async fn recv(ws: &mut Ws) -> ServerMessage {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("等待服务端消息超时")
            .unwrap()
            .unwrap();
        if let Message::Binary(bytes) = message {
            return decode_server(&bytes).unwrap();
        }
    }
}

fn join(room: &str, token: Option<String>) -> ClientMessage {
    ClientMessage::Join(JoinRequest {
        version: PROTOCOL_VERSION,
        room: room.into(),
        name: "测试玩偶".into(),
        team: Some(Team::Blue),
        hero: HeroKind::Guardian,
        token,
        team_name: None,
    })
}

#[tokio::test]
async fn join_receive_snapshots_ack_inputs_and_reconnect() {
    let url = start().await;
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    send(&mut ws, join("e2e", None)).await;
    let ServerMessage::Welcome(welcome) = recv(&mut ws).await else {
        panic!("首条消息应为 Welcome")
    };
    assert_eq!(welcome.team, Team::Blue);
    assert_eq!(welcome.map.grid, 64);
    let ServerMessage::Snapshot(initial) = recv(&mut ws).await else {
        panic!("第二条应为全量快照")
    };
    assert!(initial.full);

    for seq in 1..=10 {
        send(
            &mut ws,
            ClientMessage::Input(InputFrame {
                seq,
                move_x: -1.0,
                ..InputFrame::default()
            }),
        )
        .await;
    }
    let mut acked = 0;
    for _ in 0..60 {
        if let ServerMessage::Snapshot(s) = recv(&mut ws).await {
            if let Some((_, ack)) = s.acks.iter().find(|(p, _)| *p == welcome.player_id) {
                acked = *ack;
                if acked == 10 {
                    break;
                }
            }
        }
    }
    assert_eq!(acked, 10, "服务端应逐 tick 消费并确认输入");

    send(&mut ws, ClientMessage::Ping(42)).await;
    let mut got_pong = false;
    for _ in 0..40 {
        if let ServerMessage::Pong(42) = recv(&mut ws).await {
            got_pong = true;
            break;
        }
    }
    assert!(got_pong);

    // 断线后携带 token 重连，恢复同一个英雄。
    drop(ws);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    send(&mut ws, join("e2e", Some(welcome.token.clone()))).await;
    let ServerMessage::Welcome(again) = recv(&mut ws).await else {
        panic!("重连应收到 Welcome")
    };
    assert_eq!(again.player_id, welcome.player_id);
    assert_eq!(again.entity_id, welcome.entity_id);
}

#[tokio::test]
async fn rejects_wrong_protocol_version_and_bad_room() {
    let url = start().await;
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    send(
        &mut ws,
        ClientMessage::Join(JoinRequest {
            version: 0,
            room: "v".into(),
            name: "x".into(),
            team: None,
            hero: HeroKind::Arcanist,
            token: None,
            team_name: None,
        }),
    )
    .await;
    assert!(matches!(recv(&mut ws).await, ServerMessage::Error(_)));
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    send(&mut ws, join("bad room!", None)).await;
    assert!(matches!(recv(&mut ws).await, ServerMessage::Error(_)));
}
