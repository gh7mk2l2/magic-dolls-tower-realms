//! 无 wasm-bindgen 依赖的极简 C ABI 导出，客户端 `apps/client/src/offline.ts` 通过
//! `WebAssembly.instantiate` 直接调用。消息与网络协议完全一致（MessagePack），
//! 因此单机与联网走同一套客户端代码路径、同一份权威规则。
//!
//! 调用约定：
//! - `mdtr_alloc(len) -> ptr` / `mdtr_free(ptr, len)`：宿主写入输入缓冲区。
//! - 返回字节的函数把结果放在内部输出缓冲区，`mdtr_out_ptr()` / `mdtr_out_len()` 读取。

use shared::{encode, ClientMessage, ServerMessage, Welcome, PROTOCOL_VERSION, TICK_RATE};
use sim::{GameConfig, Simulation};
use std::cell::{Cell, RefCell};

const LOCAL_PLAYER: u64 = 1;

struct Instance {
    sim: Simulation,
    out: Vec<u8>,
    ticks_since_full: u32,
}

thread_local! {
    static INSTANCE: RefCell<Option<Instance>> = const { RefCell::new(None) };
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static SEED: Cell<u64> = const { Cell::new(sim::DEFAULT_SEED) };
}

/// 设置下一局的随机种子（影响 AI 选人与兵波站位）。宿主可在 Join 之前调用，可选。
#[no_mangle]
pub extern "C" fn mdtr_seed(lo: u32, hi: u32) {
    SEED.with(|s| s.set(u64::from(lo) | (u64::from(hi) << 32)));
}

fn set_out(bytes: Vec<u8>) {
    OUT.with(|o| *o.borrow_mut() = bytes);
}

#[no_mangle]
pub extern "C" fn mdtr_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len);
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}

/// # Safety
/// `ptr` 必须来自 `mdtr_alloc(len)` 且只释放一次。
#[no_mangle]
pub unsafe extern "C" fn mdtr_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        drop(Vec::from_raw_parts(ptr, 0, len));
    }
}

#[no_mangle]
pub extern "C" fn mdtr_out_ptr() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn mdtr_out_len() -> usize {
    OUT.with(|o| o.borrow().len())
}

fn input_slice<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if ptr.is_null() || len == 0 {
        &[]
    } else {
        // SAFETY: 宿主保证 ptr..ptr+len 是由 mdtr_alloc 分配并已写入的内存。
        unsafe { std::slice::from_raw_parts(ptr, len) }
    }
}

fn reply(message: &ServerMessage) {
    set_out(encode(message).unwrap_or_default());
}

/// 处理一条客户端消息（MessagePack 编码的 `ClientMessage`），回复写入输出缓冲区（可能为空）。
#[no_mangle]
pub extern "C" fn mdtr_send(ptr: *const u8, len: usize) {
    let bytes = input_slice(ptr, len);
    let message = match shared::decode_client(bytes) {
        Ok(m) => m,
        Err(e) => {
            reply(&ServerMessage::Error(format!("协议解析失败: {e}")));
            return;
        }
    };
    INSTANCE.with(|cell| {
        let mut slot = cell.borrow_mut();
        match message {
            ClientMessage::Join(join) => {
                let mut sim = Simulation::with_seed(GameConfig::default(), SEED.with(Cell::get));
                let result = sim.add_player(LOCAL_PLAYER, &join.name, join.team, join.hero);
                match result {
                    Ok((entity_id, team)) => {
                        if let Some(team_name) = join.team_name.as_deref() {
                            sim.set_team_name(team, team_name);
                        }
                        let welcome = Welcome {
                            player_id: LOCAL_PLAYER,
                            entity_id,
                            team,
                            room: "单机演练".into(),
                            token: "offline".into(),
                            tick_rate: TICK_RATE,
                            map: sim.map_info(),
                        };
                        let _ = PROTOCOL_VERSION;
                        reply(&ServerMessage::Welcome(Box::new(welcome)));
                        *slot = Some(Instance {
                            sim,
                            out: Vec::new(),
                            ticks_since_full: u32::MAX,
                        });
                    }
                    Err(e) => reply(&ServerMessage::Error(e.to_string())),
                }
            }
            ClientMessage::Input(frame) => {
                if let Some(instance) = slot.as_mut() {
                    instance.sim.set_input(LOCAL_PLAYER, frame);
                }
                set_out(Vec::new());
            }
            ClientMessage::Resync => {
                if let Some(instance) = slot.as_mut() {
                    instance.ticks_since_full = u32::MAX;
                }
                set_out(Vec::new());
            }
            ClientMessage::Ping(nonce) => reply(&ServerMessage::Pong(nonce)),
            ClientMessage::Leave => {
                *slot = None;
                set_out(Vec::new());
            }
        }
    });
}

/// 推进一个 tick，并把快照（以及对局结束时的结算）编码到输出缓冲区。
/// 返回值：0 = 无实例，1 = 快照，2 = 快照 + 对局结束。
#[no_mangle]
pub extern "C" fn mdtr_step() -> u32 {
    INSTANCE.with(|cell| {
        let mut slot = cell.borrow_mut();
        let Some(instance) = slot.as_mut() else {
            set_out(Vec::new());
            return 0;
        };
        let was_over = instance.sim.is_over();
        instance.sim.step();
        let full = instance.ticks_since_full >= TICK_RATE;
        instance.ticks_since_full = if full {
            0
        } else {
            instance.ticks_since_full + 1
        };
        let snapshot = instance.sim.snapshot(full);
        instance.out = encode(&ServerMessage::Snapshot(snapshot)).unwrap_or_default();
        let ended = !was_over && instance.sim.is_over();
        if ended {
            // 两条消息以长度前缀拼接：[u32 len][snapshot][u32 len][match_end]
            let summary =
                encode(&ServerMessage::MatchEnd(instance.sim.summary())).unwrap_or_default();
            let mut joined = Vec::with_capacity(instance.out.len() + summary.len() + 8);
            joined.extend_from_slice(&(instance.out.len() as u32).to_le_bytes());
            joined.extend_from_slice(&instance.out);
            joined.extend_from_slice(&(summary.len() as u32).to_le_bytes());
            joined.extend_from_slice(&summary);
            set_out(joined);
            2
        } else {
            set_out(std::mem::take(&mut instance.out));
            1
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use shared::{HeroKind, JoinRequest};

    fn send(message: &ClientMessage) -> Vec<u8> {
        let bytes = encode(message).unwrap();
        mdtr_send(bytes.as_ptr(), bytes.len());
        OUT.with(|o| o.borrow().clone())
    }

    #[test]
    fn join_then_step_produces_snapshots() {
        let welcome = send(&ClientMessage::Join(JoinRequest {
            version: PROTOCOL_VERSION,
            room: "x".into(),
            name: "测试".into(),
            team: None,
            hero: HeroKind::Ranger,
            token: None,
            team_name: None,
        }));
        assert!(matches!(
            shared::decode_server(&welcome).unwrap(),
            ServerMessage::Welcome(_)
        ));
        assert_eq!(mdtr_step(), 1);
        let out = OUT.with(|o| o.borrow().clone());
        match shared::decode_server(&out).unwrap() {
            ServerMessage::Snapshot(s) => assert!(s.full && !s.entities.is_empty()),
            _ => panic!("expected snapshot"),
        }
    }
}
