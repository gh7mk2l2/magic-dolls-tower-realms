//! 《魔法玩偶：塔域战争》纯逻辑模拟（无 IO）。
//!
//! - 以 hecs 作为纯逻辑 ECS：魔法玩偶、魔法塔、基地、变异魔兽、超级双头魔兽、毒区均为实体。
//! - 固定 20Hz 步进，所有遍历按网络 ID 排序，同样的输入序列得到同样的结果（可回放）。
//! - 服务端与浏览器单机模式（WASM，见 `sim-wasm` crate）共用此 crate。

mod config;
mod flow;

pub use config::{
    seconds_to_ticks, ConfigError, GameConfig, SkillConfig, SkillEffect, WaveStats, BUILTIN_CONFIG,
};
pub use flow::{FlowField, NavGrid};

use flow::normalize;
use hecs::{Entity, World};
use shared::{
    flags, EntityKind, EntitySnapshot, EventKind, GameEvent, HeroKind, InputFrame, MapInfo,
    MatchSummary, Phase, PlayerResult, Snapshot, Team, Vec2, TICK_RATE,
};
use std::collections::{BTreeMap, VecDeque};

const DT: f32 = 1.0 / TICK_RATE as f32;
const INPUT_QUEUE_LIMIT: usize = 6;

// ---------------------------------------------------------------- 组件

#[derive(Debug, Clone, Copy)]
struct NetworkId(u32);
#[derive(Debug, Clone, Copy)]
struct Kind(EntityKind);
#[derive(Debug, Clone, Copy)]
struct Allegiance(Team);
#[derive(Debug, Clone, Copy)]
struct Position(Vec2);
#[derive(Debug, Clone, Copy, Default)]
struct Velocity(Vec2);
#[derive(Debug, Clone, Copy)]
struct Radius(f32);
#[derive(Debug, Clone, Copy)]
struct MoveSpeed(f32);
#[derive(Debug, Clone, Copy)]
struct Facing(f32);
#[derive(Debug, Clone, Copy)]
struct Health {
    current: f32,
    max: f32,
}
#[derive(Debug, Clone, Copy)]
struct Combat {
    damage: f32,
    range: f32,
    interval: u32,
    cooldown: u32,
    attacked_this_tick: bool,
}
#[derive(Debug, Clone, Copy, Default)]
struct Status {
    stun: u32,
    slow: u32,
    slow_amount: f32,
    control_immune: bool,
}
impl Status {
    fn speed_mul(&self) -> f32 {
        if self.slow > 0 {
            (1.0 - self.slow_amount).clamp(0.1, 1.0)
        } else {
            1.0
        }
    }
}
#[derive(Debug, Clone, Copy)]
struct Minion {
    wave: u32,
}
#[derive(Debug, Clone, Copy)]
struct SuperMinion;
#[derive(Debug, Clone, Copy)]
struct Tower {
    zone: u32,
}
#[derive(Debug, Clone, Copy)]
struct PoisonZone {
    radius: f32,
    dps: f32,
}
#[derive(Debug, Clone, Default)]
struct HeroStats {
    kills: u32,
    deaths: u32,
    damage: f32,
}
#[derive(Debug, Clone)]
struct HeroState {
    kind: HeroKind,
    owner: Option<u64>,
    name: String,
    ai: bool,
    queue: VecDeque<InputFrame>,
    input: InputFrame,
    last_seq: u32,
    ack: u32,
    cooldowns: [u32; 3],
    respawn: u32,
    poison_ticks: u32,
    stats: HeroStats,
}

#[derive(Debug, Clone, Copy)]
struct Meta {
    id: u32,
    entity: Entity,
    kind: EntityKind,
    team: Team,
    position: Vec2,
    hp: f32,
    radius: f32,
    alive: bool,
}

#[derive(Debug, Clone, Copy)]
struct DamageSource {
    team: Option<Team>,
    entity: Option<u32>,
    bypass_shield: bool,
}

#[derive(Debug)]
struct DeterministicRng(u64);
impl DeterministicRng {
    fn next_f32(&mut self) -> f32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        (x >> 40) as f32 / (1u64 << 24) as f32
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JoinError {
    TeamsFull,
}

impl std::fmt::Display for JoinError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TeamsFull => write!(f, "房间已满"),
        }
    }
}

/// 单个房间的完整游戏状态。
pub struct Simulation {
    config: GameConfig,
    grid: NavGrid,
    flow_to_red: FlowField,
    flow_to_blue: FlowField,
    world: World,
    entities: BTreeMap<u32, Entity>,
    players: BTreeMap<u64, u32>,
    last_sent: BTreeMap<u32, EntitySnapshot>,
    next_id: u32,
    next_event_id: u32,
    tick: u32,
    phase: Phase,
    winner: Option<Team>,
    red_score: u32,
    blue_score: u32,
    towers_lost: [u32; 2],
    wave: u32,
    sudden_death_tick: Option<u32>,
    super_respawns: Vec<(Team, u32)>,
    removed: Vec<u32>,
    events: Vec<GameEvent>,
    rng: DeterministicRng,
    /// 战队名 [红, 蓝] 以及是否已被玩家自定义。
    team_names: [String; 2],
    team_named: [bool; 2],
    /// 玩家下次可以求救的 tick。
    help_ready: BTreeMap<u64, u32>,
}

impl Simulation {
    pub fn new(config: GameConfig) -> Self {
        let grid = NavGrid::new(
            config.world.width,
            config.world.height,
            config.world.grid,
            &config.obstacle_rects(),
        );
        let red_base = base_position(&config, Team::Red);
        let blue_base = base_position(&config, Team::Blue);
        let flow_to_red = FlowField::new(&grid, red_base);
        let flow_to_blue = FlowField::new(&grid, blue_base);
        let mut sim = Self {
            config,
            grid,
            flow_to_red,
            flow_to_blue,
            world: World::new(),
            entities: BTreeMap::new(),
            players: BTreeMap::new(),
            last_sent: BTreeMap::new(),
            next_id: 1,
            next_event_id: 1,
            tick: 0,
            phase: Phase::Battle,
            winner: None,
            red_score: 0,
            blue_score: 0,
            towers_lost: [0, 0],
            wave: 0,
            sudden_death_tick: None,
            super_respawns: Vec::new(),
            removed: Vec::new(),
            events: Vec::new(),
            rng: DeterministicRng(0x4d59_5df4_d0f3_3173),
            team_names: [DEFAULT_TEAM_NAMES[0].to_owned(), DEFAULT_TEAM_NAMES[1].to_owned()],
            team_named: [false, false],
            help_ready: BTreeMap::new(),
        };
        for team in [Team::Red, Team::Blue] {
            sim.spawn_structures(team);
        }
        for team in [Team::Red, Team::Blue] {
            sim.rebalance_ai(team);
        }
        sim.announce("战斗开始！摧毁敌方两座魔法塔，击碎基地");
        sim
    }

    // ------------------------------------------------------------ 公共接口

    pub fn config(&self) -> &GameConfig {
        &self.config
    }
    pub fn tick(&self) -> u32 {
        self.tick
    }
    pub fn winner(&self) -> Option<Team> {
        self.winner
    }
    pub fn phase(&self) -> Phase {
        self.phase
    }
    pub fn is_over(&self) -> bool {
        self.phase == Phase::Ended
    }
    pub fn player_entity(&self, player_id: u64) -> Option<u32> {
        self.players.get(&player_id).copied()
    }
    pub fn player_count(&self) -> usize {
        self.players.len()
    }

    pub fn player_team(&self, player_id: u64) -> Option<Team> {
        let entity = self.player_hecs_entity(player_id)?;
        self.world.get::<&Allegiance>(entity).ok().map(|a| a.0)
    }

    pub fn map_info(&self) -> MapInfo {
        MapInfo {
            width: self.config.world.width,
            height: self.config.world.height,
            grid: self.config.world.grid as u32,
            blocked: self.grid.blocked_bytes(),
            obstacles: self.config.obstacle_rects(),
            poison_radius: self.config.poison.radius,
            match_seconds: self.config.world.match_seconds,
            sudden_death_seconds: self.config.sudden_death.max_seconds,
            wave_seconds: self.config.wave.interval_seconds,
            heroes: self.config.hero_infos(),
        }
    }

