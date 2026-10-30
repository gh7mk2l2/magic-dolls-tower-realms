//! 客户端与服务端共享的协议结构体。
//!
//! 所有对局数据均使用 MessagePack（`rmp_serde::to_vec_named`，字段名编码为 map key），
//! 客户端 `apps/client/src/protocol.ts` 与本文件一一对应。修改字段时请同步更新两侧并提升
//! [`PROTOCOL_VERSION`]。

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u16 = 3;
pub const TICK_RATE: u32 = 20;

/// 实体状态位（`EntitySnapshot::flags`）。
pub mod flags {
    /// 被眩晕，无法移动/攻击/施法。
    pub const STUNNED: u8 = 1;
    /// 被减速。
    pub const SLOWED: u8 = 1 << 1;
    /// 基地护盾生效（己方仍有魔法塔存活）。
    pub const INVULNERABLE: u8 = 1 << 2;
    /// 免疫控制（超级双头变异魔兽）。
    pub const CONTROL_IMMUNE: u8 = 1 << 3;
    /// 由 AI 托管（含断线托管）。
    pub const AI: u8 = 1 << 4;
    /// 隐身（敌方不可选中；客户端对敌方隐藏、对友方半透明）。
    pub const STEALTH: u8 = 1 << 5;
    /// 拥有护盾（吸收伤害）。
    pub const SHIELDED: u8 = 1 << 6;
    /// 被嘲讽（强制走向嘲讽者，无法施法）。
    pub const TAUNTED: u8 = 1 << 7;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Team {
    Red,
    Blue,
}

impl Team {
    pub fn enemy(self) -> Self {
        match self {
            Self::Red => Self::Blue,
            Self::Blue => Self::Red,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EntityKind {
    Hero,
    Tower,
    Base,
    Minion,
    SuperMinion,
    PoisonZone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum HeroKind {
    Arcanist,
    Ranger,
    Guardian,
    Assassin,
    Priestess,
    Brawler,
    Stormcaller,
    FrostWitch,
    Artificer,
    Paladin,
    Alchemist,
    Windblade,
    Starshooter,
    Nightshade,
    Colossus,
    Chronomancer,
    FlameDancer,
    Bard,
    Beastmaster,
    Mirage,
}

impl HeroKind {
    pub const ALL: [HeroKind; 20] = [
        HeroKind::Arcanist,
        HeroKind::Ranger,
        HeroKind::Guardian,
        HeroKind::Assassin,
        HeroKind::Priestess,
        HeroKind::Brawler,
        HeroKind::Stormcaller,
        HeroKind::FrostWitch,
        HeroKind::Artificer,
        HeroKind::Paladin,
        HeroKind::Alchemist,
        HeroKind::Windblade,
        HeroKind::Starshooter,
        HeroKind::Nightshade,
        HeroKind::Colossus,
        HeroKind::Chronomancer,
        HeroKind::FlameDancer,
        HeroKind::Bard,
        HeroKind::Beastmaster,
        HeroKind::Mirage,
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EventKind {
    Shot,
    Hit,
    Skill,
    Poison,
    TowerDestroyed,
    SuddenDeath,
    Announcement,
    Death,
    Respawn,
    Victory,
    WaveSpawned,
    /// 玩家向队友求救：source=求救者实体，text=求救者名字。
    HelpRequest,
    /// 队友接受求救：source=接受者实体，target=求救者实体，text=接受者名字。
    HelpAccepted,
    /// 持续性区域（毒云/火海）的脉冲：(x,y)=中心，value=半径，source=施法者。
    Zone,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Vec2 {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct InputFrame {
    pub seq: u32,
    pub move_x: f32,
    pub move_y: f32,
    pub aim_x: f32,
    pub aim_y: f32,
    pub attack: bool,
    /// 位掩码：bit0=Q, bit1=E, bit2=R。
    pub skills: u8,
    /// 本帧发出求救（向全体队友广播）。
    #[serde(default)]
    pub help: bool,
    /// 本帧接受某名队友的求救（求救者实体 id，0 表示无）。
    #[serde(default)]
    pub accept_help: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JoinRequest {
    pub version: u16,
    pub room: String,
    pub name: String,
    pub team: Option<Team>,
    pub hero: HeroKind,
    /// 断线重连令牌；保留期内携带可恢复原英雄。
    pub token: Option<String>,
    /// 自定义战队名；该队还没有自定义名字时生效（最多 8 个字）。
    #[serde(default)]
    pub team_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ClientMessage {
    Join(JoinRequest),
    Input(InputFrame),
    Resync,
    Ping(u64),
    Leave,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EntitySnapshot {
    pub id: u32,
    pub kind: EntityKind,
    pub team: Team,
    pub x: f32,
    pub y: f32,
    pub vx: f32,
    pub vy: f32,
    pub hp: f32,
    pub max_hp: f32,
    pub radius: f32,
    pub hero: Option<HeroKind>,
    pub owner: Option<u64>,
    pub name: Option<String>,
    /// 剩余冷却（tick）。
    pub cooldowns: [u16; 3],
    /// 剩余复活时间（tick），0 表示存活。复活时间按队伍阵亡次数翻倍，可能很长，故用 u32。
    pub respawn: u32,
    pub facing: f32,
    pub attacking: bool,
    pub flags: u8,
    /// 当前移速倍率（减速时 < 1），供客户端预测使用。
    pub speed_mul: f32,
    /// 兵种所属波次；英雄为击杀数。
    pub level: u16,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GameEvent {
    pub id: u32,
    pub kind: EventKind,
    pub x: f32,
    pub y: f32,
    /// 次要坐标：弹道终点 / 技能落点。
    pub tx: f32,
    pub ty: f32,
    /// 伤害数值、技能半径等。
    pub value: f32,
    pub source: u32,
    pub target: u32,
    pub text: String,
    pub team: Option<Team>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Phase {
    Battle,
    SuddenDeath,
    Ended,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub tick: u32,
    pub server_time: u64,
    /// 常规时限剩余秒数；死斗阶段为死斗剩余秒数。
    pub remaining: u32,
    pub phase: Phase,
    pub winner: Option<Team>,
    pub full: bool,
    /// 每名玩家最近一次被模拟消费的输入序号 `(player_id, seq)`，用于客户端预测校正。
    pub acks: Vec<(u64, u32)>,
    pub entities: Vec<EntitySnapshot>,
    pub removed: Vec<u32>,
    pub events: Vec<GameEvent>,
    pub red_score: u32,
    pub blue_score: u32,
    /// 战队名 [红方, 蓝方]。
    #[serde(default)]
    pub team_names: Vec<String>,
    pub wave: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillInfo {
    pub key: String,
    pub name: String,
    pub effect: String,
    pub cooldown_ticks: u32,
    pub range: f32,
    pub radius: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeroInfo {
    pub kind: HeroKind,
    pub name: String,
    pub hp: f32,
    pub speed: f32,
    pub attack_range: f32,
    pub skills: Vec<SkillInfo>,
}

/// 地图与数值摘要，进入房间时下发，客户端据此绘制地图、HUD 与做移动预测。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MapInfo {
    pub width: f32,
    pub height: f32,
    pub grid: u32,
    /// 行优先的可通行网格（1 = 阻挡），长度 grid*grid。
    pub blocked: Vec<u8>,
    pub obstacles: Vec<Rect>,
    pub poison_radius: f32,
    pub match_seconds: u32,
    pub sudden_death_seconds: u32,
    pub wave_seconds: u32,
    pub heroes: Vec<HeroInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Welcome {
    pub player_id: u64,
    pub entity_id: u32,
    pub team: Team,
    pub room: String,
    pub token: String,
    pub tick_rate: u32,
    pub map: MapInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerResult {
    pub name: String,
    pub team: Team,
    pub hero: HeroKind,
    pub human: bool,
    pub kills: u32,
    pub deaths: u32,
    pub damage: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchSummary {
    pub winner: Option<Team>,
    pub ticks: u32,
    pub red_score: u32,
    pub blue_score: u32,
    pub towers_destroyed_red: u32,
    pub towers_destroyed_blue: u32,
    pub players: Vec<PlayerResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ServerMessage {
    Welcome(Box<Welcome>),
    Snapshot(Snapshot),
    Pong(u64),
    Error(String),
    MatchEnd(MatchSummary),
}

pub fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, rmp_serde::encode::Error> {
    rmp_serde::to_vec_named(value)
}

pub fn decode_client(bytes: &[u8]) -> Result<ClientMessage, rmp_serde::decode::Error> {
    rmp_serde::from_slice(bytes)
}

pub fn decode_server(bytes: &[u8]) -> Result<ServerMessage, rmp_serde::decode::Error> {
    rmp_serde::from_slice(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_roundtrip() {
        let msg = ClientMessage::Input(InputFrame {
            seq: 7,
            move_x: 1.0,
            move_y: 0.0,
            aim_x: 20.0,
            aim_y: 30.0,
            attack: true,
            skills: 2,
            help: false,
            accept_help: 0,
        });
        let bytes = encode(&msg).unwrap();
        assert!(!bytes.starts_with(b"{"));
        match decode_client(&bytes).unwrap() {
            ClientMessage::Input(v) => assert_eq!(v.seq, 7),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn unit_variant_encodes_as_string() {
        let bytes = encode(&ClientMessage::Resync).unwrap();
        assert!(matches!(
            decode_client(&bytes).unwrap(),
            ClientMessage::Resync
        ));
        // MessagePack fixstr "Resync"
        assert_eq!(bytes[0], 0xa6);
    }
}
