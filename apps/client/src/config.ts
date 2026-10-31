import type { HeroKind } from './protocol';

/** 现有 6 套骨骼（rig-<名字>-<队伍>.png + rig-data.json）。新玩偶缺专属资源时借用其中一套并按定位染色。 */
export type BaseRig = 'Arcanist' | 'Ranger' | 'Guardian' | 'Assassin' | 'Priestess' | 'Brawler';

export interface HeroVisual {
  name: string; title: string; color: number; css: string; icon: string; lore: string; skills: string[]; icons: string[]; desc: string[];
  /** 专属美术资源 id：sprites/rig-<art>-<队伍>.png、sprites/hero-<art>-<队伍>.png，骨骼数据在 rig-data.json 的 <art> 键。 */
  art?: string;
  /** 缺专属资源时借用的骨骼/立绘与动作。 */
  base?: BaseRig;
  /** 借用骨骼时的染色（乘法色，偏浅才不会发黑）。 */
  tint?: number;
  /** 立绘在大厅里的 CSS 滤镜（借用立绘时区分色调）。 */
  filter?: string;
}

/** 表现层配置（纯视觉）。玩法数值以服务端 Welcome.map 为准，这里不重复。 */
export const HEROES: Record<HeroKind, HeroVisual> = {
  Arcanist: {
    name: '星语术士', title: '奥术玩偶 · 爆发', color: 0xa978ff, css: '#ae82ff', icon: '✦',
    lore: '以星辉缝制的魔法玩偶，擅长远程奥术轰炸与禁锢。',
    skills: ['奥术冲击', '星辉禁锢', '终焉星爆'], icons: ['✦', '❖', '✺'],
    desc: ['向指定位置轰出奥术能量，范围内敌人受到 145 点伤害。', '在指定位置降下星辉，造成 60 点伤害并眩晕 1.2 秒。', '以自身为中心引爆星辰，周围 260 范围内敌人受到 260 点伤害。'],
  },
  Ranger: {
    name: '月影游侠', title: '弓手玩偶 · 机动', color: 0x4ee4bd, css: '#56e7c1', icon: '➶',
    lore: '轻盈的布偶射手，箭雨压制、疾步拉扯、寒霜减速。',
    skills: ['流星箭雨', '月影疾步', '寒霜之矢'], icons: ['➶', '»', '❄'],
    desc: ['向远处射出箭雨，落点范围内敌人受到 120 点伤害。', '朝瞄准方向疾步位移 240 距离，用于拉扯和躲技能。', '射出寒霜箭，造成 150 点伤害并减速 45%，持续 2.5 秒。'],
  },
  Guardian: {
    name: '晨曦守卫', title: '盾卫玩偶 · 坚韧', color: 0xffbc69, css: '#ffc476', icon: '♜',
    lore: '填满符文棉絮的厚重玩偶，冲锋破阵并为队友回复生命。',
    skills: ['守护震荡', '盾击冲锋', '生命回响'], icons: ['◎', '➤', '✚'],
    desc: ['跃起砸地，周围 170 范围内敌人受到 105 点伤害。', '举盾朝瞄准方向冲锋 200 距离。', '为周围 260 范围内的友方英雄回复 30% 最大生命。'],
  },
  Assassin: {
    name: '影刃刺客', title: '提线玩偶 · 突袭', color: 0xff5f8a, css: '#ff6a92', icon: '⚔',
    lore: '漆黑的提线木偶，双刃淬毒，影袭切入后用千刃乱舞收割残血。',
    skills: ['影袭突进', '淬毒双刃', '千刃乱舞'], icons: ['➹', '☠', '✴'],
    desc: ['朝瞄准方向突进 300 距离，落点附近敌人受到 110 点伤害。', '向前方挥出毒刃，造成 95 点伤害并减速 40%，持续 2 秒。', '原地旋转连斩，周围 180 范围内敌人受到 300 点伤害。'],
  },
  Priestess: {
    name: '花语祭司', title: '花仙玩偶 · 治疗', color: 0x8ee86e, css: '#98ec78', icon: '❀',
    lore: '瓷质的花仙玩偶，以荆棘缠绕敌人，用花露为队友疗伤。',
    skills: ['荆棘缠绕', '花露愈合', '万花绽放'], icons: ['✾', '❦', '❁'],
    desc: ['在指定位置召唤荆棘，造成 70 点伤害并定身 1 秒。', '为周围 320 范围内的友方英雄回复 22% 最大生命。', '花海绽放，周围 280 范围内敌人受到 180 点伤害。'],
  },
  Brawler: {
    name: '熔岩斗士', title: '陶土玩偶 · 近战', color: 0xff8640, css: '#ff9150', icon: '✹',
    lore: '裂缝里流淌熔岩的陶土巨偶，重拳开路，地裂震晕，熔火冲撞破阵。',
    skills: ['熔岩重拳', '地裂震击', '熔火冲撞'], icons: ['✹', '☄', '♨'],
    desc: ['蓄力一拳砸向前方，落点范围内敌人受到 130 点伤害。', '砸裂指定位置的地面，造成 80 点伤害并眩晕 1 秒。', '朝瞄准方向冲撞 340 距离，落点附近敌人受到 220 点伤害。'],
  },
  // ---------------- 新增 14 名玩偶（暂借现有骨骼并染色；专属美术到位后按 art id 自动替换）
  Stormcaller: {
    name: '雷鸣法师', title: '法师玩偶 · 连锁闪电', color: 0x7fb8ff, css: '#86bcff', icon: 'ϟ',
    lore: '铜线缝合的风暴玩偶，雷霆在敌群之间来回弹跳。',
    skills: ['雷霆链', '静电禁锢', '万雷天罚'], icons: ['ϟ', '⌁', '☈'],
    desc: ['释放闪电命中落点附近的敌人，并在 230 范围内弹射 3 次，每跳 75% 伤害（首跳 125）。', '在指定位置放出静电，造成 55 点伤害并眩晕 0.9 秒。', '召唤万雷：230 点闪电弹射 5 次，每跳保留 85% 伤害。'],
    art: 'stormcaller', base: 'Arcanist', tint: 0xb4d4ff, filter: 'hue-rotate(-60deg) saturate(1.3)',
  },
  FrostWitch: {
    name: '冰晶女巫', title: '法师玩偶 · 减速冻结', color: 0x9be8ff, css: '#a2ecff', icon: '❄',
    lore: '冰晶瓷偶，冰锥迟滞敌人，寒冰将其冻结原地。',
    skills: ['冰锥', '寒冰禁锢', '极寒风暴'], icons: ['❅', '❄', '✲'],
    desc: ['掷出冰锥，造成 125 点伤害并减速 35%，持续 2 秒。', '冻结指定位置的敌人，造成 70 点伤害并冻结 1.4 秒。', '在指定位置召唤 4 秒冰暴，每秒 75 点伤害并减速 50%。'],
    art: 'frostwitch', base: 'Priestess', tint: 0xc4f0ff, filter: 'hue-rotate(110deg) saturate(1.2)',
  },
  Artificer: {
    name: '机关工匠', title: '工匠玩偶 · 召唤炮台', color: 0xe0b060, css: '#e6b866', icon: '⚙',
    lore: '发条齿轮驱动的木偶工匠，随手就能拼出一座机关炮台。',
    skills: ['齿轮飞弹', '机关炮台', '炮台阵列'], icons: ['⚙', '♖', '⛭'],
    desc: ['射出齿轮飞弹，落点范围内敌人受到 115 点伤害。', '在附近架设一座炮台（420 生命，射程 300），持续 10 秒。', '一次架设两座强化炮台（520 生命，射程 320），持续 12 秒。'],
    art: 'tinker', base: 'Ranger', tint: 0xffe2a8, filter: 'hue-rotate(-120deg) saturate(1.1)',
  },
  Paladin: {
    name: '圣光骑士', title: '坦克玩偶 · 护盾', color: 0xfff09a, css: '#fff3a6', icon: '✠',
    lore: '镀金布甲的骑士玩偶，以圣盾庇护同伴，冲锋破阵。',
    skills: ['圣光裁决', '圣盾术', '神圣冲锋'], icons: ['✠', '⛨', '➤'],
    desc: ['以圣光锤击前方，落点范围内敌人受到 110 点伤害。', '为自身与周围 280 范围内的友方套上 25% 最大生命的护盾，持续 4 秒。', '朝瞄准方向冲锋 300 距离，落点附近敌人受到 170 点伤害。'],
    art: 'paladin', base: 'Guardian', tint: 0xfff6c8, filter: 'saturate(1.4) brightness(1.1)',
  },
  Alchemist: {
    name: '毒雾药师', title: '药师玩偶 · 持续毒云', color: 0xa6e04a, css: '#afe655', icon: '⚗',
    lore: '背着药箱的布偶药师，瓶中剧毒落地即化作毒云。',
    skills: ['剧毒药瓶', '腐蚀药剂', '瘟疫毒云'], icons: ['⚗', '☣', '☁'],
    desc: ['掷出药瓶，落点留下 4 秒毒云，每秒 62 点伤害。', '泼洒腐蚀药剂，造成 80 点伤害并减速 35%，持续 2.5 秒。', '释放 260 范围的瘟疫毒云，持续 6 秒，每秒 85 点伤害并减速 25%。'],
    art: 'alchemist', base: 'Priestess', tint: 0xd8f5a0, filter: 'hue-rotate(-30deg) saturate(1.4)',
  },
  Windblade: {
    name: '风行剑客', title: '剑客玩偶 · 突进连斩', color: 0x7ff0d6, css: '#86f3da', icon: '⚔',
    lore: '纸扎的剑客，身形如风，一闪即至，连斩不休。',
    skills: ['疾风突刺', '回旋斩', '风刃连斩'], icons: ['➹', '◌', '≋'],
    desc: ['朝瞄准方向突刺 320 距离，落点附近敌人受到 115 点伤害。', '回旋挥剑，周围 170 范围内敌人受到 120 点伤害。', '化作风刃突进 380 距离，落点附近敌人受到 235 点伤害。'],
    art: 'swordsman', base: 'Assassin', tint: 0xc0fff0, filter: 'hue-rotate(160deg) saturate(1.2)',
  },
  Starshooter: {
    name: '星辰射手', title: '射手玩偶 · 远程爆发', color: 0xd4b8ff, css: '#d9c0ff', icon: '✧',
    lore: '以星屑填充的弓手玩偶，箭矢自天穹坠落。',
    skills: ['星光穿刺', '星跃', '陨星坠落'], icons: ['✧', '»', '☄'],
    desc: ['射出星光箭，远距离落点范围内敌人受到 150 点伤害并减速 25%，持续 1.5 秒。', '朝瞄准方向跃迁 260 距离。', '召唤陨星砸向 760 距离内的落点，范围内敌人受到 320 点伤害。'],
    art: 'starshot', base: 'Ranger', tint: 0xe6d8ff, filter: 'hue-rotate(110deg) saturate(1.2)',
  },
  Nightshade: {
    name: '暗夜魔偶', title: '魔偶 · 控制拉人', color: 0x9a6bff, css: '#a277ff', icon: '☾',
    lore: '提线缠身的暗夜魔偶，锁链一甩，便把猎物拖到身前。',
    skills: ['暗影锁链', '夜幕笼罩', '深渊漩涡'], icons: ['⛓', '☾', '✺'],
    desc: ['甩出锁链，把落点范围内的敌人拉近 260 距离，造成 90 点伤害并眩晕 0.6 秒。', '降下夜幕，造成 70 点伤害并减速 40%，持续 2 秒。', '在指定位置打开漩涡，把 220 范围内的敌人拉向自己，造成 160 点伤害并眩晕 1.2 秒。'],
    art: 'puppeteer', base: 'Assassin', tint: 0xd2c0ff, filter: 'hue-rotate(-80deg) saturate(1.1)',
  },
  Colossus: {
    name: '岩石巨像', title: '坦克玩偶 · 嘲讽减伤', color: 0xb8a48a, css: '#c2ae94', icon: '⛰',
    lore: '山岩堆砌的巨像玩偶，皮糙肉厚，一声怒吼迫使敌人围攻自己。',
    skills: ['碎岩重击', '石肤', '巨像怒吼'], icons: ['⛰', '◈', '☉'],
    desc: ['重击前方地面，造成 90 点伤害并眩晕 0.8 秒。', '岩石覆体，4 秒内受到的伤害降低 40%。', '怒吼嘲讽周围 260 范围内的敌人 2 秒（强制走向自己且无法施法），同时减伤 30%。'],
    art: 'golem', base: 'Brawler', tint: 0xe0d6c4, filter: 'saturate(0.4) brightness(1.05)',
  },
  Chronomancer: {
    name: '时光术士', title: '辅助玩偶 · 加速减速', color: 0xf0d27a, css: '#f3d985', icon: '⌛',
    lore: '怀表心脏的术士玩偶，能拨快友军的时间，也能让敌人停滞。',
    skills: ['时光沙尘', '时间加速', '时间停滞'], icons: ['⌛', '⏩', '⏸'],
    desc: ['洒出时光沙尘，造成 90 点伤害并减速 45%，持续 2.5 秒。', '自身与周围 300 范围内的友方移速提升 35%，持续 3 秒。', '冻结指定区域的时间，造成 80 点伤害并眩晕 1.5 秒。'],
    art: 'chrono', base: 'Arcanist', tint: 0xfff0c4, filter: 'hue-rotate(-140deg) saturate(1.2)',
  },
  FlameDancer: {
    name: '烈焰舞姬', title: '法师玩偶 · 范围火焰', color: 0xff6a4a, css: '#ff7656', icon: '♨',
    lore: '缎带燃着火焰的舞姬人偶，每一步都留下火海。',
    skills: ['火焰扇', '炽焰火海', '焚天之舞'], icons: ['♨', '△', '✹'],
    desc: ['挥出火焰扇，落点范围内敌人受到 125 点伤害。', '在指定位置点燃 3 秒火海，每秒 70 点伤害。', '旋舞引爆烈焰，周围 260 范围内敌人受到 210 点伤害。'],
    art: 'flamedancer', base: 'Priestess', tint: 0xffc8b4, filter: 'hue-rotate(-110deg) saturate(1.5)',
  },
  Bard: {
    name: '吟游诗人', title: '辅助玩偶 · 治疗光环', color: 0x7fe0a8, css: '#88e6b0', icon: '♪',
    lore: '抱着鲁特琴的布偶诗人，琴声能让同伴健步如飞、伤口愈合。',
    skills: ['激昂音符', '疾行之歌', '治愈乐章'], icons: ['♪', '♫', '♬'],
    desc: ['弹出音符冲击，落点范围内敌人受到 100 点伤害。', '自身与周围 320 范围内的友方移速提升 30%，持续 3 秒。', '奏响治愈乐章：周围 340 范围内的友方在 5 秒内回复 35% 最大生命。'],
    art: 'bard', base: 'Ranger', tint: 0xc8ffdc, filter: 'hue-rotate(-20deg) saturate(1.1)',
  },
  Beastmaster: {
    name: '狼灵猎手', title: '猎手玩偶 · 召唤狼灵', color: 0xc58a5a, css: '#cc9464', icon: '❂',
    lore: '披着兽皮的猎手玩偶，号角一响，狼灵随行。',
    skills: ['裂爪撕咬', '狼灵召唤', '群狼猎杀'], icons: ['⚔', '♞', '☽'],
    desc: ['撕咬前方，落点范围内敌人受到 120 点伤害。', '召唤 2 只狼灵（260 生命，30 攻击）跟随作战，持续 10 秒。', '召唤 3 只强化狼灵（320 生命，34 攻击），持续 12 秒。'],
    art: 'beastmaster', base: 'Brawler', tint: 0xf0d2b8, filter: 'hue-rotate(10deg) saturate(0.8)',
  },
  Mirage: {
    name: '镜像魅影', title: '魅影玩偶 · 分身隐身', color: 0xff8fe0, css: '#ff9ae4', icon: '◐',
    lore: '镜面缝成的魅影，隐身潜行，又以分身迷惑敌人。',
    skills: ['幻影突袭', '隐匿', '镜像分身'], icons: ['➹', '◐', '◑'],
    desc: ['朝瞄准方向突袭 300 距离，落点附近敌人受到 110 点伤害。', '隐身 3 秒并提升 30% 移速，敌方无法选中；普攻或施放技能即现身。', '召唤 2 个镜像分身（300 生命，40 攻击）协同作战，持续 8 秒。'],
    art: 'illusionist', base: 'Assassin', tint: 0xffd0f2, filter: 'hue-rotate(-40deg) saturate(1.3)',
  },
};