    /// 玩家加入；`team` 为空或已满时自动平衡。会顶替本队的 AI 魔法玩偶。
    pub fn add_player(
        &mut self,
        player_id: u64,
        name: &str,
        team: Option<Team>,
        hero: HeroKind,
    ) -> Result<(u32, Team), JoinError> {
        if let Some(&id) = self.players.get(&player_id) {
            let team = self.player_team(player_id).unwrap_or(Team::Red);
            return Ok((id, team));
        }
        let max = self.config.world.max_team_size;
        let red = self.human_count(Team::Red);
        let blue = self.human_count(Team::Blue);
        let preferred = team.unwrap_or(if red <= blue { Team::Red } else { Team::Blue });
        let count = |t: Team| if t == Team::Red { red } else { blue };
        let team = if count(preferred) < max {
            preferred
        } else if count(preferred.enemy()) < max {
            preferred.enemy()
        } else {
            return Err(JoinError::TeamsFull);
        };
        let name = sanitize_name(name);
        let replace = self.hero_ids(Some(team)).into_iter().find(|&id| {
            self.hero_state(id)
                .map(|h| h.owner.is_none())
                .unwrap_or(false)
        });
        let id = match replace {
            Some(id) => {
                let entity = self.entities[&id];
                let hp = self.config.hero_hp(hero);
                let speed = self.config.hero_speed(hero);
                let spawn = self.team_spawn(team, id);
                let damage = self.config.hero_attack_damage(hero);
                let range = self.config.hero_attack_range(hero);
                if let Ok(mut state) = self.world.get::<&mut HeroState>(entity) {
                    state.kind = hero;
                    state.owner = Some(player_id);
                    state.name = name;
                    state.ai = false;
                    state.queue.clear();
                    state.input = InputFrame::default();
                    state.last_seq = 0;
                    state.ack = 0;
                    state.respawn = 0;
                    state.cooldowns = [0; 3];
                    state.stats = HeroStats::default();
                }
                self.set_component(
                    entity,
                    Health {
                        current: hp,
                        max: hp,
                    },
                );
                self.set_component(entity, MoveSpeed(speed));
                self.set_component(entity, Position(spawn));
                if let Ok(mut combat) = self.world.get::<&mut Combat>(entity) {
                    combat.damage = damage;
                    combat.range = range;
                }
                id
            }
            None => self.spawn_hero(team, hero, Some(player_id), name),
        };
        self.players.insert(player_id, id);
        self.rebalance_ai(team);
        Ok((id, team))
    }

    pub fn remove_player(&mut self, player_id: u64) -> bool {
        let Some(id) = self.players.remove(&player_id) else {
            return false;
        };
        let team = self.team_of(id);
        self.despawn(id);
        if let Some(team) = team {
            self.rebalance_ai(team);
        }
        true
    }

    /// 断线：AI 接管英雄，保留归属以便重连恢复。
    pub fn set_disconnected(&mut self, player_id: u64, disconnected: bool) -> bool {
        let Some(entity) = self.player_hecs_entity(player_id) else {
            return false;
        };
        let Ok(mut hero) = self.world.get::<&mut HeroState>(entity) else {
            return false;
        };
        hero.ai = disconnected;
        hero.queue.clear();
        hero.input = InputFrame {
            seq: hero.last_seq,
            ..InputFrame::default()
        };
        true
    }

    /// 投递一帧输入（服务端校验：乱序/重复丢弃，数值裁剪，队列限长）。
    pub fn team_names(&self) -> Vec<String> {
        self.team_names.to_vec()
    }

    /// 设置战队名。该队已被自定义过时忽略（先到先得），返回是否生效。
    pub fn set_team_name(&mut self, team: Team, name: &str) -> bool {
        let index = team_index(team);
        if self.team_named[index] {
            return false;
        }
        let name: String = name
            .trim()
            .chars()
            .filter(|c| !c.is_control() && !matches!(c, '<' | '>' | '&' | '"' | '\''))
            .take(8)
            .collect();
        if name.is_empty() || name == self.team_names[index] {
            return false;
        }
        let side = if team == Team::Red { "红方" } else { "蓝方" };
        self.team_names[index] = name.clone();
        self.team_named[index] = true;
        self.announce(&format!("{side}战队命名为「{name}」"));
        true
    }

    fn handle_help(&mut self, player_id: u64, help: bool, accept: u32) {
        let Some(&me) = self.players.get(&player_id) else {
            return;
        };
        let Some(mine) = self.entity_snapshot(me) else {
            return;
        };
        if mine.respawn > 0 {
            return;
        }
        let name = mine.name.clone().unwrap_or_default();
        if help {
            let ready = self.help_ready.get(&player_id).copied().unwrap_or(0);
            if self.tick >= ready {
                self.help_ready.insert(player_id, self.tick + HELP_COOLDOWN_TICKS);
                let at = Vec2 { x: mine.x, y: mine.y };
                self.event(EventKind::HelpRequest, Some(mine.team), at, at, 0.0, &name);
                if let Some(event) = self.events.last_mut() {
                    event.source = me;
                }
            }
        }
        if accept != 0 && accept != me {
            let valid = self
                .entity_snapshot(accept)
                .map(|t| t.kind == EntityKind::Hero && t.team == mine.team && t.respawn == 0)
                .unwrap_or(false);
            if valid {
                let at = Vec2 { x: mine.x, y: mine.y };
                self.event(EventKind::HelpAccepted, Some(mine.team), at, at, 0.0, &name);
                if let Some(event) = self.events.last_mut() {
                    event.source = me;
                    event.target = accept;
                }
            }
        }
    }

    pub fn set_input(&mut self, player_id: u64, input: InputFrame) -> bool {
        let (help, accept) = (input.help, input.accept_help);
        let accepted = self.queue_input(player_id, input);
        if accepted && (help || accept != 0) {
            self.handle_help(player_id, help, accept);
        }
        accepted
    }

    fn queue_input(&mut self, player_id: u64, mut input: InputFrame) -> bool {
        let Some(entity) = self.player_hecs_entity(player_id) else {
            return false;
        };
        let Ok(mut hero) = self.world.get::<&mut HeroState>(entity) else {
            return false;
        };
        if hero.ai || input.seq <= hero.last_seq {
            return false;
        }
        sanitize_input(&mut input);
        hero.last_seq = input.seq;
        hero.queue.push_back(input);
        while hero.queue.len() > INPUT_QUEUE_LIMIT {
            // 客户端发送过快：丢弃最旧的移动帧，但保留其技能按键，避免吞技能。
            if let Some(dropped) = hero.queue.pop_front() {
                if let Some(front) = hero.queue.front_mut() {
                    front.skills |= dropped.skills;
                    front.attack |= dropped.attack;
                }
            }
        }
        true
    }

    pub fn player_ack(&self, player_id: u64) -> u32 {
        self.player_hecs_entity(player_id)
            .and_then(|e| self.world.get::<&HeroState>(e).ok().map(|h| h.ack))
            .unwrap_or(0)
    }

    pub fn entity_snapshot(&self, id: u32) -> Option<EntitySnapshot> {
        self.entities
            .get(&id)
            .and_then(|entity| self.make_snapshot(*entity))
    }

    pub fn hero_count(&self, team: Team) -> usize {
        self.hero_ids(Some(team)).len()
    }

    pub fn human_count(&self, team: Team) -> usize {
        self.hero_ids(Some(team))
            .into_iter()
            .filter(|&id| {
                self.hero_state(id)
                    .map(|h| h.owner.is_some())
                    .unwrap_or(false)
            })
            .count()
    }

    pub fn is_base_invulnerable(&self, team: Team) -> bool {
        self.world
            .query::<(&Tower, &Allegiance, &Health)>()
            .iter()
            .any(|(_, (_, a, h))| a.0 == team && h.current > 0.0)
    }

    pub fn damage_entity(&mut self, id: u32, damage: f32, source: Option<Team>) -> bool {
        self.apply_damage(
            id,
            damage,
            DamageSource {
                team: source,
                entity: None,
                bypass_shield: false,
            },
        )
    }

    /// 推进一个 tick（1/20 秒）。
    pub fn step(&mut self) {
        if self.phase == Phase::Ended {
            return;
        }
        self.tick = self.tick.wrapping_add(1);
        self.update_timers();
        if self.phase == Phase::Ended {
            return;
        }
        self.update_heroes();
        self.update_ai();
        self.move_heroes();
        self.use_skills();
        self.update_combat();
        self.separate_units();
        self.apply_poison();
        if self.tick.is_multiple_of(TICK_RATE) {
            self.apply_sudden_death_decay();
        }
    }

    /// 生成快照。`full = false` 时只包含与上次快照相比发生变化的实体（增量）。
    pub fn snapshot(&mut self, full: bool) -> Snapshot {
        let mut entities = Vec::new();
        let mut current = BTreeMap::new();
        for (&id, &entity) in &self.entities {
            if let Some(snapshot) = self.make_snapshot(entity) {
                let changed = self
                    .last_sent
                    .get(&id)
                    .map(|previous| !nearly_equal(previous, &snapshot))
                    .unwrap_or(true);
                if full || changed {
                    entities.push(snapshot.clone());
                    current.insert(id, snapshot);
                } else if let Some(previous) = self.last_sent.get(&id) {
                    current.insert(id, previous.clone());
                }
            }
        }
        self.last_sent = current;
        let removed = std::mem::take(&mut self.removed);
        let acks = self
            .players
            .keys()
            .map(|&player| (player, self.player_ack(player)))
            .collect();
        Snapshot {
            tick: self.tick,
            server_time: u64::from(self.tick) * 1_000 / u64::from(TICK_RATE),
            remaining: self.remaining_seconds(),
            phase: self.phase,
            winner: self.winner,
            full,
            acks,
            entities,
            removed: if full { Vec::new() } else { removed },
            events: std::mem::take(&mut self.events),
            red_score: self.red_score,
            blue_score: self.blue_score,
            team_names: self.team_names.to_vec(),
            wave: self.wave,
        }
    }

