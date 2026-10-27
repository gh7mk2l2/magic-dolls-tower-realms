//! 房间注册表：同样以单独 task + 消息传递实现，没有全局锁。
//! 横向扩展时可把它替换为跨进程的路由服务（例如按房间名一致性哈希到不同节点）。

use crate::room::{spawn_room, RoomCommand, RoomContext, RoomInfo};
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

#[derive(Clone)]
pub struct RoomHandle {
    pub id: u64,
    pub name: String,
    pub tx: mpsc::Sender<RoomCommand>,
}

pub enum RegistryCommand {
    GetOrCreate {
        name: String,
        reply: oneshot::Sender<Result<RoomHandle, String>>,
    },
    List {
        reply: oneshot::Sender<Vec<RoomHandle>>,
    },
    /// 房间已结束或关闭，不再接受新玩家。
    Unlist { name: String, id: u64 },
}

#[derive(Clone)]
pub struct RegistryHandle {
    tx: mpsc::Sender<RegistryCommand>,
}

impl RegistryHandle {
    pub async fn get_or_create(&self, name: String) -> Result<RoomHandle, String> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(RegistryCommand::GetOrCreate { name, reply })
            .await
            .map_err(|_| "注册表已关闭".to_string())?;
        rx.await.map_err(|_| "注册表无响应".to_string())?
    }

    pub async fn list(&self) -> Vec<RoomInfo> {
        let (reply, rx) = oneshot::channel();
        if self.tx.send(RegistryCommand::List { reply }).await.is_err() {
            return Vec::new();
        }
        let rooms = rx.await.unwrap_or_default();
        let mut infos = Vec::new();
        for room in rooms {
            let (reply, rx) = oneshot::channel();
            if room.tx.send(RoomCommand::Info { reply }).await.is_ok() {
                if let Ok(Ok(info)) = tokio::time::timeout(Duration::from_millis(300), rx).await {
                    infos.push(info);
                }
            }
        }
        infos
    }

    pub fn unlist(&self, name: String, id: u64) {
        let _ = self.tx.try_send(RegistryCommand::Unlist { name, id });
    }
}

pub fn valid_room_name(name: &str) -> bool {
    let count = name.chars().count();
    (1..=24).contains(&count)
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
}

pub fn spawn_registry(ctx: RoomContext, max_rooms: usize) -> RegistryHandle {
    let (tx, mut rx) = mpsc::channel::<RegistryCommand>(256);
    let handle = RegistryHandle { tx };
    let self_handle = handle.clone();
    tokio::spawn(async move {
        let mut rooms: HashMap<String, RoomHandle> = HashMap::new();
        let mut next_id = 1u64;
        while let Some(command) = rx.recv().await {
            match command {
                RegistryCommand::GetOrCreate { name, reply } => {
                    rooms.retain(|_, room| !room.tx.is_closed());
                    if !valid_room_name(&name) {
                        let _ =
                            reply.send(Err("房间名只能包含字母、数字、-、_，最长 24 字".into()));
                        continue;
                    }
                    if let Some(room) = rooms.get(&name) {
                        let _ = reply.send(Ok(room.clone()));
                        continue;
                    }
                    if rooms.len() >= max_rooms {
                        let _ = reply.send(Err("服务器房间数已达上限".into()));
                        continue;
                    }
                    let id = next_id;
                    next_id += 1;
                    let room = spawn_room(id, name.clone(), ctx.clone(), self_handle.clone());
                    tracing::info!(room = %name, id, "创建房间");
                    rooms.insert(name, room.clone());
                    let _ = reply.send(Ok(room));
                }
                RegistryCommand::List { reply } => {
                    rooms.retain(|_, room| !room.tx.is_closed());
                    let _ = reply.send(rooms.values().cloned().collect());
                }
                RegistryCommand::Unlist { name, id } => {
                    if rooms.get(&name).map(|r| r.id == id).unwrap_or(false) {
                        rooms.remove(&name);
                        tracing::info!(room = %name, id, "房间下架");
                    }
                }
            }
        }
    });
    handle
}
