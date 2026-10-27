//! 单个 WebSocket 连接：读半边解析二进制消息并投递给房间；写半边合并房间广播与直发消息。

use crate::room::{JoinAccepted, RoomCommand};
use crate::AppState;
use axum::extract::ws::{Message, WebSocket};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use shared::{decode_client, encode, ClientMessage, ServerMessage};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc, oneshot};

static NEXT_CONN: AtomicU64 = AtomicU64::new(1);
const MAX_MESSAGE_BYTES: usize = 4 * 1024;
/// 每秒最多接受的消息数（20Hz 输入 + ping 余量）。
const MAX_MESSAGES_PER_SECOND: u32 = 60;

fn error_bytes(text: impl Into<String>) -> Bytes {
    Bytes::from(encode(&ServerMessage::Error(text.into())).unwrap_or_default())
}

pub async fn handle_socket(socket: WebSocket, state: AppState) {
    let conn_id = NEXT_CONN.fetch_add(1, Ordering::Relaxed);
    let (mut sink, mut stream) = socket.split();

    // 第一条消息必须是 Join。
    let join = match tokio::time::timeout(Duration::from_secs(10), stream.next()).await {
        Ok(Some(Ok(Message::Binary(bytes)))) => match decode_client(&bytes) {
            Ok(ClientMessage::Join(join)) => join,
            _ => {
                let _ = sink
                    .send(Message::Binary(
                        error_bytes("第一条消息必须是 Join").to_vec(),
                    ))
                    .await;
                return;
            }
        },
        _ => return,
    };
    let room = match state.registry.get_or_create(join.room.clone()).await {
        Ok(room) => room,
        Err(error) => {
            let _ = sink
                .send(Message::Binary(error_bytes(error).to_vec()))
                .await;
            return;
        }
    };
    let (direct_tx, mut direct_rx) = mpsc::channel::<Bytes>(32);
    let (reply, reply_rx) = oneshot::channel();
    if room
        .tx
        .send(RoomCommand::Join {
            request: join,
            conn_id,
            direct: direct_tx.clone(),
            reply,
        })
        .await
        .is_err()
    {
        let _ = sink
            .send(Message::Binary(error_bytes("房间已关闭，请重试").to_vec()))
            .await;
        return;
    }
    let JoinAccepted {
        player_id,
        welcome,
        initial,
        mut snapshots,
    } = match reply_rx.await {
        Ok(Ok(accepted)) => accepted,
        Ok(Err(error)) => {
            let _ = sink
                .send(Message::Binary(error_bytes(error).to_vec()))
                .await;
            return;
        }
        Err(_) => return,
    };
    // 先发 Welcome 与初始全量快照，之后才开始读广播，保证增量基线正确。
    if sink.send(Message::Binary(welcome.to_vec())).await.is_err()
        || sink.send(Message::Binary(initial.to_vec())).await.is_err()
    {
        let _ = room
            .tx
            .send(RoomCommand::Disconnect { player_id, conn_id })
            .await;
        return;
    }

    let room_tx = room.tx.clone();
    let writer = tokio::spawn(async move {
        loop {
            let bytes = tokio::select! {
                biased;
                direct = direct_rx.recv() => match direct {
                    Some(bytes) => bytes,
                    None => break,
                },
                snapshot = snapshots.recv() => match snapshot {
                    Ok(bytes) => bytes,
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        // 客户端太慢：跳过积压并请求一次全量同步。
                        tracing::debug!(player_id, skipped, "广播滞后，触发重同步");
                        let _ = room_tx.try_send(RoomCommand::Resync { player_id });
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                },
            };
            if sink.send(Message::Binary(bytes.to_vec())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let mut window = Instant::now();
    let mut count = 0u32;
    let mut left = false;
    loop {
        let message = tokio::select! {
            message = stream.next() => message,
            _ = tokio::time::sleep(Duration::from_secs(20)) => {
                tracing::debug!(player_id, "连接空闲超时");
                break;
            }
        };
        let Some(Ok(message)) = message else { break };
        let bytes = match message {
            Message::Binary(bytes) => bytes,
            Message::Close(_) => break,
            _ => continue,
        };
        if bytes.len() > MAX_MESSAGE_BYTES {
            continue;
        }
        if window.elapsed() >= Duration::from_secs(1) {
            window = Instant::now();
            count = 0;
        }
        count += 1;
        if count > MAX_MESSAGES_PER_SECOND {
            continue;
        }
        match decode_client(&bytes) {
            Ok(ClientMessage::Input(frame)) => {
                // 房间队列满时丢弃输入而不是阻塞（下一帧会带上最新状态）。
                let _ = room.tx.try_send(RoomCommand::Input { player_id, frame });
            }
            Ok(ClientMessage::Resync) => {
                let _ = room.tx.try_send(RoomCommand::Resync { player_id });
            }
            Ok(ClientMessage::Ping(nonce)) => {
                if let Ok(bytes) = encode(&ServerMessage::Pong(nonce)) {
                    let _ = direct_tx.try_send(Bytes::from(bytes));
                }
            }
            Ok(ClientMessage::Leave) => {
                left = true;
                break;
            }
            Ok(ClientMessage::Join(_)) => {}
            Err(error) => tracing::debug!(%error, player_id, "无法解析客户端消息"),
        }
    }
    let command = if left {
        RoomCommand::Leave { player_id }
    } else {
        RoomCommand::Disconnect { player_id, conn_id }
    };
    let _ = room.tx.send(command).await;
    drop(direct_tx);
    writer.abort();
}