    /// 不修改增量基线、不消费事件的全量快照，用于新玩家加入或断线重同步。
    /// 在两次 `step` 之间调用时，它与下一次增量快照的基线完全一致。
    pub fn peek_full(&self) -> Snapshot {
        let entities = self.last_sent.values().cloned().collect::<Vec<_>>();
        // 尚未发送过快照时（房间刚创建）直接读取当前状态。
        let entities = if entities.is_empty() {
            self.entities
                .values()
                .filter_map(|&e| self.make_snapshot(e))
                .collect()
        } else {
            entities
        };
        Snapshot {
            tick: self.tick,
            server_time: u64::from(self.tick) * 1_000 / u64::from(TICK_RATE),
            remaining: self.remaining_seconds(),
            phase: self.phase,
            winner: self.winner,
            full: true,
            acks: self
                .players
                .keys()
                .map(|&player| (player, self.player_ack(player)))
                .collect(),
            entities,
            removed: Vec::new(),
            events: Vec::new(),
            red_score: self.red_score,
            blue_score: self.blue_score,
            team_names: self.team_names.to_vec(),
            wave: self.wave,
        }
    }

    pub fn summary(&self) -> MatchSummary {
        let mut players: Vec<PlayerResult> = self
            .hero_ids(None)
            .into_iter()
            .filter_map(|id| {
                let team = self.team_of(id)?;
                let hero = self.hero_state(id)?;
                Some(PlayerResult {
                    name: hero.name.clone(),
                    team,
                    hero: hero.kind,
                    human: hero.owner.is_some(),
                    kills: hero.stats.kills,
                    deaths: hero.stats.deaths,
                    damage: hero.stats.damage.round(),
                })
            })
            .collect();
        players.sort_by(|a, b| b.kills.cmp(&a.kills).then(a.deaths.cmp(&b.deaths)));
        MatchSummary {
            winner: self.winner,
            ticks: self.tick,
            red_score: self.red_score,
            blue_score: self.blue_score,
            towers_destroyed_red: self.towers_lost[1],
            towers_destroyed_blue: self.towers_lost[0],
            players,
        }
    }

    pub fn remaining_seconds(&self) -> u32 {
        let elapsed = self.tick / TICK_RATE;
        match self.sudden_death_tick {
            Some(start) => self
                .config
                .sudden_death
                .max_seconds
                .saturating_sub((self.tick - start) / TICK_RATE),
            None => self.config.world.match_seconds.saturating_sub(elapsed),
        }
    }

    // ------------------------------------------------------------ 生成

    fn spawn_structures(&mut self, team: Team) {
        let base = base_position(&self.config, team);
        let base_hp = self.config.base.hp;
        let base_radius = self.config.base.radius;
        let base_entity = self.spawn_entity(EntityKind::Base, team, base, base_hp, base_radius);
        if self.config.base.damage > 0.0 {
            self.world
                .insert(
                    base_entity,
                    (
                        Combat {
                            damage: self.config.base.damage,
                            range: self.config.base.range,
                            interval: seconds_to_ticks(self.config.base.attack_seconds),
                            cooldown: 0,
                            attacked_this_tick: false,
                        },
                        Facing(0.0),
                    ),
                )
                .expect("基地实体存在");
        }
        let tower = self.config.tower.clone();
        for position in tower_positions(&self.config, team) {
            let entity =
                self.spawn_entity(EntityKind::Tower, team, position, tower.hp, tower.radius);
            let zone = self.spawn_entity(
                EntityKind::PoisonZone,
                team,
                position,
                1.0,
                self.config.poison.radius,
            );
            let zone_id = self.network_id(zone);
            self.world
                .insert_one(
                    zone,
                    PoisonZone {
                        radius: self.config.poison.radius,
                        dps: self.config.poison.dps,
                    },
                )
                .expect("毒区实体存在");
            self.world
                .insert(
                    entity,
                    (
                        Tower { zone: zone_id },
                        Combat {
                            damage: tower.damage,
                            range: tower.range,
                            interval: seconds_to_ticks(tower.attack_seconds),
                            cooldown: 0,
                            attacked_this_tick: false,
                        },
                        Facing(0.0),
                    ),
                )
                .expect("魔法塔实体存在");
        }
    }

    fn spawn_hero(&mut self, team: Team, kind: HeroKind, owner: Option<u64>, name: String) -> u32 {
        let hp = self.config.hero_hp(kind);
        let radius = self.config.hero.radius;
        let id_hint = self.next_id;
        let position = self.team_spawn(team, id_hint);
        let entity = self.spawn_entity(EntityKind::Hero, team, position, hp, radius);
        let facing = if team == Team::Red {
            0.0
        } else {
            std::f32::consts::PI
        };
        self.world
            .insert(
                entity,
                (
                    MoveSpeed(self.config.hero_speed(kind)),
                    Combat {
                        damage: self.config.hero_attack_damage(kind),
                        range: self.config.hero_attack_range(kind),
                        interval: seconds_to_ticks(self.config.hero.attack_seconds),
                        cooldown: 0,
                        attacked_this_tick: false,
                    },
                    Status::default(),
                    Facing(facing),
                    HeroState {
                        kind,
                        owner,
                        ai: owner.is_none(),
                        name,
                        queue: VecDeque::new(),
                        input: InputFrame::default(),
                        last_seq: 0,
                        ack: 0,
                        cooldowns: [0; 3],
                        respawn: 0,
                        poison_ticks: 0,
                        stats: HeroStats::default(),
                    },
                ),
            )
            .expect("英雄实体存在");
        self.network_id(entity)
    }

    /// 让每队英雄总数 = max(真人数, ai_fill_to)，多出的 AI 移除，不足的补齐。
    fn rebalance_ai(&mut self, team: Team) {
        let humans = self.human_count(team);
        let desired = humans.max(self.config.world.ai_fill_to);
        loop {
            let total = self.hero_count(team);
            if total < desired {
                let count = HeroKind::ALL.len();
                // 红蓝两队错开起点，保证双方阵容不同且尽量不重复
                let kind = HeroKind::ALL[(total + usize::from(team == Team::Blue) * 3) % count];
                let name = format!("AI·{}", self.config.hero(kind).name);
                self.spawn_hero(team, kind, None, name);
            } else if total > desired {
                let ai = self.hero_ids(Some(team)).into_iter().rev().find(|&id| {
                    self.hero_state(id)
                        .map(|h| h.owner.is_none())
                        .unwrap_or(false)
                });
                match ai {
                    Some(id) => self.despawn(id),
                    None => break,
                }
            } else {
                break;
            }
        }
    }

    fn spawn_wave(&mut self, wave: u32) {
        let stats = self.config.wave.stats(wave);
        let towers: Vec<(Team, Vec2)> = self
            .metas()
            .into_iter()
            .filter(|m| m.kind == EntityKind::Tower && m.alive)
            .map(|m| (m.team, m.position))
            .collect();
        let count = self.config.wave.count_per_tower;
        for (team, tower) in towers {
            let dir = if team == Team::Red { 1.0 } else { -1.0 };
            for index in 0..count {
                let jitter = (self.rng.next_f32() - 0.5) * 30.0;
                let position = Vec2 {
                    x: tower.x + dir * (self.config.tower.radius + 30.0 + index as f32 * 26.0),
                    y: tower.y + jitter,
                };
                let entity = self.spawn_entity(
                    EntityKind::Minion,
                    team,
                    position,
                    stats.hp,
                    self.config.wave.radius,
                );
                self.world
                    .insert(
                        entity,
                        (
                            Minion { wave },
                            MoveSpeed(stats.speed),
                            Status::default(),
                            Facing(if team == Team::Red {
                                0.0
                            } else {
                                std::f32::consts::PI
                            }),
                            Combat {
                                damage: stats.damage,
                                range: self.config.wave.range,
                                interval: seconds_to_ticks(self.config.wave.attack_seconds),
                                cooldown: 0,
                                attacked_this_tick: false,
                            },
                        ),
                    )
                    .expect("魔兽实体存在");
            }
        }
        self.event(
            EventKind::WaveSpawned,
            None,
            self.center(),
            self.center(),
            wave as f32 + 1.0,
            &format!("第 {} 波变异魔兽出击", wave + 1),
        );
    }

    fn spawn_super(&mut self, team: Team, position: Vec2) {
        let cfg = self.config.sudden_death.clone();
        let entity = self.spawn_entity(EntityKind::SuperMinion, team, position, cfg.hp, cfg.radius);
        self.world
            .insert(
                entity,
                (
                    SuperMinion,
                    MoveSpeed(cfg.speed),
                    Status {
                        control_immune: true,
                        ..Status::default()
                    },
                    Facing(if team == Team::Red {
                        0.0
                    } else {
                        std::f32::consts::PI
                    }),
                    Combat {
                        damage: cfg.damage,
                        range: cfg.range,
                        interval: seconds_to_ticks(cfg.attack_seconds),
                        cooldown: 0,
                        attacked_this_tick: false,
                    },
                ),
            )
            .expect("超级魔兽实体存在");
    }

    fn spawn_supers_for(&mut self, team: Team) {
        let towers: Vec<Vec2> = self
            .metas()
            .into_iter()
            .filter(|m| m.kind == EntityKind::Tower && m.alive && m.team == team)
            .map(|m| m.position)
            .collect();
        let per = self.config.sudden_death.per_tower.max(1);
        let dir = if team == Team::Red { 1.0 } else { -1.0 };
        if towers.is_empty() {
            let base = base_position(&self.config, team);
            for i in 0..per {
                self.spawn_super(
                    team,
                    Vec2 {
                        x: base.x + dir * (self.config.base.radius + 80.0),
                        y: base.y + i as f32 * 40.0,
                    },
                );
            }
        } else {
            for tower in towers {
                for i in 0..per {
                    self.spawn_super(
                        team,
                        Vec2 {
                            x: tower.x + dir * (self.config.tower.radius + 70.0),
                            y: tower.y + i as f32 * 40.0,
                        },
                    );
                }
            }
        }
    }

