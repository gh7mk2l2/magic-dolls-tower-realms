import Phaser from 'phaser';
import { Rig, RIG_KEYS, registerRigFrames, hasRig, type AtlasName } from './rig';
import { HEROES } from './config';
import { heroLook } from './heroArt';
import type { HeroKind } from './protocol';

const COLS = 11;
const CELL_W = 118;
const BAND_H = 470;

interface Entry { label: string; atlas: AtlasName; anim?: string; tint: number | null; height: number; clips: string[] }

/** 全部 20 名玩偶（按 heroLook 解析专属/借用骨骼）+ 魔兽 + 超级魔兽。 */
function entries(): Entry[] {
  const list: Entry[] = (Object.keys(HEROES) as HeroKind[]).map((kind) => {
    const look = heroLook(kind);
    return { label: HEROES[kind].name, atlas: look.atlas, anim: look.anim, tint: look.tint, height: look.height, clips: ['attack', 'Q', 'E', 'R'] };
  });
  list.push({ label: '变异魔兽', atlas: 'minion', tint: null, height: 44, clips: ['attack', 'Q'] });
  list.push({ label: '超级魔兽', atlas: 'super', tint: null, height: 150, clips: ['attack', 'Q'] });
  return list;
}

/** 调试用：地址后加 #rigtest 打开，展示全部骨骼角色的走路与技能动作。
 *  第一行走路（红队），第二行原地（蓝队），控制台 rigPlay('Q') 播放动作；点击画布轮播 attack/Q/E/R。 */
class RigTest extends Phaser.Scene {
  private rigs: { rig: Rig; clips: string[]; moving: boolean }[] = [];
  private label!: Phaser.GameObjects.Text;
  private clipIndex = 0;
  preload(): void { for (const k of RIG_KEYS) this.load.image(k, `${import.meta.env.BASE_URL}sprites/${k}.png`); }
  create(): void {
    registerRigFrames(this);
    this.cameras.main.setBackgroundColor('#26302c');
    const missing: string[] = [];
    entries().forEach((entry, i) => {
      const col = i % COLS, band = Math.floor(i / COLS);
      const x = 64 + col * CELL_W;
      this.add.text(x, 46 + band * BAND_H, entry.label, { color: '#e8f0ea', fontSize: '13px' }).setOrigin(0.5, 0);
      for (const [row, moving, team] of [[0, true, 'Red'], [1, false, 'Blue']] as const) {
        const y = 210 + band * BAND_H + row * 210;
        this.add.ellipse(x, y, 70, 20, 0x000000, 0.35);
        if (!hasRig(this, entry.atlas, team)) {
          missing.push(`${entry.label}(${entry.atlas}-${team})`);
          this.add.text(x, y - 40, '缺骨骼', { color: '#ff8a8a', fontSize: '12px' }).setOrigin(0.5);
          continue;
        }
        const rig = new Rig(this, entry.atlas, team, entry.height, entry.anim, entry.tint);
        this.add.container(x, y, [rig.root]);
        this.rigs.push({ rig, clips: entry.clips, moving });
      }
    });
    this.label = this.add.text(10, 10, missing.length ? `缺失：${missing.join('、')}` : '全部骨骼已加载（点击轮播动作）', { color: missing.length ? '#ff8a8a' : '#fff', fontSize: '14px' });
    const w = window as unknown as { rigPlay: (k: string) => void; rigMissing: string[] };
    w.rigMissing = missing;
    w.rigPlay = (k: string) => { for (const r of this.rigs) if (!r.moving && r.clips.includes(k)) r.rig.play(k, this.time.now); this.label.setText(k); };
    this.input.on('pointerdown', () => { const clips = ['attack', 'Q', 'E', 'R']; w.rigPlay(clips[this.clipIndex++ % clips.length]); });
  }
  update(time: number, delta: number): void {
    for (const r of this.rigs) r.rig.update(time, delta, r.moving, 180, true);
  }
}

export function startRigTest(): void {
  document.body.insertAdjacentHTML('beforeend', '<div id="rt" style="position:fixed;inset:0;z-index:999;background:#26302c"></div>');
  new Phaser.Game({
    type: Phaser.AUTO, parent: 'rt', width: 64 + COLS * CELL_W, height: 2 * BAND_H + 20, backgroundColor: '#26302c',
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH }, scene: [RigTest],
  });
}
