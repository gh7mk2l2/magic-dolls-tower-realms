import Phaser from 'phaser';
import { ArcaneAudio } from './audio';
import { TEAM_COLORS, teamNames, applyTeamNames } from './config';
import { Rig, hasRig, registerRigFrames, type RigName } from './rig';
import { Interpolator, SnapshotStore } from './interpolation';
import type { GameConnection } from './network';
import { NavGrid, Predictor } from './prediction';
import { FLAGS, type EntitySnapshot, type GameEvent, type InputFrame, type MatchSummary, type Snapshot, type Team, type Welcome } from './protocol';
import { createWorldTextures, preloadSprites } from './textures';
import type { GameHUD } from './ui';

export interface TouchAim { slot: number; dx: number; dy: number; cancel: boolean }
export interface TouchState {
  moveX: number; moveY: number; attack: boolean; skills: number; active: boolean;
  /** 正在拖动瞄准的技能（dx/dy 为 -1..1 的拖动偏移，按技能射程换算） */
  aim: TouchAim | null;
  /** 本次释放使用的拖动方向；null 表示轻点自动瞄准 */
  castAim: { slot: number; dx: number; dy: number } | null;
}

export interface BattleDeps {
  connection: GameConnection;
  hud: GameHUD;
  audio: ArcaneAudio;
  welcome: Welcome;
  playerName: string;
  touch: TouchState;
}

interface View {
  kind: EntitySnapshot['kind'];
  team: Team;
  root: Phaser.GameObjects.Container;
  body?: Phaser.GameObjects.Image;
  bar?: Phaser.GameObjects.Graphics;
  label?: Phaser.GameObjects.Text;
  status?: Phaser.GameObjects.Text;
  aura?: Phaser.GameObjects.Image;
  ring?: Phaser.GameObjects.Image;
  emitter?: Phaser.GameObjects.Particles.ParticleEmitter;
  /** 基地专用：头顶阵营旗帜、地面阵营圈、屏幕外方向指示 */
  banner?: Phaser.GameObjects.Container;
  pointer?: Phaser.GameObjects.Container;
  lastHp: number;
  lastFlags: number;
  phase: number;
  /** 走路动画：body 只显示上半身，腿部拆成左右两块独立摆动 */
  legs?: [Phaser.GameObjects.Image, Phaser.GameObjects.Image];
  rig?: Rig;
  lastCooldowns?: number[];
  lastAttack?: number;
  baseScale?: number;
  walk?: number;
  stepSign?: number;
  lastRender?: number;
}

interface LegSplit { top: number; cx: number; w: number; h: number; foot: number }

const TICK_MS = 50;
const POISON_TINT = { Red: 0xff3f8e, Blue: 0x3fa6ff } as const;

export class BattleScene extends Phaser.Scene {
  private deps!: BattleDeps;
  private store = new SnapshotStore();
  private interpolator = new Interpolator(100, TICK_MS);
  private predictor!: Predictor;
  private grid!: NavGrid;
  private views = new Map<number, View>();
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private seq = 0;
  private accumulator = 0;
  private pendingSkills = 0;
  /** 电脑端：按住技能键时显示指示器，松开释放；-1 表示没有在瞄准 */
  private aimingSlot = -1;
  quickCast = localStorage.getItem('mdtr-quickcast') === '1';
  private indicator!: Phaser.GameObjects.Graphics;
  private pendingHelp = false;
  private bannerNames = '';
  private pendingAccept = 0;
  private helpReadyAt = 0;
  /** 接受求救后的指引目标 */
  private guide: { target: number; name: string; until: number } | null = null;
  private guideGfx!: Phaser.GameObjects.Graphics;
  private guideText!: Phaser.GameObjects.Text;
  private attackHeld = false;
  private localReady = false;
  private lanesDrawn = false;
  private reticle!: Phaser.GameObjects.Image;
  private rangeRing!: Phaser.GameObjects.Graphics;
  private seenEvents = new Set<number>();
  private lastHudUpdate = 0;
  private wasPoisoned = false;
  private ended = false;
  private startedAt = 0;

  constructor() { super('battle'); }

  init(deps: BattleDeps): void {
    this.deps = deps;
    const map = deps.welcome.map;
    this.grid = NavGrid.fromMap(map);
    this.predictor = new Predictor(this.grid, deps.welcome.tick_rate);
    this.store.reset();
    this.interpolator.clear();
    this.views.clear();
    this.seq = 0;
    this.localReady = false;
    this.lanesDrawn = false;
    this.ended = false;
    this.seenEvents.clear();
    this.startedAt = performance.now();
    // 场景 init 之前就到达的快照（连接比场景启动快），在这里按顺序补上。
    const early = this.earlySnapshots; this.earlySnapshots = [];
    for (const snap of early) this.onSnapshot(snap);
  }

  private earlySnapshots: Snapshot[] = [];

  preload(): void {
    preloadSprites(this);
  }

