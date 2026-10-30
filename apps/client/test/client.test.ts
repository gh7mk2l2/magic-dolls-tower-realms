import { describe, expect, it } from 'vitest';
import { Interpolator, SnapshotStore } from '../src/interpolation';
import { NavGrid, Predictor, integrate } from '../src/prediction';
import { decodeServerMessage, encodeClientMessage, type EntitySnapshot, type Snapshot } from '../src/protocol';
import { encode } from '@msgpack/msgpack';

const entity = (id: number, x: number): EntitySnapshot => ({
  id, kind: 'Minion', team: 'Red', x, y: 0, vx: 0, vy: 0, hp: 10, max_hp: 10, radius: 10, hero: null, owner: null, name: null,
  cooldowns: [0, 0, 0], respawn: 0, facing: 0, attacking: false, flags: 0, speed_mul: 1, level: 0,
});
const snap = (tick: number, full: boolean, entities: EntitySnapshot[], removed: number[] = []): Snapshot => ({
  tick, server_time: tick * 50, remaining: 900, phase: 'Battle', winner: null, full, acks: [], entities, removed, events: [], red_score: 0, blue_score: 0, wave: 0,
});

describe('协议', () => {
  it('单元枚举编码为字符串、带数据枚举编码为单键 map', () => {
    expect(encodeClientMessage('Resync')[0]).toBe(0xa6);
    const bytes = encode({ Pong: 7 });
    expect(decodeServerMessage(bytes)).toEqual({ Pong: 7 });
    expect(() => decodeServerMessage(encode([1, 2]))).toThrow();
  });
});

describe('增量快照', () => {
  it('没有关键帧时拒绝增量并请求重同步，之后正确合并与删除', () => {
    const store = new SnapshotStore();
    expect(store.apply(snap(1, false, [entity(1, 0)])).resync).toBe(true);
    expect(store.apply(snap(2, true, [entity(1, 0), entity(2, 5)])).accepted).toBe(true);
    store.apply(snap(3, false, [entity(1, 9)], [2]));
    expect(store.entities.get(1)!.x).toBe(9);
    expect(store.entities.has(2)).toBe(false);
    expect(store.apply(snap(3, false, [])).accepted).toBe(false);
    expect(store.apply(snap(5, false, [])).resync).toBe(true);
  });
});

describe('插值', () => {
  it('在两帧之间线性插值', () => {
    const interp = new Interpolator(0, 50);
    interp.push(10, new Map([[1, entity(1, 0)]]), 1000);
    interp.push(11, new Map([[1, entity(1, 100)]]), 1050);
    const [mid] = interp.sample(1025);
    expect(mid.x).toBeCloseTo(50, 0);
  });
});

describe('预测', () => {
  const grid = new NavGrid(1000, 1000, 10, Array.from({ length: 100 }, (_, i) => (i % 10 === 5 ? 1 : 0)));
  it('滑墙规则与服务端一致', () => {
    const p = integrate({ x: 480, y: 300 }, { seq: 1, move_x: 1, move_y: 1, aim_x: 0, aim_y: 0, attack: false, skills: 0 }, 400 * Math.SQRT2, 0.1, grid);
    expect(p.x).toBe(480);
    expect(p.y).toBeCloseTo(340, 3);
  });
  it('校正时重放未确认输入', () => {
    const pred = new Predictor(new NavGrid(1000, 1000, 10, new Array(100).fill(0)), 20);
    pred.reset(100, 100);
    for (let seq = 1; seq <= 4; seq++) pred.push({ seq, move_x: 1, move_y: 0, aim_x: 0, aim_y: 0, attack: false, skills: 0 }, 200);
    expect(pred.predicted.x).toBeCloseTo(140);
    pred.reconcile(110, 100, 1, 200); // 服务端确认 1 帧，位置 110
    expect(pred.predicted.x).toBeCloseTo(140);
    expect(pred.pendingCount).toBe(3);
  });
});

describe('20 名玩偶的表现层配置', () => {
  it('每个 HeroKind 都有视觉配置，新玩偶缺专属资源时回退到借用骨骼并染色', async () => {
    const { HEROES } = await import('../src/config');
    const { HERO_KINDS } = await import('../src/protocol');
    const { heroLook } = await import('../src/heroArt');
    expect(Object.keys(HEROES).sort()).toEqual([...HERO_KINDS].sort());
    for (const kind of HERO_KINDS) {
      const v = HEROES[kind];
      expect(v.skills).toHaveLength(3);
      expect(v.desc).toHaveLength(3);
      const look = heroLook(kind);
      if (v.base) {
        expect(v.art).toMatch(/^[a-z]+$/);
        // 专属资源未集成进 rig-data.json 时借用基础骨骼
        if (!look.dedicated) { expect(look.atlas).toBe(v.base); expect(look.tint).not.toBeNull(); }
        else expect(look.atlas).toBe(v.art);
      } else {
        expect(look.atlas).toBe(kind);
      }
    }
    expect(heroLook(null).atlas).toBe('Arcanist');
  });
});