    // ------------------------------------------------------------ 每 tick 系统

    fn update_timers(&mut self) {
        let interval = self.config.wave.interval_seconds * TICK_RATE;
        let first = self.config.wave.first_wave_seconds * TICK_RATE;
        let first = first.max(1);
        if self.tick == first
            || (interval > 0 && self.tick > first && (self.tick - first).is_multiple_of(interval))
        {
            let wave = self.wave;
            self.spawn_wave(wave);
            self.wave += 1;
        }
        let deadline = self.config.world.match_seconds * TICK_RATE;
        if self.sudden_death_tick.is_none() && self.tick >= deadline {
            self.sudden_death_tick = Some(self.tick);
            self.phase = Phase::SuddenDeath;
            for team in [Team::Red, Team::Blue] {
                self.spawn_supers_for(team);
            }
            self.event(
                EventKind::SuddenDeath,
                None,
                self.center(),
                self.center(),
                0.0,
                "超时死斗！超级双头变异魔兽从魔法塔中苏醒",
            );
        }
        if let Some(start) = self.sudden_death_tick {
            let due: Vec<Team> = self
                .super_respawns
                .iter()
                .filter(|(_, at)| *at <= self.tick)
                .map(|(team, _)| *team)
                .collect();
            self.super_respawns.retain(|(_, at)| *at > self.tick);
            for team in due {
                self.spawn_supers_for(team);
                self.announce("超级双头变异魔兽再次孕育！");
            }
            let limit = self.config.sudden_death.max_seconds * TICK_RATE;
            if self.tick - start >= limit {
                self.resolve_by_base_hp();
            }
        }
    }

    fn resolve_by_base_hp(&mut self) {
        let ratio = |team: Team| {
            self.metas()
                .into_iter()
                .find(|m| m.kind == EntityKind::Base && m.team == team)
                .map(|m| {
                    let entity = m.entity;
                    self.world
                        .get::<&Health>(entity)
                        .map(|h| h.current / h.max)
                        .unwrap_or(0.0)
                })
                .unwrap_or(0.0)
        };
        let (red, blue) = (ratio(Team::Red), ratio(Team::Blue));
        self.winner = if (red - blue).abs() < 1e-4 {
            None
        } else if red > blue {
            Some(Team::Red)
        } else {
            Some(Team::Blue)
        };
        self.finish("死斗时间耗尽，按基地剩余生命判定");
    }

    fn finish(&mut self, text: &str) {
        self.phase = Phase::Ended;
        let text = match self.winner {
            Some(Team::Red) => format!("{text}：红方胜利"),
            Some(Team::Blue) => format!("{text}：蓝方胜利"),
            None => format!("{text}：平局"),
        };
        self.event(
            EventKind::Victory,
            self.winner,
            self.center(),
            self.center(),
            0.0,
            &text,
        );
    }

    fn update_heroes(&mut self) {
        for id in self.hero_ids(None) {
            let entity = self.entities[&id];
            let mut respawned = None;
            {
                let Ok(mut hero) = self.world.get::<&mut HeroState>(entity) else {
                    continue;
                };
                for cooldown in &mut hero.cooldowns {
                    *cooldown = cooldown.saturating_sub(1);
                }
                if !hero.ai {
                    if let Some(next) = hero.queue.pop_front() {
                        hero.ack = next.seq;
                        hero.input = next;
                    } else {
                        // 无新输入：保持移动方向，但不重复触发技能。
                        hero.input.skills = 0;
                    }
                }
                if hero.respawn > 0 {
                    hero.respawn -= 1;
                    if hero.respawn == 0 {
                        respawned = Some(hero.kind);
                    }
                }
            }
            if let Ok(mut status) = self.world.get::<&mut Status>(entity) {
                status.stun = status.stun.saturating_sub(1);
                status.slow = status.slow.saturating_sub(1);
            }
            if let Ok(mut combat) = self.world.get::<&mut Combat>(entity) {
                combat.attacked_this_tick = false;
            }
            if let Some(kind) = respawned {
                self.revive(entity, id, kind);
            }
        }
    }

    fn revive(&mut self, entity: Entity, id: u32, kind: HeroKind) {
        let team = self.team_of(id).unwrap_or(Team::Red);
        let hp = self.config.hero_hp(kind);
        let spawn = self.team_spawn(team, id);
        self.set_component(
            entity,
            Health {
                current: hp,
                max: hp,
            },
        );
        self.set_component(entity, Position(spawn));
        self.set_component(entity, Status::default());
        self.event(
            EventKind::Respawn,
            Some(team),
            spawn,
            spawn,
            0.0,
            "魔法玩偶已复活",
        );
    }

    fn update_ai(&mut self) {
        let metas = self.metas();
        for id in self.hero_ids(None) {
            let entity = self.entities[&id];
            let Some((kind, respawn, seq)) = self
                .world
                .get::<&HeroState>(entity)
                .ok()
                .filter(|h| h.ai)
                .map(|h| (h.kind, h.respawn, h.input.seq))
            else {
                continue;
            };
            if respawn > 0 {
                continue;
            }
            let me = metas.iter().find(|m| m.id == id).copied();
            let Some(me) = me else { continue };
            let max_hp = self
                .world
                .get::<&Health>(entity)
                .map(|h| h.max)
                .unwrap_or(1.0);
            let mut input = InputFrame {
                seq: seq.wrapping_add(1),
                ..InputFrame::default()
            };
            let home = self.team_spawn(me.team, id);
            let low = me.hp < max_hp * 0.35;
            let target = if low {
                None
            } else {
                self.ai_pick_target(&me, &metas)
            };
            let attack_range = self.config.hero_attack_range(kind);
            if low {
                let d = self.move_dir_toward(me.position, home, me.team, true);
                input.move_x = d.x;
                input.move_y = d.y;
                input.aim_x = home.x;
                input.aim_y = home.y;
                for slot in 0..3 {
                    let skill = self.config.skill(kind, slot);
                    if matches!(skill.effect, SkillEffect::Heal | SkillEffect::Dash) {
                        input.skills |= 1 << slot;
                    }
                }
            } else if let Some(target) = target {
                let dist = distance(me.position, target.position);
                input.aim_x = target.position.x;
                input.aim_y = target.position.y;
                if dist > attack_range * 0.85 + target.radius {
                    let d = self.move_dir_toward(me.position, target.position, me.team, false);
                    input.move_x = d.x;
                    input.move_y = d.y;
                }
                input.attack = dist <= attack_range + target.radius + 10.0;
                for slot in 0..3 {
                    let skill = self.config.skill(kind, slot);
                    let usable = match skill.effect {
                        SkillEffect::Damage | SkillEffect::Stun | SkillEffect::Slow => {
                            dist <= skill.range + skill.radius * 0.5
                        }
                        SkillEffect::Nova => dist <= skill.radius * 0.9,
                        SkillEffect::Dash => false,
                        SkillEffect::Heal => me.hp < max_hp * 0.6,
                    };
                    // 只对英雄或成群魔兽交技能，避免浪费在单个小兵上。
                    if usable
                        && (target.kind == EntityKind::Hero
                            || target.kind == EntityKind::Tower
                            || slot == 0)
                    {
                        input.skills |= 1 << slot;
                    }
                }
            } else {
                // 无目标：沿流场向敌方推进，但停在敌方毒区外等待兵线。
                let goal = base_position(&self.config, me.team.enemy());
                let d = self.move_dir_toward(me.position, goal, me.team, false);
                let next = Vec2 {
                    x: me.position.x + d.x * 60.0,
                    y: me.position.y + d.y * 60.0,
                };
                if !self.in_enemy_poison(next, me.team, &metas) {
                    input.move_x = d.x;
                    input.move_y = d.y;
                }
                input.aim_x = goal.x;
                input.aim_y = goal.y;
            }
            if let Ok(mut hero) = self.world.get::<&mut HeroState>(entity) {
                hero.ack = input.seq;
                hero.input = input;
            }
        }
    }

    fn ai_pick_target(&self, me: &Meta, metas: &[Meta]) -> Option<Meta> {
        let aggro = self.config.hero.ai_aggro_range;
        let enemies = metas.iter().filter(|m| {
            m.team != me.team && m.alive && m.kind != EntityKind::PoisonZone && self.targetable(m)
        });
        let mut best: Option<(f32, Meta)> = None;
        for enemy in enemies {
            let dist = distance(me.position, enemy.position);
            if dist > aggro {
                continue;
            }
            let poisoned = enemy.kind != EntityKind::Tower
                && self.in_enemy_poison(enemy.position, me.team, metas);
            let allies_near = metas
                .iter()
                .filter(|a| {
                    a.team == me.team
                        && a.alive
                        && matches!(a.kind, EntityKind::Minion | EntityKind::SuperMinion)
                        && distance(a.position, enemy.position) < 320.0
                })
                .count();
            // 评分：越低越优先。
            let mut score = dist;
            match enemy.kind {
                EntityKind::Hero => score -= 150.0,
                EntityKind::Tower | EntityKind::Base => {
                    if allies_near == 0 && enemy.hp > 600.0 {
                        continue; // 没有兵线掩护不独自顶毒拆塔
                    }
                    score -= 50.0;
                }
                _ => {}
            }
            if poisoned {
                score += 400.0;
            }
            // 不追进敌方基地的防御范围（除非基地护盾已破、正在推基地）。
            if enemy.kind != EntityKind::Base
                && self.in_enemy_base_defense(enemy.position, me.team, metas)
            {
                continue;
            }
            if best.map(|(s, _)| score < s).unwrap_or(true) {
                best = Some((score, *enemy));
            }
        }
        best.map(|(_, m)| m)
    }