  create(): void {
    createWorldTextures(this);
    const map = this.deps.welcome.map;
    this.cameras.main.setBounds(-200, -200, map.width + 400, map.height + 400);
    this.cameras.main.setBackgroundColor('#071017');
    this.fitZoom();
    this.scale.on('resize', () => this.fitZoom());
    registerRigFrames(this);
    this.drawTerrain();

    const kb = this.input.keyboard!;
    this.keys = kb.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,Q,E,R,ONE,TWO,THREE,TAB,SPACE') as Record<string, Phaser.Input.Keyboard.Key>;
    kb.addCapture('TAB,SPACE');
    const press = (slot: number) => {
      this.deps.audio.unlock();
      if (this.aimingSlot === slot) return; // 按住时的键盘重复
      if (!this.skillReady(slot)) { this.deps.hud.denySkill(slot); return; }
      if (this.quickCast) this.pendingSkills |= 1 << slot;
      else this.aimingSlot = slot;
    };
    const lift = (slot: number) => {
      if (this.aimingSlot !== slot) return;
      this.aimingSlot = -1;
      this.pendingSkills |= 1 << slot;
    };
    ([['Q', 'ONE', 0], ['E', 'TWO', 1], ['R', 'THREE', 2]] as const).forEach(([a, b, slot]) => {
      for (const key of [a, b]) { this.keys[key].on('down', () => press(slot)); this.keys[key].on('up', () => lift(slot)); }
    });
    kb.on('keydown-G', () => this.requestHelp());
    kb.on('keydown-F', () => { const id = this.deps.hud.latestHelpId(); if (id) this.acceptHelp(id); });
    this.guideGfx = this.add.graphics().setDepth(5);
    this.guideText = this.add.text(0, 0, '', {
      fontFamily: 'system-ui,"Noto Sans CJK SC",sans-serif', fontSize: '15px', fontStyle: 'bold', color: '#b8ffd8', stroke: '#06281a', strokeThickness: 4,
    }).setOrigin(0.5, 0).setDepth(100001).setVisible(false);
    this.input.mouse?.disableContextMenu();
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      this.deps.audio.unlock();
      if (p.wasTouch) return;
      // 瞄准中：右键取消，左键立即释放
      if (this.aimingSlot >= 0 && p.rightButtonDown()) { this.aimingSlot = -1; this.deps.hud.toast('已取消施法'); return; }
      if (this.aimingSlot >= 0 && p.leftButtonDown()) { this.pendingSkills |= 1 << this.aimingSlot; this.aimingSlot = -1; return; }
      if (p.leftButtonDown()) this.attackHeld = true;
    });
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => { if (!p.wasTouch) this.attackHeld = false; });

    this.reticle = this.add.image(0, 0, 'rune').setScale(0.13).setAlpha(0.7).setDepth(100000).setBlendMode(Phaser.BlendModes.ADD);
    this.rangeRing = this.add.graphics().setDepth(1);
    this.indicator = this.add.graphics().setDepth(2);
  }

  private fitZoom(): void {
    const w = this.scale.width, h = this.scale.height;
    // 视野至少覆盖约 1500×850 世界像素，小屏自动缩小。
    const fit = Math.min(w / 1500, h / 850);
    // 触屏横屏通常只有 ~390px 高，按桌面视野缩放会小到看不清，这里放宽下限
    const zoom = this.deps.touch.active ? Math.max(0.6, Math.min(1.0, fit * 1.35)) : Math.max(0.42, Math.min(1.15, fit));
    this.cameras.main.setZoom(zoom);
  }

  // ---------------------------------------------------------------- 地形

  /** 地面细节：大块明暗变化打破平铺重复感，再按种子散布花丛、蘑菇、石板、符文地砖等贴花。 */
  private drawGroundDetail(): void {
    const map = this.deps.welcome.map;
    let seed = 4242;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    for (let i = 0; i < Math.ceil((map.width * map.height) / 900000); i++) {
      const dark = rnd() > 0.45;
      this.add.image(rnd() * map.width, rnd() * map.height, 'glow')
        .setScale(5 + rnd() * 6, 4 + rnd() * 5).setRotation(rnd() * Math.PI)
        .setTint(dark ? 0x000000 : 0x6f9a6a).setAlpha(dark ? 0.28 : 0.07).setDepth(-990);
    }
    const decals = ['decal-grass', 'decal-flowers', 'decal-stones', 'decal-mushrooms', 'decal-leaves', 'decal-crack', 'decal-rune'];
    const weights = [6, 4, 3, 2, 2, 2, 1];
    const total = weights.reduce((a, b) => a + b, 0);
    const count = Math.round((map.width * map.height) / (this.deps.touch.active ? 70000 : 45000));
    const placed: Record<string, Array<[number, number, number, number]>> = {};
    for (let i = 0; i < count; i++) {
      let pick = rnd() * total, k = 0;
      while (pick > weights[k]) { pick -= weights[k]; k++; }
      const key = decals[Math.min(k, decals.length - 1)];
      const x = rnd() * map.width, y = rnd() * map.height;
      if (this.grid.isBlocked(x, y)) continue;
      const scale = key === 'decal-rune' ? 0.9 + rnd() * 0.4 : key === 'decal-crack' ? 0.45 + rnd() * 0.35 : 0.35 + rnd() * 0.4;
      (placed[key] ??= []).push([x, y, scale, rnd() * Math.PI * 2]);
    }
    // 同纹理连续绘制，减少 WebGL 批次切换
    for (const key of decals) {
      if (!this.textures.exists(key)) continue;
      for (const [x, y, scale, rot] of placed[key] ?? []) {
        this.add.image(x, y, key).setScale(scale).setRotation(rot).setAlpha(key === 'decal-rune' ? 0.6 : key === 'decal-crack' ? 0.4 : 0.9).setDepth(-960);
      }
    }
  }

  private drawTerrain(): void {
    const map = this.deps.welcome.map;
    this.add.tileSprite(map.width / 2, map.height / 2, map.width + 400, map.height + 400, 'ground').setDepth(-1000);
    this.drawGroundDetail();
    // 中央魔力河
    const river = this.add.graphics().setDepth(-900);
    river.fillStyle(0x1b3c66, 0.35);
    river.fillRect(map.width / 2 - 70, 0, 140, map.height);
    river.fillStyle(0x6fb6ff, 0.08);
    river.fillRect(map.width / 2 - 24, 0, 48, map.height);
    const rocks = this.add.graphics().setDepth(-850);
    let seed = 1337;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    for (const r of map.obstacles) {
      // 有机轮廓的岩石高地：外圈软阴影 → 苔岩 → 顶面，边缘用一圈岩石/树木打散直角
      const blob = (inset: number, color: number, alpha: number, rad: [number, number]) => {
        rocks.fillStyle(color, alpha);
        rocks.fillRoundedRect(r.x + inset, r.y + inset, r.w - inset * 2, r.h - inset * 2, Math.min(40, Math.min(r.w, r.h) / 2 - inset));
        const step = 46;
        for (let t = 0; t < (r.w + r.h) * 2; t += step) {
          let x: number, y: number;
          if (t < r.w) { x = r.x + t; y = r.y; }
          else if (t < r.w + r.h) { x = r.x + r.w; y = r.y + (t - r.w); }
          else if (t < r.w * 2 + r.h) { x = r.x + r.w - (t - r.w - r.h); y = r.y + r.h; }
          else { x = r.x; y = r.y + r.h - (t - r.w * 2 - r.h); }
          const cx = Phaser.Math.Clamp(x, r.x + inset + 20, r.x + r.w - inset - 20), cy = Phaser.Math.Clamp(y, r.y + inset + 20, r.y + r.h - inset - 20);
          rocks.fillCircle(cx, cy, rad[0] + rnd() * (rad[1] - rad[0]));
        }
      };
      blob(-14, 0x03070a, 0.45, [30, 52]);
      blob(-2, 0x141d1b, 0.96, [24, 40]);
      blob(16, 0x1f2b27, 0.95, [18, 30]);
      blob(34, 0x26342d, 0.6, [14, 24]);
      const area = r.w * r.h;
      const count = Math.max(3, Math.floor(area / 9000));
      for (let i = 0; i < count; i++) {
        const x = r.x + 20 + rnd() * Math.max(1, r.w - 40), y = r.y + 30 + rnd() * Math.max(1, r.h - 40);
        const key = r.w > 400 ? (rnd() > 0.45 ? 'crystal' : 'rock') : (rnd() > 0.5 ? 'tree' : 'rock');
        this.add.image(x, y, key).setOrigin(0.5, 0.85).setScale(0.8 + rnd() * 0.7).setDepth(y);
      }
      // 沿边缘一圈岩石，盖住几何边界
      const ring = Math.max(6, Math.floor((r.w + r.h) / 70));
      for (let i = 0; i < ring; i++) {
        const t = rnd() * (r.w + r.h) * 2;
        let x: number, y: number;
        if (t < r.w) { x = r.x + t; y = r.y + 8; }
        else if (t < r.w + r.h) { x = r.x + r.w - 6; y = r.y + (t - r.w); }
        else if (t < r.w * 2 + r.h) { x = r.x + r.w - (t - r.w - r.h); y = r.y + r.h - 4; }
        else { x = r.x + 6; y = r.y + r.h - (t - r.w * 2 - r.h); }
        this.add.image(x, y, rnd() > 0.35 ? 'rock' : 'tree').setOrigin(0.5, 0.85).setScale(0.6 + rnd() * 0.5).setDepth(y);
      }
    }
    // 边缘装饰
    for (let i = 0; i < 70; i++) {
      const edge = rnd();
      const x = edge < 0.5 ? rnd() * map.width : (rnd() > 0.5 ? rnd() * 90 : map.width - rnd() * 90);
      const y = edge < 0.5 ? (rnd() > 0.5 ? rnd() * 70 : map.height - rnd() * 50) : rnd() * map.height;
      if (this.grid.isBlocked(x, y)) continue;
      this.add.image(x, y, rnd() > 0.3 ? 'tree' : 'rock').setOrigin(0.5, 0.9).setScale(0.7 + rnd() * 0.5).setDepth(y).setAlpha(0.95);
    }
  }

  private drawLanes(entities: EntitySnapshot[]): void {
    const bases = { Red: entities.find((e) => e.kind === 'Base' && e.team === 'Red'), Blue: entities.find((e) => e.kind === 'Base' && e.team === 'Blue') };
    const towers = (team: Team) => entities.filter((e) => e.kind === 'Tower' && e.team === team).sort((a, b) => a.y - b.y);
    const red = towers('Red'), blue = towers('Blue');
    if (!bases.Red || !bases.Blue || red.length < 2 || blue.length < 2) return;
    this.lanesDrawn = true;
    const map = this.deps.welcome.map;
    const g = this.add.graphics().setDepth(-950);
    for (const lane of [0, 1]) {
      const edgeY = lane === 0 ? Math.min(red[0].y, blue[0].y) - 60 : Math.max(red[1].y, blue[1].y) + 60;
      const pts = [bases.Red, red[lane], { x: map.width / 2, y: edgeY }, blue[lane], bases.Blue];
      const curve = new Phaser.Curves.Spline(pts.map((p) => new Phaser.Math.Vector2(p.x, p.y)));
      g.lineStyle(110, 0x2b2a3a, 0.75); curve.draw(g, 64);
      g.lineStyle(84, 0x343447, 0.9); curve.draw(g, 64);
      g.lineStyle(3, 0xa68ad3, 0.18); curve.draw(g, 64);
    }
  }

  // ---------------------------------------------------------------- 网络回调

  onSnapshot(snapshot: Snapshot): void {
    if (!this.deps || !this.predictor) { if (this.earlySnapshots.length < 40) this.earlySnapshots.push(snapshot); return; }
    const result = this.store.apply(snapshot);
    if (result.resync) this.deps.connection.requestResync();
    if (!result.accepted) return;
    this.interpolator.push(snapshot.tick, this.store.entities);
    const local = this.store.entities.get(this.deps.welcome.entity_id);
    if (local) {
      const ack = snapshot.acks.find(([player]) => player === this.deps.welcome.player_id)?.[1] ?? 0;
      const disabled = local.respawn > 0 || (local.flags & FLAGS.STUNNED) !== 0;
      if (!this.localReady || disabled) {
        this.predictor.reset(local.x, local.y);
        this.localReady = true;
      } else {
        this.predictor.reconcile(local.x, local.y, ack, this.localSpeed(local));
      }
    }
    if (!this.lanesDrawn) this.drawLanes([...this.store.entities.values()]);
    for (const event of snapshot.events) this.playEvent(event);
    if (snapshot.team_names && snapshot.team_names.join('|') !== this.bannerNames) {
      this.bannerNames = snapshot.team_names.join('|');
      applyTeamNames(snapshot.team_names);
      for (const v of this.views.values()) {
        const hint = v.banner?.getData('hint') as Phaser.GameObjects.Text | undefined;
        if (hint) hint.setText(`${teamNames[v.team]} · ${v.banner!.getData('sub')}`);
      }
    }
  }

  onMatchEnd(summary: MatchSummary): void {
    this.ended = true;
    this.deps.audio.play('Victory');
    this.cameras.main.flash(600, 255, 220, 160);
    this.deps.hud.showResult(summary);
  }

  private localSpeed(local: EntitySnapshot): number {
    const info = this.deps.welcome.map.heroes.find((h) => h.kind === local.hero);
    return (info?.speed ?? 250) * (local.speed_mul || 1);
  }

  // ---------------------------------------------------------------- 输入

  private buildInput(): InputFrame {
    const k = this.keys;
    const touch = this.deps.touch;
    let mx = (k.D.isDown || k.RIGHT.isDown ? 1 : 0) - (k.A.isDown || k.LEFT.isDown ? 1 : 0);
    let my = (k.S.isDown || k.DOWN.isDown ? 1 : 0) - (k.W.isDown || k.UP.isDown ? 1 : 0);
    if (touch.active && (touch.moveX || touch.moveY)) { mx = touch.moveX; my = touch.moveY; }
    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    const pointer = this.input.activePointer;
    const world = pointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
    let aimX = world.x, aimY = world.y;
    const local = this.store.entities.get(this.deps.welcome.entity_id);
    if (touch.active && local) {
      // 触屏：自动瞄准最近的敌人。
      const target = this.nearestEnemy(local);
      if (target) { aimX = target.x; aimY = target.y; } else { aimX = local.x + (mx || 1) * 200; aimY = local.y + my * 200; }
    }
    const cast = touch.castAim;
    if (cast && local && touch.skills & (1 << cast.slot)) {
      // 触屏拖动瞄准：按拖动方向和比例换算到技能射程
      const p = this.touchAimPoint(local, cast.slot, cast.dx, cast.dy);
      aimX = p.x; aimY = p.y;
    }
    touch.castAim = null;
    const skills = this.pendingSkills | touch.skills;
    this.pendingSkills = 0;
    touch.skills = 0;
    const help = this.pendingHelp, accept = this.pendingAccept;
    this.pendingHelp = false; this.pendingAccept = 0;
    return { seq: ++this.seq, move_x: mx, move_y: my, aim_x: aimX, aim_y: aimY, attack: this.attackHeld || touch.attack, skills, help, accept_help: accept };
  }

  private nearestEnemy(local: EntitySnapshot): EntitySnapshot | null {
    let best: EntitySnapshot | null = null, bestD = 700;
    for (const e of this.store.entities.values()) {
      if (e.team === local.team || e.kind === 'PoisonZone' || e.hp <= 0 || e.respawn > 0) continue;
      if (e.kind === 'Base' && e.flags & FLAGS.INVULNERABLE) continue;
      const d = Math.hypot(e.x - local.x, e.y - local.y) - (e.kind === 'Hero' ? 120 : 0);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  // ---------------------------------------------------------------- 主循环

  update(_time: number, delta: number): void {
    if (!this.localReady) return;
    this.accumulator += Math.min(delta, 250);
    const local = this.store.entities.get(this.deps.welcome.entity_id);
    while (this.accumulator >= TICK_MS) {
      this.accumulator -= TICK_MS;
      if (this.ended) continue;
      const frame = this.buildInput();
      this.deps.connection.sendInput(frame);
      if (local) {
        const disabled = local.respawn > 0 || (local.flags & FLAGS.STUNNED) !== 0;
        this.predictor.push(disabled ? { ...frame, move_x: 0, move_y: 0 } : frame, this.localSpeed(local));
      }
    }
    if (this.keys.TAB.isDown !== undefined) this.deps.hud.toggleScoreboard(this.keys.TAB.isDown, [...this.store.entities.values()]);
    this.render(delta);
  }

  private render(delta: number): void {
    const now = performance.now();
    const sampled = this.interpolator.sample(now);
    const localId = this.deps.welcome.entity_id;
    const seen = new Set<number>();
    const predicted = this.predictor.render(delta);
    let localEntity: EntitySnapshot | undefined;
    for (const e of sampled) {
      seen.add(e.id);
      let entity = e;
      if (e.id === localId) {
        const auth = this.store.entities.get(localId) ?? e;
        entity = { ...auth, x: predicted.x, y: predicted.y };
        localEntity = entity;
      }
      this.renderEntity(entity, entity.id === localId, now, delta);
    }
    for (const [id, view] of this.views) {
      if (!seen.has(id)) this.destroyView(id, view);
    }
    this.declutterLabels(localId);
    this.updateBasePointers();
    if (localEntity) {
      const cam = this.cameras.main;
      const tx = localEntity.x - cam.width / 2, ty = localEntity.y - cam.height / 2;
      cam.scrollX += (tx - cam.scrollX) * Math.min(1, delta / 120);
      cam.scrollY += (ty - cam.scrollY) * Math.min(1, delta / 120);
      const info = this.deps.welcome.map.heroes.find((h) => h.kind === localEntity!.hero);
      this.rangeRing.clear();
      if (info && localEntity.respawn === 0) {
        this.rangeRing.lineStyle(2, 0xffffff, 0.08).strokeCircle(localEntity.x, localEntity.y, info.attack_range);
      }
      this.drawIndicator(localEntity, now);
      this.updateGuide(localEntity, now);
      const poisoned = this.inEnemyPoison(localEntity);
      if (poisoned !== this.wasPoisoned) { this.deps.hud.poisoned(poisoned); this.wasPoisoned = poisoned; }
    }
    const pointer = this.input.activePointer;
    const world = pointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
    this.reticle.setPosition(world.x, world.y).setRotation(now / 800).setVisible(!this.deps.touch.active);
    if (now - this.lastHudUpdate > 100 && this.store.latest) {
      this.lastHudUpdate = now;
      this.deps.hud.update(this.store.latest, this.store.entities.get(localId), [...this.store.entities.values()]);
      this.deps.hud.prediction(this.predictor.pendingCount, this.predictor.lastCorrection);
    }
  }

  /** 头顶名字互相重叠时，把靠后（y 更小）的名字向上错开，保证每个名字都能读出来。 */
  private declutterLabels(localId: number): void {
    const items: Array<{ v: View; x: number; y: number; w: number; local: boolean }> = [];
    for (const [id, v] of this.views) {
      if (v.kind !== 'Hero' || !v.label || !v.root.visible) continue;
      items.push({ v, x: v.root.x, y: v.root.y, w: v.label.width, local: id === localId });
    }
    items.sort((a, b) => (a.local ? -1 : b.local ? 1 : b.y - a.y));
    const placed: Array<{ x: number; y: number; w: number }> = [];
    for (const it of items) {
      let off = 0;
      for (let tries = 0; tries < 4; tries++) {
        const ly = it.y - 122 - off;
        const hit = placed.some((p) => Math.abs(p.x - it.x) < (p.w + it.w) / 2 + 4 && Math.abs(p.y - ly) < 19);
        if (!hit) break;
        off += 19;
      }
      const cur = it.v.label!.y, target = -122 - off;
      it.v.label!.y = cur + (target - cur) * 0.35;
      it.v.status?.setY(it.v.label!.y - 18);
      placed.push({ x: it.x, y: it.y - 122 - off, w: it.w });
    }
  }

  private inEnemyPoison(local: EntitySnapshot): boolean {
    if (local.respawn > 0) return false;
    for (const e of this.store.entities.values()) {
      if (e.kind === 'PoisonZone' && e.team !== local.team && Math.hypot(e.x - local.x, e.y - local.y) <= e.radius) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- 实体表现

  private createView(e: EntitySnapshot, isLocal: boolean): View {
    const root = this.add.container(e.x, e.y);
    const view: View = { kind: e.kind, team: e.team, root, lastHp: -1, lastFlags: -1, phase: Math.random() * Math.PI * 2 };
    const color = TEAM_COLORS[e.team];
    switch (e.kind) {
      case 'PoisonZone': {
        const tint = POISON_TINT[e.team];
        const scale = (e.radius * 2) / 128;
        view.aura = this.add.image(0, 0, 'glow').setScale(scale * 1.15).setTint(tint).setAlpha(0.18).setBlendMode(Phaser.BlendModes.ADD);
        view.ring = this.add.image(0, 0, 'rune').setScale((e.radius * 2) / 256 * 1.04).setTint(tint).setAlpha(0.26).setBlendMode(Phaser.BlendModes.ADD);
        const edge = this.add.graphics();
        edge.lineStyle(3, tint, 0.7).strokeCircle(0, 0, e.radius);
        edge.lineStyle(10, tint, 0.1).strokeCircle(0, 0, e.radius - 6);
        root.add([view.aura, edge, view.ring]);
        view.emitter = this.add.particles(e.x, e.y, 'particle', {
          emitZone: { type: 'random', source: new Phaser.Geom.Circle(0, 0, e.radius * 0.95) as unknown as Phaser.Types.GameObjects.Particles.RandomZoneSource },
          lifespan: { min: 1400, max: 2600 }, speedY: { min: -38, max: -12 }, speedX: { min: -6, max: 6 },
          scale: { start: 0.5, end: 0 }, alpha: { start: 0.45, end: 0 }, tint, frequency: 110, blendMode: 'ADD',
        });
        view.emitter.setDepth(e.y - e.radius + 2);
        root.setDepth(-800);
        break;
      }
      case 'Base': {
        const ally = e.team === this.deps.welcome.team;
        const zone = Math.max(150, e.radius * 1.75);
        // 地面阵营圈：己方实线青绿外环，敌方红色虚线危险环
        // 俯视 3/4 视角：地面圈压成椭圆，建筑底部落在椭圆中心偏下，避免“悬空”
        const ry = 0.58, gy = 10;
        const ground = this.add.graphics();
        ground.fillStyle(0x000000, 0.35).fillEllipse(0, gy, zone * 2, zone * 2 * ry);
        ground.fillStyle(color, 0.14).fillEllipse(0, gy, zone * 2, zone * 2 * ry);
        ground.lineStyle(14, color, 0.18).strokeEllipse(0, gy, zone * 2 - 14, (zone * 2 - 14) * ry);
        ground.lineStyle(4, ally ? 0x7dffc0 : 0xff4d5e, 0.9).strokeEllipse(0, gy, zone * 2, zone * 2 * ry);
        if (!ally) for (let i = 0; i < 24; i++) {
          const a = (i / 24) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a) * ry;
          ground.lineStyle(5, 0xff4d5e, 0.85).lineBetween(c * (zone + 8), gy + sn * (zone + 8), c * (zone + 26), gy + sn * (zone + 26));
        }
        view.ring = this.add.image(0, gy, 'rune').setScale((zone * 2) / 256 * 0.92, (zone * 2) / 256 * 0.92 * ry).setTint(color).setAlpha(0.5).setBlendMode(Phaser.BlendModes.ADD);
        const pillar = this.add.image(0, -230, 'glow').setScale(1.6, 5.5).setTint(color).setAlpha(0.35).setBlendMode(Phaser.BlendModes.ADD);
        const shadow = this.add.image(0, gy + 18, 'shadow').setScale(3.6, 1.9).setAlpha(0.85);
        // base-*.png 内容底边约在图片 77% 处；底边落在椭圆中心下方 ~40px
        view.body = this.add.image(0, gy + 40, `base-${e.team}`).setOrigin(0.5, 0.77).setScale(1.6);
        view.aura = this.add.image(0, -70, 'glow').setScale(4).setTint(0xffffff).setAlpha(0).setBlendMode(Phaser.BlendModes.ADD);
        view.bar = this.add.graphics();
        view.banner = this.makeBaseBanner(e.team, ally);
        view.banner.setPosition(0, -385);
        root.add([ground, view.ring, pillar, shadow, view.body, view.aura, view.bar, view.banner]);
        view.pointer = this.makeBasePointer(e.team, ally);
        break;
      }
      case 'Tower': {
        const shadow = this.add.image(0, 10, 'shadow').setScale(1.2).setAlpha(0.7);
        view.body = this.add.image(0, 0, `tower-${e.team}`).setOrigin(0.5, 0.9);
        view.aura = this.add.image(0, -118, 'glow').setScale(0.9).setTint(color).setAlpha(0.6).setBlendMode(Phaser.BlendModes.ADD);
        view.bar = this.add.graphics();
        root.add([shadow, view.body, view.aura, view.bar]);
        break;
      }
      case 'Hero': {
        const shadow = this.add.image(0, 2, 'shadow').setScale(0.6).setAlpha(0.8);
        const ring = this.add.graphics();
        ring.lineStyle(isLocal ? 3 : 2, isLocal ? 0xfff2b0 : color, isLocal ? 0.9 : 0.6).strokeEllipse(0, 2, 62, 22);
        view.body = this.add.image(0, 0, `hero-${e.hero ?? 'Arcanist'}-${e.team}`).setOrigin(0.5, 0.88).setScale(0.82);
        view.bar = this.add.graphics();
        view.label = this.add.text(0, -122, e.name ?? '', { fontFamily: 'Noto Sans SC, Microsoft YaHei, sans-serif', fontSize: isLocal ? '16px' : '14px', fontStyle: isLocal ? 'bold' : 'normal', color: isLocal ? '#fff2c4' : e.team === this.deps.welcome.team ? '#d8f5e6' : '#ffd9de', stroke: '#05070d', strokeThickness: 4 }).setOrigin(0.5);
        view.status = this.add.text(0, -140, '', { fontSize: '16px', color: '#ffe27a', stroke: '#000', strokeThickness: 3 }).setOrigin(0.5);
        const heroRig = this.makeRig(view, (e.hero ?? 'Arcanist') as RigName, e.team, e.hero === 'Brawler' ? 88 : 108);
        if (!heroRig) this.attachLegs(view, root, 0.82);
        root.add([shadow, ring, ...(heroRig ? [heroRig.root] : [...(view.legs ?? []), view.body]), view.bar, view.label, view.status]);
        break;
      }
      case 'Minion': {
        const shadow = this.add.image(0, 2, 'shadow').setScale(0.38).setAlpha(0.7);
        view.body = this.add.image(0, 0, `minion-${e.team}`).setOrigin(0.5, 0.88).setScale(Math.min(0.85, 0.62 + e.level * 0.015));
        view.bar = this.add.graphics();
        const minionRig = this.makeRig(view, 'minion', e.team, 40 + Math.min(10, e.level * 0.8));
        if (!minionRig) this.attachLegs(view, root, view.body.scaleX);
        root.add([shadow, ...(minionRig ? [minionRig.root] : [...(view.legs ?? []), view.body]), view.bar]);
        break;
      }
      case 'SuperMinion': {
        const shadow = this.add.image(0, 6, 'shadow').setScale(1.4).setAlpha(0.85);
        view.aura = this.add.image(0, -50, 'glow').setScale(2.2).setTint(0xc35bff).setAlpha(0.5).setBlendMode(Phaser.BlendModes.ADD);
        view.body = this.add.image(0, 0, `super-${e.team}`).setOrigin(0.5, 0.9).setScale(1.1);
        view.bar = this.add.graphics();
        const superRig = this.makeRig(view, 'super', e.team, 150);
        if (!superRig) this.attachLegs(view, root, 1.1);
        root.add([shadow, view.aura, ...(superRig ? [superRig.root] : [...(view.legs ?? []), view.body]), view.bar]);
        this.superEntrance(e);
        break;
      }
    }
    this.views.set(e.id, view);
    return view;
  }

  private renderEntity(e: EntitySnapshot, isLocal: boolean, now: number, delta = 16): void {
    const view = this.views.get(e.id) ?? this.createView(e, isLocal);
    const t = now / 1000;
    view.root.setPosition(e.x, e.y);
    if (e.kind === 'PoisonZone') {
      view.ring?.setRotation(t * 0.25);
      view.aura?.setAlpha(0.14 + Math.sin(t * 2 + view.phase) * 0.05);
      return;
    }
    view.root.setDepth(e.y);
    const dead = e.respawn > 0 || e.hp <= 0;
    view.root.setVisible(!dead);
    if (dead) return;
    const moving = Math.hypot(e.vx, e.vy) > 5 || (isLocal && (this.keys.W.isDown || this.keys.A.isDown || this.keys.S.isDown || this.keys.D.isDown));
    if (view.body || view.rig) {
      if (view.rig) this.animateRig(view, e, moving, now, delta);
      else if (e.kind === 'Hero' || e.kind === 'Minion' || e.kind === 'SuperMinion') {
        this.animateWalk(view, e, moving, t, delta);
      }
      if (view.lastFlags !== e.flags) {
        view.lastFlags = e.flags;
        view.rig?.setTint(e.flags & FLAGS.SLOWED ? 0x9fd8ff : null);
        for (const part of [...(view.body ? [view.body] : []), ...(view.legs ?? [])]) {
          if (e.flags & FLAGS.SLOWED) part.setTint(0x9fd8ff); else part.clearTint();
        }
        if (view.status) view.status.setText(e.flags & FLAGS.STUNNED ? '✦ 眩晕 ✦' : e.flags & FLAGS.SLOWED ? '❄' : '');
      }
    }
    if (e.kind === 'Base') {
      view.banner?.setY(-385 + Math.sin(t * 2.2) * 6);
      if (view.banner) {
        // 己方基地旗帜只在开局引导时显示；敌方旗帜在靠近后变淡，避免遮挡战斗
        const ally = e.team === this.deps.welcome.team;
        const me = this.store.entities.get(this.deps.welcome.entity_id);
        const near = me ? Math.hypot(me.x - e.x, me.y - e.y) < 950 : false;
        const want = ally ? (now - this.startedAt < 30000 ? 1 : 0) : near ? 0.35 : 1;
        const a = view.banner.alpha + (want - view.banner.alpha) * Math.min(1, delta / 300);
        view.banner.setAlpha(a).setVisible(a > 0.02).setScale(this.deps.touch.active ? 0.72 : 1);
      }
      view.ring?.setAlpha(0.38 + Math.sin(t * 2) * 0.14);
    }
    if (e.kind === 'Base' && view.aura) {
      const shielded = (e.flags & FLAGS.INVULNERABLE) !== 0;
      view.aura.setAlpha(shielded ? 0.22 + Math.sin(t * 2.4) * 0.06 : 0);
    }
    if (e.kind === 'Tower' && view.aura) view.aura.setAlpha(0.45 + Math.sin(t * 3 + view.phase) * 0.15);
    if (e.kind === 'SuperMinion' && view.aura) view.aura.setScale(2.1 + Math.sin(t * 5) * 0.2);
    if (view.bar && Math.abs(view.lastHp - e.hp) > 0.5) {
      view.lastHp = e.hp;
      this.drawBar(view, e, isLocal);
    }
  }

  // ---------------------------------------------------------------- 走路动画

  /** 用关节拆分的骨骼替换整张贴图；body 保留但隐藏（不加入容器），供旧逻辑兜底。 */
  private makeRig(view: View, name: RigName, team: Team, height: number): Rig | null {
    if (!hasRig(this, name, team)) return null;
    const rig = new Rig(this, name, team, height);
    view.rig = rig;
    view.body?.destroy();
    view.body = undefined;
    return rig;
  }

  private animateRig(view: View, e: EntitySnapshot, moving: boolean, now: number, delta: number): void {
    const rig = view.rig!;
    // 冷却突然变大 = 刚释放技能
    if (e.kind === 'Hero') {
      const prev = view.lastCooldowns;
      if (prev) for (let i = 0; i < 3; i++) if (e.cooldowns[i] > prev[i] + 4) rig.play(['Q', 'E', 'R'][i], now);
      view.lastCooldowns = [...e.cooldowns];
    }
    if (e.attacking && !rig.busy(now) && now - (view.lastAttack ?? 0) > 380) { view.lastAttack = now; rig.play('attack', now); }
    if (!rig.onStep && e.kind !== 'Minion') {
      rig.onStep = () => { const v = this.store.entities.get(e.id); if (v && this.cameras.main.worldView.contains(v.x, v.y)) this.footDust(v.x, v.y + 2, e.kind === 'SuperMinion' ? 1.6 : 1); };
    }
    rig.update(now, delta, moving, Math.hypot(e.vx, e.vy), Math.cos(e.facing) >= 0, e.attacking && e.kind === 'Hero' ? 1.04 : 1);
  }

  private legSplits = new Map<string, LegSplit | null>();

  /** 扫描贴图 alpha，找到角色脚部区域（内容底部约 26%），用于拆出左右腿。 */
  private legSplit(key: string): LegSplit | null {
    if (this.legSplits.has(key)) return this.legSplits.get(key)!;
    let result: LegSplit | null = null;
    try {
      const src = this.textures.get(key).getSourceImage() as CanvasImageSource & { width: number; height: number };
      const w = src.width, h = src.height;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(src, 0, 0);
      const data = ctx.getImageData(0, 0, w, h).data;
      let top = h, bottom = 0, left = w, right = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 60) { if (y < top) top = y; if (y > bottom) bottom = y; if (x < left) left = x; if (x > right) right = x; }
      }
      if (bottom > top) {
        const legTop = Math.round(bottom - (bottom - top) * 0.26);
        // 腿部区域内按 alpha 质心切分左右腿
        let sum = 0, count = 0;
        for (let y = legTop; y <= bottom; y++) for (let x = left; x <= right; x++) if (data[(y * w + x) * 4 + 3] > 60) { sum += x; count++; }
        result = { top: legTop, cx: Math.round(count ? sum / count : (left + right) / 2), w, h, foot: bottom };
      }
    } catch { result = null; }
    this.legSplits.set(key, result);
    return result;
  }

  private attachLegs(view: View, root: Phaser.GameObjects.Container, scale: number): void {
    const body = view.body;
    if (!body) return;
    view.baseScale = scale;
    view.walk = Math.random() * Math.PI * 2;
    view.stepSign = 1;
    const split = this.legSplit(body.texture.key);
    if (!split) return;
    const mk = (x: number, w: number) => this.add.image(0, 0, body.texture.key).setOrigin(body.originX, body.originY).setScale(scale).setCrop(x, split.top, w, split.h - split.top);
    view.legs = [mk(0, split.cx), mk(split.cx, split.w - split.cx)];
    body.setCrop(0, 0, split.w, split.top + 3);
    void root;
  }

  /** 迈步：左右腿交替抬起前后摆，上身起伏、前倾并轻微左右摇摆；停下时呼吸。 */
  private animateWalk(view: View, e: EntitySnapshot, moving: boolean, t: number, delta: number): void {
    const body = view.body!;
    const flip = Math.cos(e.facing) < 0;
    const dir = flip ? -1 : 1;
    body.setFlipX(flip);
    view.legs?.forEach((leg) => leg.setFlipX(flip));
    const base = (view.baseScale ?? 1) * (e.attacking ? 1.08 : 1);
    const speed = Math.hypot(e.vx, e.vy);
    const big = e.kind === 'SuperMinion' ? 1.6 : e.kind === 'Minion' ? 0.75 : 1;
    if (moving) {
      // 步频随速度变化，约 2 步/秒（每步 = 半个周期）
      view.walk = (view.walk ?? 0) + (delta / 1000) * Math.max(8, Math.min(14, speed / 22 + 6)) * (e.kind === 'SuperMinion' ? 0.7 : 1);
    } else {
      // 停下时把腿收回到并拢
      const w = view.walk ?? 0, target = Math.round(w / Math.PI) * Math.PI;
      view.walk = w + (target - w) * Math.min(1, delta / 90);
    }
    const ph = view.walk ?? 0, sn = Math.sin(ph), bounce = Math.abs(Math.cos(ph));
    const stride = moving ? 1 : Math.min(1, Math.abs(sn) * 2);
    if (view.legs) {
      const [l, r] = view.legs;
      l.setScale(base).setPosition(sn * 6 * dir * big * stride, -Math.max(0, sn) * 8 * big * stride).setRotation(sn * 0.18 * dir * stride);
      r.setScale(base).setPosition(-sn * 6 * dir * big * stride, -Math.max(0, -sn) * 8 * big * stride).setRotation(-sn * 0.18 * dir * stride);
    }
    if (moving) {
      body.y = -(1 - bounce) * 0 - bounce * 4 * big;
      body.setRotation(0.06 * dir + sn * 0.035);
      body.setScale(base * (1 + bounce * 0.02), base * (1 - bounce * 0.035));
      // 落脚时扬起一点尘土（只在画面内、只给英雄和超级魔兽，控制开销）
      const sign = sn >= 0 ? 1 : -1;
      if (sign !== view.stepSign) {
        view.stepSign = sign;
        if (e.kind !== 'Minion' && this.cameras.main.worldView.contains(e.x, e.y)) this.footDust(e.x - sign * 8 * dir, e.y + 2, big);
      }
    } else {
      const breath = Math.sin(t * 2.2 + view.phase);
      body.y = breath * -1.2;
      body.setRotation(body.rotation * 0.8);
      body.setScale(base * (1 - breath * 0.008), base * (1 + breath * 0.015));
    }
  }

  private footDust(x: number, y: number, big: number): void {
    for (let i = 0; i < 2; i++) {
      const puff = this.add.image(x + (Math.random() - 0.5) * 14, y, 'glow').setTint(0xb7a98c).setAlpha(0.35).setScale(0.12 * big).setDepth(y - 1);
      this.tweens.add({ targets: puff, y: y - 8 - Math.random() * 6, x: puff.x + (Math.random() - 0.5) * 18, scale: 0.32 * big, alpha: 0, duration: 420 + Math.random() * 180, ease: 'Quad.easeOut', onComplete: () => puff.destroy() });
    }
  }

  private drawBar(view: View, e: EntitySnapshot, isLocal: boolean): void {
    const g = view.bar!;
    g.clear();
    const widths: Record<string, number> = { Hero: 70, Minion: 34, SuperMinion: 120, Tower: 90, Base: 240 };
    const offsets: Record<string, number> = { Hero: -104, Minion: -60, SuperMinion: -150, Tower: -158, Base: -292 };
    const w = widths[e.kind] ?? 50, y = offsets[e.kind] ?? -60, h = e.kind === 'Minion' ? 5 : e.kind === 'Base' ? 14 : 9;
    const ratio = Math.max(0, Math.min(1, e.hp / e.max_hp));
    const color = isLocal ? 0x62d58e : TEAM_COLORS[e.team];
    g.fillStyle(0x05070d, 0.85).fillRect(-w / 2 - 2, y - 2, w + 4, h + 4);
    g.fillStyle(color, 1).fillRect(-w / 2, y, w * ratio, h);
    if (e.kind === 'Hero' || e.kind === 'Tower' || e.kind === 'Base') {
      g.lineStyle(1, 0x000000, 0.4);
      const segments = Math.floor(e.max_hp / 200);
      for (let i = 1; i < segments; i++) g.lineBetween(-w / 2 + (w * i) / segments, y, -w / 2 + (w * i) / segments, y + h);
    }
  }

  // ---------------------------------------------------------------- 求救 / 支援指引

  /** 技能是否冷却完毕（本地英雄死亡时视为不可用） */
  skillReady(slot: number): boolean {
    const local = this.store.entities.get(this.deps.welcome.entity_id);
    return !!local && local.respawn === 0 && (local.cooldowns[slot] ?? 0) === 0;
  }

  setQuickCast(on: boolean): void {
    this.quickCast = on; this.aimingSlot = -1;
    localStorage.setItem('mdtr-quickcast', on ? '1' : '0');
  }

  private skillInfo(local: EntitySnapshot, slot: number) {
    return this.deps.welcome.map.heroes.find((h) => h.kind === local.hero)?.skills[slot];
  }

  /** 触屏拖动偏移 → 世界坐标瞄准点；拖动很小时退回自动瞄准最近敌人 */
  private touchAimPoint(local: EntitySnapshot, slot: number, dx: number, dy: number): { x: number; y: number } {
    const info = this.skillInfo(local, slot);
    const range = Math.max(info?.range ?? 0, 60);
    const len = Math.hypot(dx, dy);
    if (len < 0.18) {
      const t = this.nearestEnemy(local);
      if (t && Math.hypot(t.x - local.x, t.y - local.y) <= range + 120) return { x: t.x, y: t.y };
      const f = local.facing;
      return { x: local.x + Math.cos(f) * range, y: local.y + Math.sin(f) * range };
    }
    const k = info?.effect === 'dash' ? 1 / len : Math.min(1, len) / len;
    return { x: local.x + dx * k * range, y: local.y + dy * k * range };
  }

  /** 技能指示器：射程圈 + 落点/方向/自身范围 */
  private drawIndicator(local: EntitySnapshot, now: number): void {
    const g = this.indicator;
    g.clear();
    const touch = this.deps.touch;
    const slot = touch.aim ? touch.aim.slot : this.aimingSlot;
    if (slot < 0 || local.respawn > 0) return;
    const info = this.skillInfo(local, slot);
    if (!info) return;
    const cancel = !!touch.aim?.cancel;
    const color = cancel ? 0xff4d5e : 0x8fe3ff;
    const pulse = 0.85 + Math.sin(now / 160) * 0.15;
    let target: { x: number; y: number };
    if (touch.aim) target = this.touchAimPoint(local, slot, touch.aim.dx, touch.aim.dy);
    else {
      const w = this.input.activePointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
      target = { x: w.x, y: w.y };
    }
    const dx = target.x - local.x, dy = target.y - local.y, dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist, uy = dy / dist;
    if (info.range > 0) {
      g.fillStyle(color, 0.05).fillCircle(local.x, local.y, info.range);
      g.lineStyle(2, color, 0.45).strokeCircle(local.x, local.y, info.range);
    }
    if (info.effect === 'nova' || info.effect === 'heal') {
      const c = info.effect === 'heal' && !cancel ? 0x8dff9a : color;
      g.fillStyle(c, 0.14 * pulse).fillCircle(local.x, local.y, info.radius);
      g.lineStyle(3, c, 0.8).strokeCircle(local.x, local.y, info.radius);
    } else if (info.effect === 'dash') {
      const ex = local.x + ux * info.range, ey = local.y + uy * info.range;
      const nx = -uy, ny = ux, w = 22;
      g.fillStyle(color, 0.22 * pulse);
      g.fillPoints([
        { x: local.x + nx * w, y: local.y + ny * w }, { x: ex - ux * 34 + nx * w, y: ey - uy * 34 + ny * w },
        { x: ex - ux * 34 + nx * w * 1.9, y: ey - uy * 34 + ny * w * 1.9 }, { x: ex, y: ey },
        { x: ex - ux * 34 - nx * w * 1.9, y: ey - uy * 34 - ny * w * 1.9 }, { x: ex - ux * 34 - nx * w, y: ey - uy * 34 - ny * w },
        { x: local.x - nx * w, y: local.y - ny * w },
      ] as Phaser.Types.Math.Vector2Like[], true);
      if (info.radius > 0) g.lineStyle(2, color, 0.7).strokeCircle(ex, ey, info.radius);
    } else {
      const reach = Math.min(dist, info.range);
      const tx = local.x + ux * reach, ty = local.y + uy * reach;
      g.lineStyle(2, color, 0.35).lineBetween(local.x, local.y, tx, ty);
      g.fillStyle(color, 0.2 * pulse).fillCircle(tx, ty, info.radius);
      g.lineStyle(3, color, 0.85).strokeCircle(tx, ty, info.radius);
    }
  }

  requestHelp(): void {
    const now = performance.now();
    const local = this.store.entities.get(this.deps.welcome.entity_id);
    if (!local || local.respawn > 0 || now < this.helpReadyAt) return;
    this.pendingHelp = true;
    this.helpReadyAt = now + 8000;
    this.deps.audio.unlock();
    this.deps.hud.helpCooldown(8);
    const tick = () => {
      const left = Math.ceil((this.helpReadyAt - performance.now()) / 1000);
      this.deps.hud.helpCooldown(Math.max(0, left));
      if (left > 0) this.time.delayedCall(250, tick);
    };
    this.time.delayedCall(250, tick);
  }

  acceptHelp(id: number): void {
    if (id === this.deps.welcome.entity_id) return;
    const target = this.store.entities.get(id);
    if (!target || target.respawn > 0) { this.deps.hud.clearHelpPrompt(id); return; }
    this.pendingAccept = id;
    this.guide = { target: id, name: target.name ?? '队友', until: performance.now() + 30000 };
    this.deps.hud.clearHelpPrompt(id);
    this.deps.hud.announce(`已接受求救，跟随脚下箭头前往 ${target.name ?? '队友'}`);
    this.deps.audio.play('Click');
  }

  /** 在本地英雄脚下画指向求救者的箭头。到达、对方阵亡或超时后自动结束。 */
  private updateGuide(local: EntitySnapshot, now: number): void {
    const g = this.guideGfx;
    g.clear();
    if (!this.guide) { this.guideText.setVisible(false); return; }
    const target = this.store.entities.get(this.guide.target);
    const done = (msg?: string) => { this.guide = null; this.guideText.setVisible(false); if (msg) this.deps.hud.feed(msg, this.deps.welcome.team); };
    if (!target || target.respawn > 0 || target.hp <= 0) { done('支援目标已阵亡'); return; }
    if (now > this.guide.until) { done(); return; }
    if (local.respawn > 0) { this.guideText.setVisible(false); return; }
    const dx = target.x - local.x, dy = target.y - local.y, dist = Math.hypot(dx, dy);
    if (dist < 200) { done(`已抵达 ${this.guide.name} 身边`); return; }
    const ang = Math.atan2(dy, dx), cos = Math.cos(ang), sin = Math.sin(ang);
    const pulse = (now / 600) % 1;
    const color = 0x5dffa8;
    // 脚下光圈
    g.lineStyle(4, color, 0.75).strokeEllipse(local.x, local.y + 4, 120, 50);
    g.fillStyle(color, 0.10).fillEllipse(local.x, local.y + 4, 120, 50);
    // 三个依次流动的 V 形箭头（地面透视：y 方向压扁）
    for (let i = 0; i < 3; i++) {
      const t = (i / 3 + pulse) % 1;
      const r = 70 + t * 90, alpha = Math.sin(t * Math.PI) * 0.95;
      const cx = local.x + cos * r, cy = local.y + 4 + sin * r * 0.5;
      const s = 22;
      const p = (fx: number, fy: number) => ({ x: cx + (fx * cos - fy * sin) * s, y: cy + (fx * sin + fy * cos) * s * 0.5 });
      const tip = p(1, 0), l = p(-0.6, -0.9), m = p(-0.1, 0), rr = p(-0.6, 0.9);
      g.fillStyle(color, alpha).fillPoints([tip, l, m, rr], true);
      g.lineStyle(2, 0xffffff, alpha * 0.8).strokePoints([tip, l, m, rr], true);
    }
    // 目标处的光柱提示（在屏幕内可见时）
    g.lineStyle(3, color, 0.6 + Math.sin(now / 150) * 0.3).strokeEllipse(target.x, target.y + 4, 150 + pulse * 40, 60 + pulse * 16);
    this.guideText.setText(`🆘 支援 ${this.guide.name} · ${Math.round(dist / 10)}m`).setPosition(local.x, local.y + 34).setVisible(true);
  }

  private makeBaseBanner(team: Team, ally: boolean): Phaser.GameObjects.Container {
    const color = TEAM_COLORS[team];
    const title = ally ? '我方基地' : '敌方基地';
    const sub = ally ? '守护它！' : '摧毁它！';
    const text = this.add.text(0, -6, `${ally ? '◆' : '⚔'} ${title}`, {
      fontFamily: 'system-ui,"Noto Sans CJK SC","PingFang SC","Microsoft YaHei",sans-serif', fontSize: '40px', fontStyle: 'bold', color: ally ? '#d9ffec' : '#ffe1e5',
      stroke: ally ? '#0b5a3a' : '#6d0f1c', strokeThickness: 4, padding: { x: 6, y: 6 },
    }).setOrigin(0.5);
    const hint = this.add.text(0, 30, `${teamNames[team]} · ${sub}`, {
      fontFamily: 'system-ui,sans-serif', fontSize: '17px', color: ally ? '#b9ffd9' : '#ffc2c9', stroke: '#000000', strokeThickness: 4,
    }).setOrigin(0.5);
    const w = Math.max(text.width, hint.width) + 56;
    const plate = this.add.graphics();
    plate.fillStyle(0x070912, 0.82).fillRoundedRect(-w / 2, -40, w, 92, 12);
    plate.lineStyle(4, color, 1).strokeRoundedRect(-w / 2, -40, w, 92, 12);
    plate.fillStyle(color, 1).fillTriangle(-16, 52, 16, 52, 0, 72);
    const c = this.add.container(0, 0, [plate, text, hint]);
    c.setData('hint', hint).setData('sub', sub).setData('team', team);
    return c;
  }

  private makeBasePointer(team: Team, ally: boolean): Phaser.GameObjects.Container {
    const color = TEAM_COLORS[team];
    const arrow = this.add.graphics();
    arrow.fillStyle(color, 0.95).fillTriangle(30, 0, -12, -20, -12, 20);
    arrow.lineStyle(3, 0xffffff, 0.9).strokeTriangle(30, 0, -12, -20, -12, 20);
    const label = this.add.text(0, 0, ally ? '我方基地' : '敌方基地', {
      fontFamily: 'system-ui,sans-serif', fontSize: '15px', fontStyle: 'bold', color: '#ffffff', stroke: ally ? '#0b5a3a' : '#6d0f1c', strokeThickness: 5,
    }).setOrigin(0.5);
    const c = this.add.container(0, 0, [arrow, label]).setScrollFactor(0).setDepth(200000).setVisible(false);
    c.setData('arrow', arrow).setData('label', label);
    return c;
  }

  /** 基地不在屏幕内时，在屏幕边缘画箭头指向它。 */
  private updateBasePointers(): void {
    const cam = this.cameras.main, view = cam.worldView;
    const cx = cam.width / 2, cy = cam.height / 2, margin = 56;
    for (const [id, v] of this.views) {
      if (v.kind !== 'Base' || !v.pointer) continue;
      const e = this.store.entities.get(id);
      if (!e) continue;
      const onScreen = Phaser.Geom.Rectangle.Overlaps(view, new Phaser.Geom.Rectangle(e.x - 120, e.y - 420, 240, 440));
      v.pointer.setVisible(!onScreen);
      if (onScreen) continue;
      const dx = (e.x - view.centerX) * cam.zoom, dy = (e.y - 120 - view.centerY) * cam.zoom;
      const k = Math.min((cx - margin) / Math.max(1e-3, Math.abs(dx)), (cy - margin) / Math.max(1e-3, Math.abs(dy)));
      const px = cx + dx * k, ang = Math.atan2(dy, dx);
      // 避开顶部比分栏与底部 HUD / 技能轮盘
      const bottomLimit = this.deps.touch.active && px > cam.width - 260 ? cam.height - 235 : cam.height - 150;
      const py = Phaser.Math.Clamp(cy + dy * k, 110, Math.max(120, bottomLimit));
      // scrollFactor=0 的对象仍会绕相机中心缩放，这里反算回屏幕像素，并保持指示器大小恒定
      v.pointer.setPosition(cx + (px - cx) / cam.zoom, cy + (py - cy) / cam.zoom).setScale(1 / cam.zoom);
      (v.pointer.getData('arrow') as Phaser.GameObjects.Graphics).setRotation(ang).setPosition(Math.cos(ang) * 10, Math.sin(ang) * 10);
      (v.pointer.getData('label') as Phaser.GameObjects.Text).setPosition(-Math.cos(ang) * 46, -Math.sin(ang) * 30);
    }
  }

  private destroyView(id: number, view: View): void {
    view.pointer?.destroy();
    this.views.delete(id);
    if (view.emitter) {
      view.emitter.stop();
      this.time.delayedCall(2600, () => view.emitter?.destroy());
    }
    if (view.kind === 'PoisonZone') {
      this.tweens.add({ targets: view.root, alpha: 0, scale: 1.25, duration: 900, onComplete: () => view.root.destroy() });
      return;
    }
    if (view.kind === 'Minion' || view.kind === 'SuperMinion') {
      this.burst(view.root.x, view.root.y - 20, TEAM_COLORS[view.team], view.kind === 'SuperMinion' ? 60 : 14);
    }
    this.tweens.add({ targets: view.root, alpha: 0, y: view.root.y + 10, duration: 260, onComplete: () => view.root.destroy() });
  }

  // ---------------------------------------------------------------- 特效

  private burst(x: number, y: number, tint: number, count: number): void {
    const emitter = this.add.particles(x, y, 'particle', {
      speed: { min: 60, max: 260 }, lifespan: { min: 300, max: 800 }, scale: { start: 0.9, end: 0 },
      alpha: { start: 1, end: 0 }, tint, blendMode: 'ADD', emitting: false,
    }).setDepth(y + 50);
    emitter.explode(count);
    this.time.delayedCall(900, () => emitter.destroy());
  }

  private ringFx(x: number, y: number, radius: number, tint: number, duration = 450): void {
    const g = this.add.graphics().setDepth(y + 40).setBlendMode(Phaser.BlendModes.ADD);
    g.lineStyle(6, tint, 0.9).strokeCircle(0, 0, radius);
    g.fillStyle(tint, 0.18).fillCircle(0, 0, radius);
    g.setPosition(x, y).setScale(0.3);
    this.tweens.add({ targets: g, scale: 1, alpha: 0, duration, ease: 'Cubic.easeOut', onComplete: () => g.destroy() });
  }

  private floatText(x: number, y: number, text: string, color: string, size = 18): void {
    const label = this.add.text(x + (Math.random() - 0.5) * 20, y, text, { fontFamily: 'Georgia, serif', fontSize: `${size}px`, color, stroke: '#05070d', strokeThickness: 4 }).setOrigin(0.5).setDepth(100001);
    this.tweens.add({ targets: label, y: y - 46, alpha: 0, duration: 800, ease: 'Cubic.easeOut', onComplete: () => label.destroy() });
  }

  private projectile(e: GameEvent): void {
    if (!e.team) return;
    const sourceView = this.views.get(e.source);
    if (sourceView?.kind === 'Minion' || sourceView?.kind === 'SuperMinion') {
      this.burst(e.tx, e.ty - 20, TEAM_COLORS[e.team], sourceView.kind === 'SuperMinion' ? 18 : 3);
      return;
    }
    const fromY = e.y - (sourceView?.kind === 'Tower' ? 118 : 50);
    const p = this.add.image(e.x, fromY, `projectile-${e.team}`).setDepth(100000).setBlendMode(Phaser.BlendModes.ADD);
    p.setRotation(Math.atan2(e.ty - 30 - fromY, e.tx - e.x));
    if (sourceView?.kind === 'Tower') p.setScale(1.6, 1.3);
    this.tweens.add({ targets: p, x: e.tx, y: e.ty - 30, duration: 140, onComplete: () => { p.destroy(); this.burst(e.tx, e.ty - 30, TEAM_COLORS[e.team!], 4); } });
  }

  private superEntrance(e: EntitySnapshot): void {
    this.ringFx(e.x, e.y, 260, 0xc35bff, 1000);
    this.burst(e.x, e.y - 60, 0xc35bff, 70);
    const pillar = this.add.image(e.x, e.y - 200, 'glow').setScale(1.2, 6).setTint(0xd27bff).setBlendMode(Phaser.BlendModes.ADD).setDepth(e.y + 60);
    this.tweens.add({ targets: pillar, alpha: 0, scaleX: 3, duration: 1400, onComplete: () => pillar.destroy() });
  }

  private playEvent(e: GameEvent): void {
    if (this.seenEvents.has(e.id)) return;
    this.seenEvents.add(e.id);
    if (this.seenEvents.size > 4000) this.seenEvents = new Set([...this.seenEvents].slice(-2000));
    const hud = this.deps.hud, audio = this.deps.audio;
    const localId = this.deps.welcome.entity_id;
    const cam = this.cameras.main;
    const onScreen = cam.worldView.contains(e.x, e.y) || cam.worldView.contains(e.tx, e.ty);
    switch (e.kind) {
      case 'Shot':
        this.views.get(e.source)?.rig?.play('attack', performance.now());
        if (onScreen) { this.projectile(e); if (e.source === localId) audio.play('Shot'); }
        break;
      case 'Hit':
        if (onScreen && e.value > 0) { const hv = this.views.get(e.target); if (hv?.rig && !hv.rig.busy(performance.now())) hv.rig.play('hit', performance.now()); }
        if (onScreen && e.value > 0 && (e.target === localId || e.source === localId)) {
          this.floatText(e.x, e.y - 90, `-${Math.round(e.value)}`, e.target === localId ? '#ff7d8c' : '#ffe08a', e.source === localId ? 20 : 17);
          if (e.source === localId) audio.play('Hit');
        }
        break;
      case 'Poison':
        if (onScreen) this.floatText(e.x, e.y - 90, `☠ -${Math.round(e.value)}`, '#c6ff7a', 16);
        if (e.target === localId) { hud.damageFlash(); audio.play('Hit'); }
        break;
      case 'Skill': {
        const tint = e.team ? TEAM_COLORS[e.team] : 0xffffff;
        const view = this.views.get(e.source);
        const heroColor = view && view.kind === 'Hero' ? tint : tint;
        if (onScreen) {
          if (e.value > 0) { this.ringFx(e.tx, e.ty, e.value, heroColor); this.burst(e.tx, e.ty - 20, heroColor, 24); }
          else { // 位移技能：拖尾
            const trail = this.add.graphics().setDepth(e.y).setBlendMode(Phaser.BlendModes.ADD);
            trail.lineStyle(14, heroColor, 0.5).lineBetween(e.x, e.y - 30, e.tx, e.ty - 30);
            this.tweens.add({ targets: trail, alpha: 0, duration: 350, onComplete: () => trail.destroy() });
          }
          if (e.source === localId || Math.hypot(e.x - cam.midPoint.x, e.y - cam.midPoint.y) < 500) audio.play('Skill');
        }
        break;
      }
      case 'TowerDestroyed': {
        const tint = e.team ? TEAM_COLORS[e.team] : 0xffffff;
        this.burst(e.x, e.y - 80, tint, 90);
        this.burst(e.x, e.y - 80, 0xffffff, 30);
        this.ringFx(e.x, e.y, 340, tint, 900);
        if (onScreen) cam.shake(500, 0.012);
        cam.flash(250, 255, 255, 255, false);
        hud.announce(e.text, true);
        hud.feed(e.text, e.team);
        audio.play('TowerDestroyed');
        break;
      }
      case 'SuddenDeath':
        cam.shake(1200, 0.01);
        cam.flash(700, 160, 60, 255);
        hud.announce(e.text, true);
        audio.play('SuddenDeath');
        break;
      case 'Death':
        if (onScreen) this.burst(e.x, e.y - 40, 0xffffff, 26);
        hud.feed(e.text, e.team);
        if (e.target === localId) { audio.play('Death'); cam.shake(200, 0.006); }
        break;
      case 'Respawn':
        if (onScreen) { this.ringFx(e.x, e.y, 90, 0xfff0b0); }
        break;
      case 'WaveSpawned':
        hud.feed(e.text, null);
        if (e.value > 1 && Number.isInteger((e.value - 1) / 5)) hud.announce(`${e.text} · 魔兽愈发强大`);
        break;
      case 'Announcement':
        hud.announce(e.text);
        audio.play('Announcement');
        break;
      case 'Victory':
        hud.announce(e.text, true);
        break;
      case 'HelpRequest': {
        if (e.team !== this.deps.welcome.team) break;
        if (onScreen) { this.ringFx(e.x, e.y, 160, 0xff5d6c, 900); this.floatText(e.x, e.y - 130, '🆘 求救！', '#ff9aa6', 22); }
        if (e.source === localId) { hud.announce('已向队友发出求救'); break; }
        hud.helpPrompt(e.text || '队友', e.source, () => this.acceptHelp(e.source));
        hud.feed(`${e.text || '队友'} 请求支援`, e.team);
        audio.play('Announcement');
        break;
      }
      case 'HelpAccepted':
        if (e.team !== this.deps.welcome.team) break;
        if (e.target === localId) { hud.announce(`${e.text || '队友'} 正在赶来支援你！`, true); audio.play('Announcement'); }
        else if (e.source !== localId) hud.feed(`${e.text || '队友'} 前去支援`, e.team);
        break;
    }
  }
}

