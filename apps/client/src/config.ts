import type { HeroKind } from './protocol';

/** 表现层配置（纯视觉）。玩法数值以服务端 Welcome.map 为准，这里不重复。 */
export const HEROES: Record<HeroKind, { name: string; title: string; color: number; css: string; icon: string; lore: string; skills: string[]; icons: string[]; desc: string[] }> = {
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
};

export const SKILL_KEYS = ['Q', 'E', 'R'] as const;
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