export const SKILL_KEYS = ['Q', 'E', 'R'] as const;

/** 以施法者为中心生效的技能效果（与 sim 的 SkillEffect::self_centered 一致）。 */
export const SELF_CAST_EFFECTS = new Set(['nova', 'heal', 'shield', 'haste', 'regen', 'fortify', 'stealth']);
/** 增益类（友方颜色的指示器）。 */
export const BUFF_EFFECTS = new Set(['heal', 'shield', 'haste', 'regen', 'fortify', 'stealth']);
export const TEAM_COLORS = { Red: 0xff5d7a, Blue: 0x5b9dff } as const;
export const TEAM_CSS = { Red: '#ff617c', Blue: '#61a0ff' } as const;
export const TEAM_NAMES = { Red: '绯红玩偶团', Blue: '湛蓝玩偶团' } as const;
/** 当前对局的战队名（服务端快照下发，支持自定义）。 */
export const teamNames: Record<'Red' | 'Blue', string> = { ...TEAM_NAMES };
/** 用快照里的战队名更新，返回是否有变化。 */
export function applyTeamNames(names: string[] | undefined): boolean {
  if (!names || names.length < 2) return false;
  if (names[0] === teamNames.Red && names[1] === teamNames.Blue) return false;
  teamNames.Red = names[0] || TEAM_NAMES.Red; teamNames.Blue = names[1] || TEAM_NAMES.Blue;
  return true;
}
