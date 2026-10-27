import Phaser from 'phaser';
import { Rig, RIG_KEYS, registerRigFrames, type RigName } from './rig';

/** 调试用：地址后加 #rigtest 打开，展示全部骨骼角色的走路与技能动作。 */
class RigTest extends Phaser.Scene {
  private rigs: { rig: Rig; clips: string[]; moving: boolean; i: number }[] = [];
  private label!: Phaser.GameObjects.Text;
  preload(): void { for (const k of RIG_KEYS) this.load.image(k, `${import.meta.env.BASE_URL}sprites/${k}.png`); }
  create(): void {
    registerRigFrames(this);
    this.cameras.main.setBackgroundColor('#26302c');
    const names: [RigName, number, string[]][] = [['Arcanist', 108, ['attack', 'Q', 'E', 'R']], ['Ranger', 108, ['attack', 'Q', 'E', 'R']], ['Guardian', 108, ['attack', 'Q', 'E', 'R']], ['Assassin', 108, ['attack', 'Q', 'E', 'R']], ['Priestess', 108, ['attack', 'Q', 'E', 'R']], ['Brawler', 88, ['attack', 'Q', 'E', 'R']], ['minion', 44, ['attack', 'Q']], ['super', 150, ['attack', 'Q']]];
    names.forEach(([n, h, clips], i) => {
      for (const [row, moving] of [[0, true], [1, false]] as const) {
        const rig = new Rig(this, n, row ? 'Blue' : 'Red', h);
        const x = 70 + i * 125, y = 210 + row * 230;
        this.add.ellipse(x, y, 70, 20, 0x000000, 0.35);
        this.add.container(x, y, [rig.root]);
        this.rigs.push({ rig, clips, moving, i: 0 });
      }
    });
    this.label = this.add.text(10, 10, '', { color: '#fff', fontSize: '14px' });
    const w = window as unknown as { rigPlay: (k: string) => void };
    w.rigPlay = (k: string) => { for (const r of this.rigs) if (!r.moving) r.rig.play(k, this.time.now); this.label.setText(k); };
  }
  update(time: number, delta: number): void {
    for (const r of this.rigs) {
      r.rig.update(time, delta, r.moving, 180, true);
    }
  }
}

export function startRigTest(): void {
  document.body.insertAdjacentHTML('beforeend', '<div id="rt" style="position:fixed;inset:0;z-index:999;background:#26302c"></div>');
  new Phaser.Game({ type: Phaser.AUTO, parent: 'rt', width: 1000, height: 560, backgroundColor: '#26302c', scene: [RigTest] });
}
