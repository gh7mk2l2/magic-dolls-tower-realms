import Phaser from 'phaser';
import rigData from './rig-data.json';

/**
 * 关节拆分的纸偶骨骼（cut-out rig）。
 * 每个角色的部件（头、躯干、前/后手臂、前/后腿；四足兽是头、躯干和四条腿）
 * 打包在 rig-<角色>-<队伍>.png 图集里，坐标与关节支点由 scripts/rig-slice.py 生成到 rig-data.json。
 * 坐标以脚底中心为原点，单位为图集像素。
 */
export type RigName = 'Arcanist' | 'Ranger' | 'Guardian' | 'Assassin' | 'Priestess' | 'Brawler' | 'minion' | 'super';
type PartInfo = { x: number; y: number; w: number; h: number; ox: number; oy: number; px: number; py: number };
type RigInfo = { kind: 'biped' | 'quad'; order: string[]; height: number; parts: Record<string, PartInfo> };
const DATA = rigData as unknown as Record<RigName, RigInfo>;

export const RIG_KEYS: string[] = (Object.keys(DATA) as RigName[]).flatMap((n) => [`rig-${n}-Red`, `rig-${n}-Blue`]);

/** 在图集纹理上注册每个部件的 frame。加载完成后调用一次。 */
export function registerRigFrames(scene: Phaser.Scene): void {
  for (const name of Object.keys(DATA) as RigName[]) {
    for (const team of ['Red', 'Blue']) {
      const key = `rig-${name}-${team}`;
      if (!scene.textures.exists(key)) continue;
      const tex = scene.textures.get(key);
      for (const [part, p] of Object.entries(DATA[name].parts)) {
        if (!tex.has(part)) tex.add(part, 0, p.x, p.y, p.w, p.h);
      }
    }
  }
}

export function hasRig(scene: Phaser.Scene, name: RigName, team: string): boolean {
  return scene.textures.exists(`rig-${name}-${team}`) && scene.textures.get(`rig-${name}-${team}`).has('torso');
}

/** 一次性的动作片段：普攻或技能。 */
interface Clip { kind: string; start: number; dur: number }

const ease = (p: number) => p * p * (3 - 2 * p);
/** 0→1→0 的包络，峰值位于 peak 处 */
const env = (p: number, peak = 0.35) => (p < peak ? ease(p / peak) : 1 - ease((p - peak) / (1 - peak)));

export class Rig {
  readonly root: Phaser.GameObjects.Container;
  private torsoGroup: Phaser.GameObjects.Container;
  private parts = new Map<string, Phaser.GameObjects.Image>();
  private rest = new Map<string, { x: number; y: number }>();
  private info: RigInfo;
  private walk = Math.random() * Math.PI * 2;
  private clip: Clip | null = null;
  private stepSign = 1;
  private baseScale: number;
  readonly name: RigName;
  /** 每次落脚时回调（扬尘） */
  onStep?: () => void;

  constructor(scene: Phaser.Scene, name: RigName, team: string, targetHeight: number) {
    this.name = name;
    this.info = DATA[name];
    const key = `rig-${name}-${team}`;
    this.baseScale = targetHeight / this.info.height;
    this.root = scene.add.container(0, 0).setScale(this.baseScale);
    const torso = this.info.parts.torso;
    this.torsoGroup = scene.add.container(torso.px, torso.py);
    const groupMembers = this.info.kind === 'biped' ? new Set(['armB', 'torso', 'armF', 'head']) : new Set(['torso', 'head']);
    let groupAdded = false;
    for (const partName of this.info.order) {
      const p = this.info.parts[partName];
      const img = scene.add.image(0, 0, key, partName).setOrigin((p.px - p.ox) / p.w, (p.py - p.oy) / p.h);
      this.parts.set(partName, img);
      if (groupMembers.has(partName)) {
        const pos = { x: p.px - torso.px, y: p.py - torso.py };
        img.setPosition(pos.x, pos.y);
        this.rest.set(partName, pos);
        this.torsoGroup.add(img);
        if (!groupAdded) { this.root.add(this.torsoGroup); groupAdded = true; }
      } else {
        img.setPosition(p.px, p.py);
        this.rest.set(partName, { x: p.px, y: p.py });
        this.root.add(img);
      }
    }
  }

