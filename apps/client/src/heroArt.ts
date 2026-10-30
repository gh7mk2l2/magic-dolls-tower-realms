import rigData from './rig-data.json';
import { HEROES, type BaseRig } from './config';
import type { HeroKind, Team } from './protocol';

/**
 * 玩偶美术资源解析（按 id 加载专属资源，缺失时回退）。
 *
 * 资源命名约定（放进 public/sprites/，键名即文件名去掉 .png）：
 * - 骨骼图集：`rig-<art>-<Red|Blue>.png`，部件坐标写进 `src/rig-data.json` 的 `<art>` 键（scripts/rig-slice.py 生成）。
 * - 立绘：`hero-<art>-<Red|Blue>.png`（大厅头像、HUD 头像、无骨骼时的整图兜底）。
 *
 * `<art>` 取 `HEROES[kind].art`（新玩偶为小写 id，如 golem / tinker），初始 6 名玩偶就是 HeroKind 本身。
 * 只有 rig-data.json 里存在 `<art>` 键时才认为专属资源已集成并去加载它，所以集成前不会产生 404 / 报错；
 * 未集成的玩偶借用 `base` 骨骼与立绘，并按定位用 `tint` / `filter` 区分色调。
 */
const RIGS = rigData as unknown as Record<string, unknown>;

export interface HeroLook {
  /** 骨骼图集名（rig-<atlas>-<队伍>） */
  atlas: string;
  /** 动作风格（rig.ts 里按 <anim>:<动作> 选择动作） */
  anim: BaseRig | string;
  /** 立绘名（hero-<portrait>-<队伍>） */
  portrait: string;
  /** 借用资源时的染色；专属资源为 null */
  tint: number | null;
  /** 借用立绘时大厅/HUD 头像的 CSS 滤镜 */
  filter: string;
  /** 骨骼显示高度 */
  height: number;
  dedicated: boolean;
}

export function hasDedicatedArt(kind: HeroKind): boolean {
  const art = HEROES[kind].art;
  return !!art && art in RIGS;
}

export function heroLook(kind: HeroKind | null | undefined): HeroLook {
  const k: HeroKind = kind && HEROES[kind] ? kind : 'Arcanist';
  const v = HEROES[k];
  const base = v.base ?? (k as BaseRig);
  if (!v.art || v.base === undefined) {
    // 初始 6 名玩偶：资源键就是 HeroKind
    return { atlas: k, anim: k, portrait: k, tint: null, filter: '', height: k === 'Brawler' ? 88 : 108, dedicated: true };
  }
  const dedicated = hasDedicatedArt(k);
  const heavy = base === 'Brawler';
  return dedicated
    ? { atlas: v.art, anim: base, portrait: v.art, tint: null, filter: '', height: heavy ? 96 : 108, dedicated }
    : { atlas: base, anim: base, portrait: base, tint: v.tint ?? null, filter: v.filter ?? '', height: heavy ? 92 : 108, dedicated };
}

/** 需要加载的立绘键：初始 6 名 + 已集成专属资源的新玩偶。 */
export function portraitSpriteKeys(): string[] {
  const ids = new Set<string>();
  for (const kind of Object.keys(HEROES) as HeroKind[]) {
    const look = heroLook(kind);
    if (look.dedicated) ids.add(look.portrait);
  }
  return [...ids].flatMap((id) => (['Red', 'Blue'] as Team[]).map((t) => `hero-${id}-${t}`));
}

/** 大厅/HUD 头像 <img> 的地址与滤镜。 */
export function portraitUrl(kind: HeroKind, team: Team): { src: string; filter: string } {
  const look = heroLook(kind);
  return { src: `${import.meta.env.BASE_URL}sprites/hero-${look.portrait}-${team}.png`, filter: look.filter };
}