    fn in_enemy_base_defense(&self, position: Vec2, team: Team, metas: &[Meta]) -> bool {
        let range = self.config.base.range + 60.0;
        self.config.base.damage > 0.0
            && metas.iter().any(|m| {
                m.kind == EntityKind::Base
                    && m.team != team
                    && distance(m.position, position) <= range
            })
    }

    fn in_enemy_poison(&self, position: Vec2, team: Team, metas: &[Meta]) -> bool {
        metas.iter().any(|m| {
            m.kind == EntityKind::PoisonZone
                && m.team != team
                && distance(m.position, position) <= m.radius
        })
    }

    fn move_dir_toward(&self, from: Vec2, to: Vec2, team: Team, homeward: bool) -> Vec2 {
        let direct = normalize(sub(to, from));
        // 直线前方 80px 有阻挡时改用流场绕行。
        let probe = Vec2 {
            x: from.x + direct.x * 80.0,
            y: from.y + direct.y * 80.0,
        };
        if !self.grid.is_blocked_at(probe) && distance(from, to) < 500.0 {
            return direct;
        }
        let field = match (team, homeward) {
            (Team::Red, false) | (Team::Blue, true) => &self.flow_to_blue,
            (Team::Blue, false) | (Team::Red, true) => &self.flow_to_red,
        };
        if self.grid.is_blocked_at(probe) || distance(from, to) >= 500.0 {
            let flow = field.direction(from);
            // 只有流场方向与目标方向大致一致时才使用流场。
            if dot(flow, direct) > -0.2 || self.grid.is_blocked_at(probe) {
                return flow;
            }
        }
        direct
    }

    fn move_heroes(&mut self) {
        let (width, height) = (self.config.world.width, self.config.world.height);
        for id in self.hero_ids(None) {
            let entity = self.entities[&id];
            let Some((input, respawn, kind)) = self
                .world
                .get::<&HeroState>(entity)
                .ok()
                .map(|h| (h.input.clone(), h.respawn, h.kind))
            else {
                continue;
            };
            let status = self
                .world
                .get::<&Status>(entity)
                .map(|s| *s)
                .unwrap_or_default();
            let position = self
                .world
                .get::<&Position>(entity)
                .map(|p| p.0)
                .unwrap_or_default();
            if respawn > 0 || status.stun > 0 {
                self.set_component(entity, Velocity::default());
                continue;
            }
            let speed = self.config.hero_speed(kind) * status.speed_mul();
            let direction = clamp_length(Vec2 {
                x: input.move_x,
                y: input.move_y,
            });
            let delta = Vec2 {
                x: direction.x * speed * DT,
                y: direction.y * speed * DT,
            };
            let next = self.grid.slide(position, delta, width, height);
            self.set_component(entity, Position(next));
            self.set_component(
                entity,
                Velocity(Vec2 {
                    x: (next.x - position.x) / DT,
                    y: (next.y - position.y) / DT,
                }),
            );
            if input.aim_x != 0.0 || input.aim_y != 0.0 {
                let facing = (input.aim_y - next.y).atan2(input.aim_x - next.x);
                self.set_component(entity, Facing(facing));
            }
        }
    }

    fn use_skills(&mut self) {
        for id in self.hero_ids(None) {
            let entity = self.entities[&id];
            let Some((kind, input, cooldowns, respawn)) = self
                .world
                .get::<&HeroState>(entity)
                .ok()
                .map(|h| (h.kind, h.input.clone(), h.cooldowns, h.respawn))
            else {
                continue;
            };
            let stunned = self
                .world
                .get::<&Status>(entity)
                .map(|s| s.stun > 0)
                .unwrap_or(false);
            if respawn > 0 || stunned || input.skills == 0 {
                continue;
            }
            let team = self.team_of(id).unwrap_or(Team::Red);
            #[allow(clippy::needless_range_loop)]
            for slot in 0..3 {
                if input.skills & (1 << slot) == 0 || cooldowns[slot] > 0 {
                    continue;
                }
                let skill = self.config.skill(kind, slot).clone();
                let position = self
                    .world
                    .get::<&Position>(entity)
                    .map(|p| p.0)
                    .unwrap_or_default();
                self.cast_skill(id, entity, team, position, &input, &skill);
                if let Ok(mut hero) = self.world.get::<&mut HeroState>(entity) {
                    hero.cooldowns[slot] = seconds_to_ticks(skill.cooldown_seconds);
                }
            }
        }
    }