  setTint(color: number | null): void {
    for (const img of this.parts.values()) { if (color === null) img.clearTint(); else img.setTint(color); }
  }

  /** 开始一个动作片段（attack / Q / E / R / hit）。 */
  play(kind: string, now: number): void {
    const dur = kind === 'attack' ? 320 : kind === 'hit' ? 220 : kind === 'R' ? 900 : 650;
    if (this.clip && this.clip.kind !== 'attack' && kind === 'attack' && now - this.clip.start < this.clip.dur) return;
    this.clip = { kind, start: now, dur };
  }

  busy(now: number): boolean { return !!this.clip && now - this.clip.start < this.clip.dur; }

  update(now: number, delta: number, moving: boolean, speed: number, facingRight: boolean, scaleMul = 1): void {
    const dir = facingRight ? 1 : -1;
    this.root.setScale(this.baseScale * dir * scaleMul, this.baseScale * scaleMul);
    const t = now / 1000;
    const quad = this.info.kind === 'quad';
    if (moving) this.walk += (delta / 1000) * Math.max(8, Math.min(14, speed / 22 + 6)) * (this.name === 'super' ? 0.65 : 1);
    else {
      const target = Math.round(this.walk / Math.PI) * Math.PI;
      this.walk += (target - this.walk) * Math.min(1, delta / 100);
    }
    const ph = this.walk, s = Math.sin(ph), bounce = Math.abs(Math.cos(ph));
    const amp = moving ? 1 : Math.min(1, Math.abs(s) * 2);
    const sign = s >= 0 ? 1 : -1;
    if (moving && sign !== this.stepSign) { this.stepSign = sign; this.onStep?.(); }

    // ---- 基础姿态：走路 / 待机 ----
    const pose: Record<string, { r: number; x: number; y: number }> = {};
    for (const k of this.parts.keys()) pose[k] = { r: 0, x: 0, y: 0 };
    let groupR = 0, groupY = 0, groupX = 0, groupSX = 1, groupSY = 1, rootY = 0, rootX = 0, rootR = 0;
    if (quad) {
      const sw = 0.42 * amp;
      // 对角步态：左前+右后同相
      pose.legBN.r = s * sw; pose.legFF.r = s * sw * 0.8;
      pose.legFN.r = -s * sw; pose.legBF.r = -s * sw * 0.8;
      pose.legBN.y = -Math.max(0, -s) * 10 * amp; pose.legFN.y = -Math.max(0, s) * 10 * amp;
      groupY = moving ? -bounce * 7 : Math.sin(t * 2.4) * -2;
      groupR = moving ? Math.sin(ph * 2) * 0.025 : 0;
      pose.head.r = moving ? Math.sin(ph * 2 + 0.6) * 0.06 : Math.sin(t * 1.8) * 0.04;
    } else {
      const sw = 0.5 * amp;
      pose.legF.r = s * sw; pose.legB.r = -s * sw;
      pose.legF.y = -Math.max(0, -s) * 10 * amp; pose.legB.y = -Math.max(0, s) * 10 * amp;
      // 手臂与同侧腿反向摆动
      pose.armF.r = -s * 0.45 * amp; pose.armB.r = s * 0.4 * amp;
      if (moving) {
        groupY = -bounce * 9; groupR = 0.07 + s * 0.03;
        groupSY = 1 - bounce * 0.03; groupSX = 1 + bounce * 0.02;
        pose.head.r = -s * 0.05; pose.head.y = bounce * 2;
      } else {
        const br = Math.sin(t * 2.2);
        groupSY = 1 + br * 0.015; groupSX = 1 - br * 0.008;
        pose.head.r = Math.sin(t * 1.3) * 0.04; pose.head.y = br * -1.5;
        pose.armF.r += Math.sin(t * 2.2) * 0.05; pose.armB.r -= Math.sin(t * 2.2 + 0.5) * 0.05;
      }
    }

    // ---- 动作片段叠加 ----
    if (this.clip) {
      const p = (now - this.clip.start) / this.clip.dur;
      if (p >= 1) this.clip = null;
      else {
        const k = this.clip.kind;
        const e = env(p), e2 = env(p, 0.2);
        const set = (part: string, r: number, x = 0, y = 0) => { const q = pose[part]; if (q) { q.r += r; q.x += x; q.y += y; } };
        if (k === 'hit') { groupR -= 0.18 * e2; rootX -= 6 * e2; }
        else if (quad) {
          // 魔兽：普攻扑咬，技能为蓄力冲撞
          if (k === 'attack') { set('head', 0.35 * e, 18 * e, 6 * e); groupR += 0.1 * e; rootX += 10 * e; set('legFN', -0.4 * e); set('legBN', 0.3 * e); }
          else { const c = p < 0.4 ? ease(p / 0.4) : 1 - ease((p - 0.4) / 0.6); groupY += 8 * c; set('head', -0.3 * c); rootX += p > 0.4 ? 24 * e : -6 * c; }
        } else {
          this.heroClip(k, p, e, e2, set, (dr, dy, dx, sx, sy) => { groupR += dr; groupY += dy; groupX += dx; groupSX *= sx; groupSY *= sy; },
            (dy, dx, dr) => { rootY += dy; rootX += dx; rootR += dr; });
        }
      }
    }

    for (const [k, img] of this.parts) {
      const base = this.rest.get(k)!, q = pose[k];
      img.setPosition(base.x + q.x, base.y + q.y).setRotation(q.r);
    }
    const torso = this.info.parts.torso;
    this.torsoGroup.setPosition(torso.px + groupX, torso.py + groupY).setRotation(groupR).setScale(groupSX, groupSY);
    this.root.setPosition(rootX * this.baseScale * dir, rootY * this.baseScale).setRotation(rootR * dir);
  }

