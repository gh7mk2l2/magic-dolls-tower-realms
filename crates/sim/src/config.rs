use serde::{Deserialize, Serialize};
use shared::{HeroInfo, HeroKind, Rect, SkillInfo, TICK_RATE};

/// 内置配置（与 `config/game.toml` 同一份文件），WASM 单机模式与单元测试使用。
pub const BUILTIN_CONFIG: &str = include_str!("../../../config/game.toml");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameConfig {
    pub world: WorldConfig,
    pub base: BaseConfig,
    pub tower: TowerConfig,
    pub poison: PoisonConfig,
    pub wave: WaveConfig,
    pub sudden_death: SuddenDeathConfig,
    pub hero: HeroDefaults,
    pub heroes: Vec<HeroConfig>,
    #[serde(default)]
    pub obstacles: Vec<RectConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorldConfig {
    pub width: f32,
    pub height: f32,
    pub grid: usize,
    pub match_seconds: u32,
    /// 复活基数（秒）：某队第 n 次有玩偶阵亡，复活时间 = base * multiplier^(n-1)。
    #[serde(default = "one_u32")]
    pub respawn_base_secs: u32,
    /// 复活时间倍数（默认 2：1、2、4、8…秒）。
    #[serde(default = "two_u32")]
    pub respawn_multiplier: u32,
    pub ai_fill_to: usize,
    pub max_team_size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaseConfig {
    pub hp: f32,
    pub radius: f32,
    pub offset_x: f32,
    /// 基地自带的防御魔晶（防止出生点被蹲守）。
    #[serde(default)]
    pub damage: f32,
    #[serde(default)]
    pub range: f32,
    #[serde(default = "one")]
    pub attack_seconds: f32,
}

fn one() -> f32 {
    1.0
}

fn one_u32() -> u32 {
    1
}

fn two_u32() -> u32 {
    2
}

impl WorldConfig {
    /// 某队第 `death_index` 次（从 1 开始）阵亡时的复活 tick 数。
    ///
    /// 全程饱和运算：倍数的幂、乘以 tick 频率都不会溢出或 panic，极端情况下停在 `u32::MAX`。
    /// 至少 1 tick（基数为 0 时即"立即复活"）。
    pub fn respawn_ticks(&self, death_index: u32) -> u32 {
        let exponent = death_index.saturating_sub(1);
        let factor = u64::from(self.respawn_multiplier).saturating_pow(exponent);
        let ticks = u64::from(self.respawn_base_secs)
            .saturating_mul(u64::from(TICK_RATE))
            .saturating_mul(factor);
        u32::try_from(ticks).unwrap_or(u32::MAX).max(1)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TowerConfig {
    pub hp: f32,
    pub radius: f32,
    pub damage: f32,
    pub range: f32,
    pub attack_seconds: f32,
    pub offset_x: f32,
    pub lane_offset_y: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoisonConfig {
    pub radius: f32,
    pub dps: f32,
    #[serde(default)]
    pub hurts_allies: bool,
    #[serde(default)]
    pub hurts_minions: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaveConfig {
    pub interval_seconds: u32,
    pub count_per_tower: u32,
    pub first_wave_seconds: u32,
    pub aggro_range: f32,
    pub hp: f32,
    pub damage: f32,
    pub speed: f32,
    pub radius: f32,
    pub range: f32,
    pub attack_seconds: f32,
    pub hp_growth: f32,
    pub damage_growth: f32,
    pub speed_growth: f32,
    pub max_multiplier: f32,
    #[serde(default)]
    pub hp_curve: Vec<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WaveStats {
    pub hp: f32,
    pub damage: f32,
    pub speed: f32,
}

impl WaveConfig {
    /// 第 `wave` 波（从 0 开始）的魔兽属性。
    pub fn stats(&self, wave: u32) -> WaveStats {
        let grow = |rate: f32| (1.0 + wave as f32 * rate).min(self.max_multiplier).max(0.1);
        let hp_mul = if self.hp_curve.is_empty() {
            grow(self.hp_growth)
        } else {
            let index = (wave as usize).min(self.hp_curve.len() - 1);
            self.hp_curve[index].max(0.1)
        };
        WaveStats {
            hp: self.hp * hp_mul,
            damage: self.damage * grow(self.damage_growth),
            speed: self.speed * grow(self.speed_growth),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuddenDeathConfig {
    pub hp: f32,
    pub damage: f32,
    pub speed: f32,
    pub radius: f32,
    pub range: f32,
    pub attack_seconds: f32,
    pub per_tower: u32,
    pub respawn_seconds: u32,
    pub max_seconds: u32,
    #[serde(default)]
    pub base_decay_per_second: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeroDefaults {
    pub hp: f32,
    pub speed: f32,
    pub radius: f32,
    pub attack_damage: f32,
    pub attack_range: f32,
    pub attack_seconds: f32,
    pub ai_aggro_range: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillEffect {
    Damage,
    Stun,
    Slow,
    Dash,
    Heal,
    Nova,
    /// 连锁闪电：命中落点附近最近的敌人，再向 radius 内未命中的敌人弹射 count 次，每次伤害乘以 amount（0 视为 1）。
    Chain,
    /// 召唤：在落点召唤 count 个随从（summon_hp/summon_speed/summon_range，damage 为随从攻击力），存在 duration 秒；summon_speed=0 为固定炮台。
    Summon,
    /// 护盾：自身 radius 内友方英雄获得 amount×最大生命的护盾，持续 duration 秒。
    Shield,
    /// 持续区域：在落点留下 radius 的毒云/火海，持续 duration 秒，每秒造成 damage；amount>0 时附带该比例减速。
    Cloud,
    /// 拉拽：落点 radius 内的敌人被拉向施法者 amount 像素，并造成伤害、眩晕 duration 秒。
    Pull,
    /// 加速：自身 radius 内友方英雄移速提升 amount，持续 duration 秒。
    Haste,
    /// 治疗光环：自身 radius 内友方英雄在 duration 秒内持续回复 amount×最大生命。
    Regen,
    /// 坚守：自身减伤 amount，持续 duration 秒；radius 内敌人被嘲讽同样时长（强制走向施法者，不能施法）。
    Fortify,
    /// 隐身：duration 秒内敌方无法选中，移速提升 amount；普攻或施放其他技能时现身。
    Stealth,
}

impl SkillEffect {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Damage => "damage",
            Self::Stun => "stun",
            Self::Slow => "slow",
            Self::Dash => "dash",
            Self::Heal => "heal",
            Self::Nova => "nova",
            Self::Chain => "chain",
            Self::Summon => "summon",
            Self::Shield => "shield",
            Self::Cloud => "cloud",
            Self::Pull => "pull",
            Self::Haste => "haste",
            Self::Regen => "regen",
            Self::Fortify => "fortify",
            Self::Stealth => "stealth",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillConfig {
    pub key: String,
    pub name: String,
    pub effect: SkillEffect,
    pub cooldown_seconds: f32,
    #[serde(default)]
    pub damage: f32,
    #[serde(default)]
    pub range: f32,
    #[serde(default)]
    pub radius: f32,
    #[serde(default)]
    pub duration_seconds: f32,
    #[serde(default)]
    pub amount: f32,
    /// 连锁弹射次数 / 召唤数量。
    #[serde(default)]
    pub count: u32,
    #[serde(default)]
    pub summon_hp: f32,
    #[serde(default)]
    pub summon_speed: f32,
    #[serde(default)]
    pub summon_range: f32,
}

impl SkillEffect {
    /// 以施法者自身为中心生效（不需要落点）。
    pub fn self_centered(self) -> bool {
        matches!(
            self,
            Self::Nova
                | Self::Heal
                | Self::Shield
                | Self::Haste
                | Self::Regen
                | Self::Fortify
                | Self::Stealth
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeroConfig {
    pub kind: HeroKind,
    pub name: String,
    pub hp: Option<f32>,
    pub speed: Option<f32>,
    pub attack_damage: Option<f32>,
    pub attack_range: Option<f32>,
    pub skills: Vec<SkillConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RectConfig {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Debug)]
pub enum ConfigError {
    Parse(toml::de::Error),
    Invalid(String),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Parse(error) => write!(f, "配置解析失败: {error}"),
            Self::Invalid(message) => write!(f, "配置无效: {message}"),
        }
    }
}

impl std::error::Error for ConfigError {}

pub fn seconds_to_ticks(seconds: f32) -> u32 {
    (seconds * TICK_RATE as f32).round().max(1.0) as u32
}

impl GameConfig {
    pub fn from_toml(text: &str) -> Result<Self, ConfigError> {
        let config: Self = toml::from_str(text).map_err(ConfigError::Parse)?;
        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> Result<(), ConfigError> {
        let fail = |m: &str| Err(ConfigError::Invalid(m.to_owned()));
        if self.world.width < 400.0 || self.world.height < 400.0 {
            return fail("地图尺寸过小");
        }
        if !(8..=256).contains(&self.world.grid) {
            return fail("grid 必须在 8..=256");
        }
        if self.world.max_team_size == 0 || self.world.ai_fill_to > self.world.max_team_size {
            return fail("ai_fill_to 不能超过 max_team_size");
        }
        for kind in HeroKind::ALL {
            let Some(hero) = self.heroes.iter().find(|h| h.kind == kind) else {
                return fail("每种英雄都必须配置");
            };
            if hero.skills.len() != 3 {
                return fail("每个英雄必须恰好配置 3 个技能");
            }
            for skill in &hero.skills {
                if skill.effect == SkillEffect::Summon
                    && (skill.count == 0 || skill.summon_hp <= 0.0)
                {
                    return fail("召唤技能需要 count > 0 且 summon_hp > 0");
                }
            }
        }
        Ok(())
    }

    pub fn hero(&self, kind: HeroKind) -> &HeroConfig {
        self.heroes
            .iter()
            .find(|hero| hero.kind == kind)
            .expect("validate 保证英雄存在")
    }

    pub fn hero_hp(&self, kind: HeroKind) -> f32 {
        self.hero(kind).hp.unwrap_or(self.hero.hp)
    }

    pub fn hero_speed(&self, kind: HeroKind) -> f32 {
        self.hero(kind).speed.unwrap_or(self.hero.speed)
    }

    pub fn hero_attack_damage(&self, kind: HeroKind) -> f32 {
        self.hero(kind)
            .attack_damage
            .unwrap_or(self.hero.attack_damage)
    }

    pub fn hero_attack_range(&self, kind: HeroKind) -> f32 {
        self.hero(kind)
            .attack_range
            .unwrap_or(self.hero.attack_range)
    }

    pub fn skill(&self, kind: HeroKind, slot: usize) -> &SkillConfig {
        &self.hero(kind).skills[slot]
    }

    pub fn obstacle_rects(&self) -> Vec<Rect> {
        self.obstacles
            .iter()
            .map(|r| Rect {
                x: r.x,
                y: r.y,
                w: r.w,
                h: r.h,
            })
            .collect()
    }

    pub fn hero_infos(&self) -> Vec<HeroInfo> {
        HeroKind::ALL
            .iter()
            .map(|&kind| HeroInfo {
                kind,
                name: self.hero(kind).name.clone(),
                hp: self.hero_hp(kind),
                speed: self.hero_speed(kind),
                attack_range: self.hero_attack_range(kind),
                skills: self
                    .hero(kind)
                    .skills
                    .iter()
                    .map(|skill| SkillInfo {
                        key: skill.key.clone(),
                        name: skill.name.clone(),
                        effect: skill.effect.as_str().to_owned(),
                        cooldown_ticks: seconds_to_ticks(skill.cooldown_seconds),
                        range: skill.range,
                        radius: skill.radius,
                    })
                    .collect(),
            })
            .collect()
    }
}

impl Default for GameConfig {
    fn default() -> Self {
        Self::from_toml(BUILTIN_CONFIG).expect("内置游戏配置必须有效")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wave_curve_grows_and_caps() {
        let config = GameConfig::default();
        let first = config.wave.stats(0);
        let later = config.wave.stats(10);
        assert!(later.hp > first.hp && later.damage > first.damage && later.speed > first.speed);
        let capped = config.wave.stats(10_000);
        assert!((capped.hp / config.wave.hp - config.wave.max_multiplier).abs() < 1e-3);
    }

    #[test]
    fn explicit_curve_overrides_linear_growth() {
        let mut config = GameConfig::default();
        config.wave.hp_curve = vec![1.0, 2.0, 5.0];
        assert_eq!(config.wave.stats(1).hp, config.wave.hp * 2.0);
        assert_eq!(config.wave.stats(99).hp, config.wave.hp * 5.0);
    }

    #[test]
    fn respawn_doubles_and_saturates() {
        let config = GameConfig::default();
        let world = &config.world;
        assert_eq!(world.respawn_base_secs, 1);
        assert_eq!(world.respawn_multiplier, 2);
        let secs: Vec<u32> = (1..=5)
            .map(|n| world.respawn_ticks(n) / TICK_RATE)
            .collect();
        assert_eq!(secs, vec![1, 2, 4, 8, 16]);
        // 超大次数：饱和而不是溢出/panic
        assert_eq!(world.respawn_ticks(64), u32::MAX);
        assert_eq!(world.respawn_ticks(u32::MAX), u32::MAX);
        let mut instant = world.clone();
        instant.respawn_base_secs = 0;
        assert_eq!(instant.respawn_ticks(10), 1);
    }

    #[test]
    fn all_twenty_heroes_configured() {
        let config = GameConfig::default();
        assert_eq!(HeroKind::ALL.len(), 20);
        assert_eq!(config.hero_infos().len(), 20);
        let mut names: Vec<&str> = config.heroes.iter().map(|h| h.name.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), 20, "玩偶名字不重复");
    }

    #[test]
    fn rejects_missing_skills() {
        let broken = BUILTIN_CONFIG.replacen("{ key = \"R\", name = \"终焉星爆\"", "#", 1);
        assert!(GameConfig::from_toml(&broken).is_err());
    }
}