    fn cast_skill(
        &mut self,
        id: u32,
        entity: Entity,
        team: Team,
        position: Vec2,
        input: &InputFrame,
        skill: &SkillConfig,
    ) {
        let aim = Vec2 {
            x: input.aim_x,
            y: input.aim_y,
        };
        let delta = sub(aim, position);
        let direction = normalize(delta);
        let target = if length(delta) <= skill.range {
            aim
        } else {
            Vec2 {
                x: position.x + direction.x * skill.range,
                y: position.y + direction.y * skill.range,
            }
        };
        let source = DamageSource {
            team: Some(team),
            entity: Some(id),
            bypass_shield: false,
        };
        match skill.effect {
            SkillEffect::Damage | SkillEffect::Stun | SkillEffect::Slow | SkillEffect::Nova => {
                let center = if skill.effect == SkillEffect::Nova {
                    position
                } else {
                    target
                };
                let victims: Vec<u32> = self
                    .metas()
                    .into_iter()
                    .filter(|m| {
                        m.team != team
                            && m.alive
                            && m.kind != EntityKind::PoisonZone
                            && self.targetable(m)
                            && distance(m.position, center) <= skill.radius + m.radius
                    })
                    .map(|m| m.id)
                    .collect();
                self.event(
                    EventKind::Skill,
                    Some(team),
                    position,
                    center,
                    skill.radius,
                    &skill.name,
                );
                if let Some(last) = self.events.last_mut() {
                    last.source = id;
                }
                for victim in victims {
                    if skill.damage > 0.0 {
                        self.apply_damage(victim, skill.damage, source);
                    }
                    let ticks = seconds_to_ticks(skill.duration_seconds);
                    if let Some(&ve) = self.entities.get(&victim) {
                        if let Ok(mut status) = self.world.get::<&mut Status>(ve) {
                            if status.control_immune {
                                continue;
                            }
                            match skill.effect {
                                SkillEffect::Stun => status.stun = status.stun.max(ticks),
                                SkillEffect::Slow => {
                                    status.slow = status.slow.max(ticks);
                                    status.slow_amount = skill.amount;
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
            SkillEffect::Dash => {
                let (width, height) = (self.config.world.width, self.config.world.height);
                let steps = 10;
                let mut p = position;
                let dir = if length(direction) > 0.0 {
                    direction
                } else {
                    let f = self
                        .world
                        .get::<&Facing>(entity)
                        .map(|f| f.0)
                        .unwrap_or(0.0);
                    Vec2 {
                        x: f.cos(),
                        y: f.sin(),
                    }
                };
                for _ in 0..steps {
                    p = self.grid.slide(
                        p,
                        Vec2 {
                            x: dir.x * skill.range / steps as f32,
                            y: dir.y * skill.range / steps as f32,
                        },
                        width,
                        height,
                    );
                }
                self.set_component(entity, Position(p));
                // 带伤害的突进（刺客影袭、斗士冲撞）：落点范围内的敌人受到伤害
                if skill.damage > 0.0 && skill.radius > 0.0 {
                    let victims: Vec<u32> = self
                        .metas()
                        .into_iter()
                        .filter(|m| {
                            m.team != team
                                && m.alive
                                && m.kind != EntityKind::PoisonZone
                                && self.targetable(m)
                                && distance(m.position, p) <= skill.radius + m.radius
                        })
                        .map(|m| m.id)
                        .collect();
                    for victim in victims {
                        self.apply_damage(victim, skill.damage, source);
                    }
                }
                self.event(EventKind::Skill, Some(team), position, p, skill.radius, &skill.name);
                if let Some(last) = self.events.last_mut() {
                    last.source = id;
                }
            }
            SkillEffect::Heal => {
                let allies: Vec<u32> = self
                    .metas()
                    .into_iter()
                    .filter(|m| {
                        m.team == team
                            && m.kind == EntityKind::Hero
                            && m.alive
                            && distance(m.position, position) <= skill.radius
                    })
                    .map(|m| m.id)
                    .collect();
                for ally in allies {
                    if let Some(&ae) = self.entities.get(&ally) {
                        if let Ok(mut health) = self.world.get::<&mut Health>(ae) {
                            health.current =
                                (health.current + health.max * skill.amount).min(health.max);
                        }
                    }
                }
                self.event(
                    EventKind::Skill,
                    Some(team),
                    position,
                    position,
                    skill.radius,
                    &skill.name,
                );
                if let Some(last) = self.events.last_mut() {
                    last.source = id;
                }
            }
        }
    }

    fn update_combat(&mut self) {
        let metas = self.metas();
        let (width, height) = (self.config.world.width, self.config.world.height);
        let aggro = self.config.wave.aggro_range;
        let mut attackers: Vec<Meta> = metas
            .iter()
            .filter(|m| {
                m.alive
                    && matches!(
                        m.kind,
                        EntityKind::Hero
                            | EntityKind::Tower
                            | EntityKind::Base
                            | EntityKind::Minion
                            | EntityKind::SuperMinion
                    )
            })
            .copied()
            .collect();
        attackers.sort_by_key(|m| m.id);
        for attacker in attackers {
            // 攻击者可能在本 tick 内已死亡。
            if !self.is_alive(attacker.id) {
                continue;
            }
            let entity = attacker.entity;
            if let Ok(mut combat) = self.world.get::<&mut Combat>(entity) {
                combat.cooldown = combat.cooldown.saturating_sub(1);
                if attacker.kind != EntityKind::Hero {
                    combat.attacked_this_tick = false;
                }
            }
            let Some(combat) = self.world.get::<&Combat>(entity).ok().map(|c| *c) else {
                continue;
            };
            let stunned = self
                .world
                .get::<&Status>(entity)
                .map(|s| s.stun > 0)
                .unwrap_or(false);
            if stunned {
                self.set_component(entity, Velocity::default());
                continue;
            }
            let position = self
                .world
                .get::<&Position>(entity)
                .map(|p| p.0)
                .unwrap_or(attacker.position);
            match attacker.kind {
                EntityKind::Hero => {
                    let Some(input) = self
                        .world
                        .get::<&HeroState>(entity)
                        .ok()
                        .map(|h| h.input.clone())
                    else {
                        continue;
                    };
                    if !input.attack {
                        continue;
                    }
                    let aim = Vec2 {
                        x: input.aim_x,
                        y: input.aim_y,
                    };
                    // 普攻：射程内离瞄准点最近的敌人。
                    let target = metas
                        .iter()
                        .filter(|m| {
                            m.team != attacker.team
                                && m.kind != EntityKind::PoisonZone
                                && self.is_alive(m.id)
                                && self.targetable(m)
                                && distance(position, m.position) <= combat.range + m.radius
                        })
                        .min_by(|a, b| {
                            distance(aim, a.position)
                                .total_cmp(&distance(aim, b.position))
                                .then(a.id.cmp(&b.id))
                        })
                        .copied();
                    if let Some(target) = target {
                        self.try_attack(&attacker, position, &target, combat, false);
                    }
                }
                EntityKind::Tower | EntityKind::Base => {
                    // 塔/基地：优先攻击魔兽，其次魔法玩偶。
                    let target = metas
                        .iter()
                        .filter(|m| {
                            m.team != attacker.team
                                && matches!(
                                    m.kind,
                                    EntityKind::Hero | EntityKind::Minion | EntityKind::SuperMinion
                                )
                                && self.is_alive(m.id)
                                && distance(position, m.position) <= combat.range + m.radius
                        })
                        .min_by(|a, b| {
                            let pa = u8::from(a.kind == EntityKind::Hero);
                            let pb = u8::from(b.kind == EntityKind::Hero);
                            pa.cmp(&pb)
                                .then(
                                    distance(position, a.position)
                                        .total_cmp(&distance(position, b.position)),
                                )
                                .then(a.id.cmp(&b.id))
                        })
                        .copied();
                    if let Some(target) = target {
                        self.try_attack(&attacker, position, &target, combat, false);
                    }
                }
                EntityKind::Minion | EntityKind::SuperMinion => {
                    let is_super = attacker.kind == EntityKind::SuperMinion;
                    let enemy_base = metas
                        .iter()
                        .find(|m| m.kind == EntityKind::Base && m.team != attacker.team)
                        .copied();
                    let target = if is_super {
                        // 超级双头魔兽：无视一切，只攻击敌方基地。
                        enemy_base
                            .filter(|b| distance(position, b.position) <= combat.range + b.radius)
                    } else {
                        metas
                            .iter()
                            .filter(|m| {
                                m.team != attacker.team
                                    && m.kind != EntityKind::PoisonZone
                                    && self.is_alive(m.id)
                                    && self.targetable(m)
                                    && distance(position, m.position) <= aggro + m.radius
                            })
                            .min_by(|a, b| {
                                distance(position, a.position)
                                    .total_cmp(&distance(position, b.position))
                                    .then(a.id.cmp(&b.id))
                            })
                            .copied()
                    };
                    let mut moved = false;
                    if let Some(target) = target {
                        let gap =
                            distance(position, target.position) - target.radius - attacker.radius;
                        if gap <= combat.range {
                            self.try_attack(&attacker, position, &target, combat, is_super);
                            self.set_component(entity, Velocity::default());
                            self.set_component(
                                entity,
                                Facing(angle(sub(target.position, position))),
                            );
                            continue;
                        }
                        if !is_super {
                            let direct = normalize(sub(target.position, position));
                            let probe = Vec2 {
                                x: position.x + direct.x * 40.0,
                                y: position.y + direct.y * 40.0,
                            };
                            let dir = if self.grid.is_blocked_at(probe) {
                                self.lane_flow(attacker.team).direction(position)
                            } else {
                                direct
                            };
                            self.move_unit(entity, position, dir, width, height);
                            moved = true;
                        }
                    }
                    if !moved {
                        let dir = self.lane_flow(attacker.team).direction(position);
                        let near_goal = enemy_base
                            .map(|b| {
                                distance(position, b.position)
                                    <= b.radius + attacker.radius + combat.range
                            })
                            .unwrap_or(false);
                        if near_goal {
                            self.set_component(entity, Velocity::default());
                        } else {
                            self.move_unit(entity, position, dir, width, height);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    fn lane_flow(&self, team: Team) -> &FlowField {
        match team {
            Team::Red => &self.flow_to_blue,
            Team::Blue => &self.flow_to_red,
        }
    }

    fn move_unit(&mut self, entity: Entity, position: Vec2, dir: Vec2, width: f32, height: f32) {
        let speed = self
            .world
            .get::<&MoveSpeed>(entity)
            .map(|s| s.0)
            .unwrap_or(0.0);
        let mul = self
            .world
            .get::<&Status>(entity)
            .map(|s| s.speed_mul())
            .unwrap_or(1.0);
        let delta = Vec2 {
            x: dir.x * speed * mul * DT,
            y: dir.y * speed * mul * DT,
        };
        let next = self.grid.slide(position, delta, width, height);
        self.set_component(entity, Position(next));
        self.set_component(
            entity,
            Velocity(Vec2 {
                x: (next.x - position.x) / DT,
                y: (next.y - position.y) / DT,
            }),
        );
        if length(dir) > 0.0 {
            self.set_component(entity, Facing(angle(dir)));
        }
    }

    fn try_attack(
        &mut self,
        attacker: &Meta,
        position: Vec2,
        target: &Meta,
        combat: Combat,
        bypass: bool,
    ) {
        if combat.cooldown > 0 {
            return;
        }
        if let Ok(mut c) = self.world.get::<&mut Combat>(attacker.entity) {
            c.cooldown = c.interval;
            c.attacked_this_tick = true;
        }
        self.set_component(
            attacker.entity,
            Facing(angle(sub(target.position, position))),
        );
        self.event(
            EventKind::Shot,
            Some(attacker.team),
            position,
            target.position,
            combat.damage,
            "",
        );
        if let Some(last) = self.events.last_mut() {
            last.source = attacker.id;
            last.target = target.id;
        }
        self.apply_damage(
            target.id,
            combat.damage,
            DamageSource {
                team: Some(attacker.team),
                entity: Some(attacker.id),
                bypass_shield: bypass,
            },
        );
    }

    /// 魔兽之间的简单分离，避免数百单位叠在同一点。
    fn separate_units(&mut self) {
        let units: Vec<(u32, Entity, Team, Vec2, f32)> = self
            .metas()
            .into_iter()
            .filter(|m| m.alive && matches!(m.kind, EntityKind::Minion | EntityKind::SuperMinion))
            .map(|m| (m.id, m.entity, m.team, m.position, m.radius))
            .collect();
        let mut pushes = vec![Vec2::default(); units.len()];
        for i in 0..units.len() {
            for j in (i + 1)..units.len() {
                let (a, b) = (&units[i], &units[j]);
                let d = sub(b.3, a.3);
                let dist = length(d);
                let min = (a.4 + b.4) * 0.9;
                if dist < min {
                    let n = if dist > 1e-3 {
                        Vec2 {
                            x: d.x / dist,
                            y: d.y / dist,
                        }
                    } else {
                        Vec2 {
                            x: if a.0 < b.0 { 1.0 } else { -1.0 },
                            y: 0.0,
                        }
                    };
                    let overlap = (min - dist) * 0.5;
                    pushes[i].x -= n.x * overlap;
                    pushes[i].y -= n.y * overlap;
                    pushes[j].x += n.x * overlap;
                    pushes[j].y += n.y * overlap;
                }
            }
        }
        let (width, height) = (self.config.world.width, self.config.world.height);
        for (unit, push) in units.iter().zip(pushes) {
            if length(push) > 0.01 {
                let clamped = Vec2 {
                    x: push.x.clamp(-6.0, 6.0),
                    y: push.y.clamp(-6.0, 6.0),
                };
                let next = self.grid.slide(unit.3, clamped, width, height);
                self.set_component(unit.1, Position(next));
            }
        }
    }

    /// 毒区：魔法玩偶在敌方毒区内每停留满 1 秒结算一次伤害，离开即重置。
    fn apply_poison(&mut self) {
        let zones: Vec<(Team, Vec2, f32, f32)> = self
            .world
            .query::<(&PoisonZone, &Allegiance, &Position)>()
            .iter()
            .map(|(_, (z, a, p))| (a.0, p.0, z.radius, z.dps))
            .collect();
        let hurts_allies = self.config.poison.hurts_allies;
        let mut victims: Vec<(u32, f32, Vec2)> = Vec::new();
        for id in self.hero_ids(None) {
            let entity = self.entities[&id];
            let team = self.team_of(id).unwrap_or(Team::Red);
            let position = self
                .world
                .get::<&Position>(entity)
                .map(|p| p.0)
                .unwrap_or_default();
            let alive = self.is_alive(id);
            let dps: f32 = zones
                .iter()
                .filter(|(zt, zp, r, _)| {
                    (hurts_allies || *zt != team) && distance(*zp, position) <= *r
                })
                .map(|z| z.3)
                .sum();
            if let Ok(mut hero) = self.world.get::<&mut HeroState>(entity) {
                if dps > 0.0 && alive {
                    hero.poison_ticks += 1;
                    if hero.poison_ticks % TICK_RATE == 0 {
                        victims.push((id, dps, position));
                    }
                } else {
                    hero.poison_ticks = 0;
                }
            }
        }
        if self.config.poison.hurts_minions {
            for m in self.metas() {
                if m.kind == EntityKind::Minion && m.alive && self.tick.is_multiple_of(TICK_RATE) {
                    let dps: f32 = zones
                        .iter()
                        .filter(|(zt, zp, r, _)| *zt != m.team && distance(*zp, m.position) <= *r)
                        .map(|z| z.3)
                        .sum();
                    if dps > 0.0 {
                        victims.push((m.id, dps, m.position));
                    }
                }
            }
        }
        for (id, dps, position) in victims {
            self.event(EventKind::Poison, None, position, position, dps, "");
            if let Some(last) = self.events.last_mut() {
                last.target = id;
            }
            self.apply_damage(
                id,
                dps,
                DamageSource {
                    team: None,
                    entity: None,
                    bypass_shield: false,
                },
            );
        }
    }

    fn apply_sudden_death_decay(&mut self) {
        let decay = self.config.sudden_death.base_decay_per_second;
        if self.phase != Phase::SuddenDeath || decay <= 0.0 {
            return;
        }
        let bases: Vec<u32> = self
            .metas()
            .into_iter()
            .filter(|m| m.kind == EntityKind::Base)
            .map(|m| m.id)
            .collect();
        for id in bases {
            self.apply_damage(
                id,
                decay,
                DamageSource {
                    team: None,
                    entity: None,
                    bypass_shield: true,
                },
            );
            if self.phase == Phase::Ended {
                break;
            }
        }
    }

    fn apply_damage(&mut self, id: u32, damage: f32, source: DamageSource) -> bool {
        if !damage.is_finite() || damage <= 0.0 || self.phase == Phase::Ended {
            return false;
        }
        let Some(entity) = self.entities.get(&id).copied() else {
            return false;
        };
        let kind = match self.world.get::<&Kind>(entity) {
            Ok(k) => k.0,
            Err(_) => return false,
        };
        if kind == EntityKind::PoisonZone {
            return false;
        }
        let team = self.team_of(id).unwrap_or(Team::Red);
        if source.team == Some(team) {
            return false;
        }
        if kind == EntityKind::Base && !source.bypass_shield && self.is_base_invulnerable(team) {
            return false;
        }
        let (before, after) = {
            let Ok(mut health) = self.world.get::<&mut Health>(entity) else {
                return false;
            };
            if health.current <= 0.0 {
                return false;
            }
            let before = health.current;
            health.current = (health.current - damage).max(0.0);
            (before, health.current)
        };
        let dealt = before - after;
        if let Some(src) = source.entity.and_then(|s| self.entities.get(&s).copied()) {
            if let Ok(mut hero) = self.world.get::<&mut HeroState>(src) {
                hero.stats.damage += dealt;
            }
        }
        let position = self
            .world
            .get::<&Position>(entity)
            .map(|p| p.0)
            .unwrap_or_default();
        self.event(EventKind::Hit, source.team, position, position, dealt, "");
        if let Some(last) = self.events.last_mut() {
            last.target = id;
            last.source = source.entity.unwrap_or(0);
        }
        if after > 0.0 {
            return true;
        }
        match kind {
            EntityKind::Hero => {
                let respawn = self.config.world.respawn_seconds * TICK_RATE;
                if let Ok(mut hero) = self.world.get::<&mut HeroState>(entity) {
                    hero.respawn = respawn.max(1);
                    hero.queue.clear();
                    hero.input.attack = false;
                    hero.input.skills = 0;
                    hero.input.move_x = 0.0;
                    hero.input.move_y = 0.0;
                    hero.stats.deaths += 1;
                    hero.poison_ticks = 0;
                }
                let killer = source.entity.and_then(|s| self.entities.get(&s).copied());
                if let Some(killer) = killer {
                    if let Ok(mut hero) = self.world.get::<&mut HeroState>(killer) {
                        hero.stats.kills += 1;
                    }
                }
                match source.team {
                    Some(Team::Red) => self.red_score += 1,
                    Some(Team::Blue) => self.blue_score += 1,
                    None => match team {
                        Team::Red => self.blue_score += 1,
                        Team::Blue => self.red_score += 1,
                    },
                }
                let name = self
                    .hero_state(id)
                    .map(|h| h.name.clone())
                    .unwrap_or_default();
                self.event(
                    EventKind::Death,
                    Some(team),
                    position,
                    position,
                    0.0,
                    &format!("{name} 被击倒"),
                );
                if let Some(last) = self.events.last_mut() {
                    last.target = id;
                    last.source = source.entity.unwrap_or(0);
                }
            }
            EntityKind::Base => {
                self.winner = Some(team.enemy());
                self.finish("基地被摧毁");
            }
            EntityKind::Tower => {
                let zone = self.world.get::<&Tower>(entity).map(|t| t.zone).ok();
                self.towers_lost[if team == Team::Red { 0 } else { 1 }] += 1;
                let side = if team == Team::Red {
                    "红方"
                } else {
                    "蓝方"
                };
                let remaining =
                    2u32.saturating_sub(self.towers_lost[if team == Team::Red { 0 } else { 1 }]);
                let text = if remaining == 0 {
                    format!("{side}魔法塔全部陨落，基地护盾破碎！")
                } else {
                    format!("{side}魔法塔被摧毁，毒区消散")
                };
                self.event(
                    EventKind::TowerDestroyed,
                    Some(team),
                    position,
                    position,
                    remaining as f32,
                    &text,
                );
                self.despawn(id);
                if let Some(zone) = zone {
                    self.despawn(zone);
                }
            }
            EntityKind::SuperMinion => {
                self.despawn(id);
                if self.phase == Phase::SuddenDeath {
                    let at = self.tick + self.config.sudden_death.respawn_seconds * TICK_RATE;
                    if !self.super_respawns.iter().any(|(t, _)| *t == team) {
                        self.super_respawns.push((team, at));
                    }
                }
            }
            EntityKind::Minion => self.despawn(id),
            EntityKind::PoisonZone => {}
        }
        true
    }

    // ------------------------------------------------------------ 工具

    fn spawn_entity(
        &mut self,
        kind: EntityKind,
        team: Team,
        position: Vec2,
        hp: f32,
        radius: f32,
    ) -> Entity {
        let id = self.next_id;
        self.next_id += 1;
        let entity = self.world.spawn((
            NetworkId(id),
            Kind(kind),
            Allegiance(team),
            Position(position),
            Velocity::default(),
            Health {
                current: hp,
                max: hp,
            },
            Radius(radius),
        ));
        self.entities.insert(id, entity);
        entity
    }

    fn despawn(&mut self, id: u32) {
        if let Some(entity) = self.entities.remove(&id) {
            let _ = self.world.despawn(entity);
            self.last_sent.remove(&id);
            if !self.removed.contains(&id) {
                self.removed.push(id);
            }
        }
    }

    fn set_component<T: hecs::Component>(&mut self, entity: Entity, value: T) {
        if let Ok(mut current) = self.world.get::<&mut T>(entity) {
            *current = value;
            return;
        }
        let _ = self.world.insert_one(entity, value);
    }

    fn network_id(&self, entity: Entity) -> u32 {
        self.world
            .get::<&NetworkId>(entity)
            .map(|n| n.0)
            .unwrap_or(0)
    }

    fn player_hecs_entity(&self, player_id: u64) -> Option<Entity> {
        self.players
            .get(&player_id)
            .and_then(|id| self.entities.get(id))
            .copied()
    }

    fn hero_ids(&self, team: Option<Team>) -> Vec<u32> {
        let mut ids: Vec<u32> = self
            .world
            .query::<(&HeroState, &Allegiance, &NetworkId)>()
            .iter()
            .filter(|(_, (_, a, _))| team.map(|t| t == a.0).unwrap_or(true))
            .map(|(_, (_, _, n))| n.0)
            .collect();
        ids.sort_unstable();
        ids
    }

    fn hero_state(&self, id: u32) -> Option<hecs::Ref<'_, HeroState>> {
        self.entities
            .get(&id)
            .and_then(|e| self.world.get::<&HeroState>(*e).ok())
    }

    fn team_of(&self, id: u32) -> Option<Team> {
        self.entities
            .get(&id)
            .and_then(|e| self.world.get::<&Allegiance>(*e).ok().map(|a| a.0))
    }

    fn is_alive(&self, id: u32) -> bool {
        let Some(&entity) = self.entities.get(&id) else {
            return false;
        };
        let hp = self
            .world
            .get::<&Health>(entity)
            .map(|h| h.current)
            .unwrap_or(0.0);
        let respawning = self
            .world
            .get::<&HeroState>(entity)
            .map(|h| h.respawn > 0)
            .unwrap_or(false);
        hp > 0.0 && !respawning
    }

    fn targetable(&self, meta: &Meta) -> bool {
        !(meta.kind == EntityKind::Base && self.is_base_invulnerable(meta.team))
    }

    fn metas(&self) -> Vec<Meta> {
        let mut metas: Vec<Meta> = self
            .world
            .query::<(
                &NetworkId,
                &Kind,
                &Allegiance,
                &Position,
                &Health,
                &Radius,
                Option<&HeroState>,
            )>()
            .iter()
            .map(
                |(entity, (id, kind, team, position, health, radius, hero))| Meta {
                    id: id.0,
                    entity,
                    kind: kind.0,
                    team: team.0,
                    position: position.0,
                    hp: health.current,
                    radius: radius.0,
                    alive: health.current > 0.0 && hero.map(|h| h.respawn == 0).unwrap_or(true),
                },
            )
            .collect();
        metas.sort_by_key(|m| m.id);
        metas
    }

    fn make_snapshot(&self, entity: Entity) -> Option<EntitySnapshot> {
        let id = self.world.get::<&NetworkId>(entity).ok()?.0;
        let kind = self.world.get::<&Kind>(entity).ok()?.0;
        let team = self.world.get::<&Allegiance>(entity).ok()?.0;
        let position = self.world.get::<&Position>(entity).ok()?.0;
        let velocity = self
            .world
            .get::<&Velocity>(entity)
            .map(|v| v.0)
            .unwrap_or_default();
        let health = *self.world.get::<&Health>(entity).ok()?;
        let radius = self.world.get::<&Radius>(entity).ok()?.0;
        let facing = self
            .world
            .get::<&Facing>(entity)
            .map(|f| f.0)
            .unwrap_or(0.0);
        let status = self
            .world
            .get::<&Status>(entity)
            .map(|s| *s)
            .unwrap_or_default();
        let attacking = self
            .world
            .get::<&Combat>(entity)
            .map(|c| c.attacked_this_tick)
            .unwrap_or(false);
        let hero = self.world.get::<&HeroState>(entity).ok();
        let mut bits = 0u8;
        if status.stun > 0 {
            bits |= flags::STUNNED;
        }
        if status.slow > 0 {
            bits |= flags::SLOWED;
        }
        if status.control_immune {
            bits |= flags::CONTROL_IMMUNE;
        }
        if kind == EntityKind::Base && self.is_base_invulnerable(team) {
            bits |= flags::INVULNERABLE;
        }
        if hero.as_ref().map(|h| h.ai).unwrap_or(false) {
            bits |= flags::AI;
        }
        let level = match kind {
            EntityKind::Minion => self
                .world
                .get::<&Minion>(entity)
                .map(|m| m.wave as u16)
                .unwrap_or(0),
            EntityKind::Hero => hero
                .as_ref()
                .map(|h| h.stats.kills.min(u16::MAX as u32) as u16)
                .unwrap_or(0),
            _ => 0,
        };
        Some(EntitySnapshot {
            id,
            kind,
            team,
            x: round1(position.x),
            y: round1(position.y),
            vx: round1(velocity.x),
            vy: round1(velocity.y),
            hp: health.current.ceil(),
            max_hp: health.max,
            radius,
            hero: hero.as_ref().map(|h| h.kind),
            owner: hero.as_ref().and_then(|h| h.owner),
            name: hero.as_ref().map(|h| h.name.clone()),
            cooldowns: hero
                .as_ref()
                .map(|h| h.cooldowns.map(|v| v.min(u16::MAX as u32) as u16))
                .unwrap_or([0; 3]),
            respawn: hero
                .as_ref()
                .map(|h| h.respawn.min(u16::MAX as u32) as u16)
                .unwrap_or(0),
            facing: (facing * 100.0).round() / 100.0,
            attacking,
            flags: bits,
            speed_mul: status.speed_mul(),
            level,
        })
    }

    fn team_spawn(&self, team: Team, slot: u32) -> Vec2 {
        let base = base_position(&self.config, team);
        let dir = if team == Team::Red { 1.0 } else { -1.0 };
        let offsets = [-70.0, 70.0, -140.0, 140.0, 0.0];
        Vec2 {
            x: base.x + dir * (self.config.base.radius + 70.0),
            y: base.y + offsets[slot as usize % offsets.len()],
        }
    }

    fn center(&self) -> Vec2 {
        Vec2 {
            x: self.config.world.width * 0.5,
            y: self.config.world.height * 0.5,
        }
    }

    fn announce(&mut self, text: &str) {
        let c = self.center();
        self.event(EventKind::Announcement, None, c, c, 0.0, text);
    }

    fn event(
        &mut self,
        kind: EventKind,
        team: Option<Team>,
        position: Vec2,
        target: Vec2,
        value: f32,
        text: &str,
    ) {
        let id = self.next_event_id;
        self.next_event_id = self.next_event_id.wrapping_add(1);
        self.events.push(GameEvent {
            id,
            kind,
            x: round1(position.x),
            y: round1(position.y),
            tx: round1(target.x),
            ty: round1(target.y),
            value: round1(value),
            source: 0,
            target: 0,
            text: text.to_owned(),
            team,
        });
    }
}

impl Default for Simulation {
    fn default() -> Self {
        Self::new(GameConfig::default())
    }
}

pub const DEFAULT_TEAM_NAMES: [&str; 2] = ["绯红玩偶团", "湛蓝玩偶团"];
const HELP_COOLDOWN_TICKS: u32 = TICK_RATE * 8;

fn team_index(team: Team) -> usize {
    if team == Team::Red {
        0
    } else {
        1
    }
}

pub fn base_position(config: &GameConfig, team: Team) -> Vec2 {
    let y = config.world.height * 0.5;
    match team {
        Team::Red => Vec2 {
            x: config.base.offset_x,
            y,
        },
        Team::Blue => Vec2 {
            x: config.world.width - config.base.offset_x,
            y,
        },
    }
}

pub fn tower_positions(config: &GameConfig, team: Team) -> [Vec2; 2] {
    let x = match team {
        Team::Red => config.tower.offset_x,
        Team::Blue => config.world.width - config.tower.offset_x,
    };
    let c = config.world.height * 0.5;
    [
        Vec2 {
            x,
            y: c - config.tower.lane_offset_y,
        },
        Vec2 {
            x,
            y: c + config.tower.lane_offset_y,
        },
    ]
}

fn sanitize_name(name: &str) -> String {
    let trimmed: String = name
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(16)
        .collect();
    if trimmed.is_empty() {
        "无名玩偶".to_owned()
    } else {
        trimmed
    }
}

fn sanitize_input(input: &mut InputFrame) {
    for value in [
        &mut input.move_x,
        &mut input.move_y,
        &mut input.aim_x,
        &mut input.aim_y,
    ] {
        if !value.is_finite() {
            *value = 0.0;
        }
    }
    input.move_x = input.move_x.clamp(-1.0, 1.0);
    input.move_y = input.move_y.clamp(-1.0, 1.0);
    input.aim_x = input.aim_x.clamp(-10_000.0, 10_000.0);
    input.aim_y = input.aim_y.clamp(-10_000.0, 10_000.0);
    input.skills &= 0b111;
}

fn nearly_equal(a: &EntitySnapshot, b: &EntitySnapshot) -> bool {
    a == b
}

fn round1(v: f32) -> f32 {
    (v * 10.0).round() / 10.0
}

fn clamp_length(v: Vec2) -> Vec2 {
    let l = length(v);
    if l > 1.0 {
        Vec2 {
            x: v.x / l,
            y: v.y / l,
        }
    } else {
        v
    }
}

fn sub(a: Vec2, b: Vec2) -> Vec2 {
    Vec2 {
        x: a.x - b.x,
        y: a.y - b.y,
    }
}
fn dot(a: Vec2, b: Vec2) -> f32 {
    a.x * b.x + a.y * b.y
}
fn distance(a: Vec2, b: Vec2) -> f32 {
    length(sub(a, b))
}
fn length(v: Vec2) -> f32 {
    (v.x * v.x + v.y * v.y).sqrt()
}
fn angle(v: Vec2) -> f32 {
    v.y.atan2(v.x)
}

#[cfg(test)]
mod tests;