  /**
   * 英雄专属动作。armB = 画面后侧手臂（术士持杖 / 游侠拉弦 / 守卫持锤），armF = 前侧手臂（术士空手 / 游侠持弓 / 守卫持盾）。
   * 角色默认朝右；旋转正值为顺时针。
   */
  private heroClip(
    k: string, p: number, e: number, e2: number,
    set: (part: string, r: number, x?: number, y?: number) => void,
    body: (dr: number, dy: number, dx: number, sx: number, sy: number) => void,
    root: (dy: number, dx: number, dr: number) => void,
  ): void {
    const crouchJump = (depth: number, height: number) => {
      // 先下蹲再起跳
      if (p < 0.3) { const c = ease(p / 0.3); body(0, depth * c, 0, 1 + 0.06 * c, 1 - 0.1 * c); }
      else { const j = Math.sin(((p - 0.3) / 0.7) * Math.PI); root(-height * j, 0, 0); body(0, 0, 0, 1 - 0.03 * j, 1 + 0.05 * j); }
    };
    switch (`${this.name}:${k}`) {
      // ---------------- 星语术士
      case 'Arcanist:attack': set('armB', 0.9 * e); set('armF', -0.3 * e); body(0.08 * e, 0, 4 * e, 1, 1); break;
      case 'Arcanist:Q': // 奥术冲击：双手前推
        set('armB', 1.1 * e); set('armF', -1.3 * e, 6 * e); body(0.16 * e, 0, 8 * e, 1, 1); set('head', 0.08 * e); break;
      case 'Arcanist:E': // 星辉禁锢：举杖过顶
        set('armB', 1.7 * e2); set('armF', -0.9 * e2); body(-0.1 * e2, -12 * e2, 0, 1, 1.04); set('head', -0.15 * e2); break;
      case 'Arcanist:R': // 终焉星爆：蹲下蓄力，跃起张开双臂
        crouchJump(14, 40); set('armB', 1.5 * e); set('armF', -2.0 * e); set('head', -0.2 * e); set('legF', -0.3 * e); set('legB', 0.3 * e); break;
      // ---------------- 月影游侠
      case 'Ranger:attack': set('armF', -0.25 * e2); set('armB', 0.5 * e2, -10 * e2); body(-0.05 * e2, 0, 0, 1, 1); break;
      case 'Ranger:Q': // 流星箭雨：仰射
        set('armF', -1.1 * e); set('armB', -0.4 * e, -12 * e, -8 * e); body(-0.22 * e, 0, -4 * e, 1, 1); set('head', -0.2 * e); break;
      case 'Ranger:E': // 月影疾步：大幅前倾冲刺
        body(0.4 * e2, 6 * e2, 10 * e2, 1, 1); set('armF', 0.8 * e2); set('armB', -0.9 * e2); set('legF', -0.7 * e2); set('legB', 0.7 * e2); root(-10 * e2, 14 * e2, 0); break;
      case 'Ranger:R': { // 寒霜之矢：下蹲满弓，颤抖后释放
        const hold = p < 0.7 ? ease(p / 0.7) : 1 - ease((p - 0.7) / 0.3);
        const shake = p < 0.7 ? Math.sin(p * 120) * 0.04 * hold : 0;
        set('armF', -0.35 * hold + shake); set('armB', 0.7 * hold, -18 * hold); body(-0.06 * hold, 10 * hold, -4 * hold, 1.04, 0.94);
        set('legF', -0.4 * hold); set('legB', 0.35 * hold);
        if (p > 0.7) root(0, -10 * (1 - hold), 0);
        break;
      }
      // ---------------- 晨曦守卫
      case 'Guardian:attack': { // 锤子劈砍：后摆→前砸
        const r = p < 0.35 ? -1.2 * ease(p / 0.35) : -1.2 + 2.3 * ease(Math.min(1, (p - 0.35) / 0.3)) * (1 - ease(Math.max(0, (p - 0.7) / 0.3)));
        set('armB', r); body(0.12 * e, 0, 4 * e, 1, 1); break;
      }
      case 'Guardian:Q': { // 守护震荡：跳起双手抡锤砸地
        crouchJump(10, 26);
        const r = p < 0.5 ? -2.2 * ease(p / 0.5) : -2.2 + 3.6 * ease(Math.min(1, (p - 0.5) / 0.2)) * (1 - ease(Math.max(0, (p - 0.8) / 0.2)));
        set('armB', r); set('armF', -0.4 * e); body(p > 0.6 ? 0.25 * e : 0, 0, 0, 1, 1); break;
      }
      case 'Guardian:E': // 盾击冲锋：盾牌前顶，弓步冲刺
        set('armF', -0.7 * e2, 14 * e2); set('armB', 0.5 * e2); body(0.3 * e2, 4 * e2, 12 * e2, 1, 1); set('legF', -0.6 * e2); set('legB', 0.6 * e2); root(0, 18 * e2, 0); break;
      case 'Guardian:R': // 生命回响：高举锤与盾
        set('armB', 1.5 * e); set('armF', -1.6 * e); body(-0.08 * e, -10 * e, 0, 1, 1.05); set('head', -0.18 * e); root(-14 * e, 0, 0); break;
      // ---------------- 影刃刺客（armB/armF 各持一把匕首）
      case 'Assassin:attack': { // 左右交替快刺
        const alt = Math.floor(this.clip!.start / 400) % 2 === 0;
        set(alt ? 'armF' : 'armB', alt ? -1.2 * e2 : 1.2 * e2, 8 * e2); body(0.14 * e2, 0, 6 * e2, 1, 1); break;
      }
      case 'Assassin:Q': // 影袭突进：压低身形前扑，双刃后拖
        body(0.5 * e2, 10 * e2, 14 * e2, 1.03, 0.95); set('armF', 1.0 * e2); set('armB', -1.0 * e2); set('legF', -0.8 * e2); set('legB', 0.8 * e2); root(-6 * e2, 20 * e2, 0); break;
      case 'Assassin:E': // 淬毒双刃：交叉横斩
        set('armF', p < 0.4 ? -1.8 * ease(p / 0.4) : -1.8 + 2.6 * ease(Math.min(1, (p - 0.4) / 0.25)));
        set('armB', p < 0.4 ? 1.8 * ease(p / 0.4) : 1.8 - 2.6 * ease(Math.min(1, (p - 0.4) / 0.25)));
        body(0.15 * e, 0, 6 * e, 1, 1);
        if (p > 0.85) { const k2 = (1 - p) / 0.15; set('armF', 0.8 * (1 - k2) * -1); set('armB', 0.8 * (1 - k2)); }
        break;
      case 'Assassin:R': { // 千刃乱舞：原地旋转连斩
        const spin = Math.sin(p * Math.PI * 6);
        set('armF', -1.6 * e + spin * 0.6); set('armB', 1.6 * e - spin * 0.6); body(spin * 0.12 * e, 4 * e, 0, 1, 1); root(-8 * e, 0, Math.sin(p * Math.PI * 4) * 0.15 * e); break;
      }
      // ---------------- 花语祭司（armB 持莲花杖，armF 托花瓣）
      case 'Priestess:attack': set('armB', 1.0 * e); body(0.06 * e, 0, 2 * e, 1, 1); set('head', 0.06 * e); break;
      case 'Priestess:Q': // 荆棘缠绕：杖指前方，另一手下压
        set('armB', 1.3 * e); set('armF', 0.6 * e); body(0.12 * e, 4 * e, 6 * e, 1, 1); break;
      case 'Priestess:E': // 花露愈合：双手合拢上托，轻轻漂浮
        set('armB', 1.0 * e); set('armF', -1.1 * e); set('head', -0.15 * e); body(-0.06 * e, -6 * e, 0, 1, 1.03); root(-14 * e, 0, 0); break;
      case 'Priestess:R': // 万花绽放：旋转升空，双臂张开
        crouchJump(10, 34); set('armB', 1.8 * e); set('armF', -1.9 * e); set('head', -0.22 * e); set('legF', 0.3 * e); set('legB', -0.3 * e); break;
      // ---------------- 熔岩斗士（双拳）
      case 'Brawler:attack': { // 左右直拳
        const alt = Math.floor(this.clip!.start / 400) % 2 === 0;
        set(alt ? 'armF' : 'armB', alt ? -0.9 * e2 : 1.0 * e2, 14 * e2); body(0.12 * e2, 0, 8 * e2, 1, 1); break;
      }
      case 'Brawler:Q': { // 熔岩重拳：蓄力后摆，大力前冲直拳
        const wind = p < 0.4 ? ease(p / 0.4) : 0;
        const hit = p >= 0.4 ? env((p - 0.4) / 0.6, 0.25) : 0;
        set('armB', -1.0 * wind + 1.4 * hit, 22 * hit); set('armF', 0.4 * wind - 0.4 * hit);
        body(-0.1 * wind + 0.22 * hit, 4 * wind, -6 * wind + 14 * hit, 1, 1); set('legF', -0.4 * hit); set('legB', 0.4 * hit); break;
      }
      case 'Brawler:E': { // 地裂震击：双拳举过头顶后砸地
        crouchJump(8, 22);
        const r = p < 0.55 ? ease(p / 0.55) : 1 - ease(Math.min(1, (p - 0.55) / 0.15));
        set('armB', 2.0 * r - (p > 0.6 ? 0.6 * e : 0)); set('armF', -2.0 * r + (p > 0.6 ? 0.6 * e : 0)); if (p > 0.65) body(0.2 * e, 8 * e, 0, 1.06, 0.92); break;
      }
      case 'Brawler:R': // 熔火冲撞：低头肩撞
        body(0.45 * e2, 8 * e2, 16 * e2, 1.05, 0.95); set('armF', -0.5 * e2, 10 * e2); set('armB', 0.6 * e2); set('head', 0.2 * e2); set('legF', -0.7 * e2); set('legB', 0.7 * e2); root(0, 24 * e2, 0); break;
      default: break;
    }
  }
}
