import type { EntitySnapshot, Snapshot } from './protocol';

export interface SnapshotApplyResult { accepted: boolean; resync: boolean }

/** 把全量关键帧 + 增量快照还原为完整世界状态。 */
export class SnapshotStore {
  entities = new Map<number, EntitySnapshot>();
  latest: Snapshot | null = null;
  private lastTick = -1;

  reset(): void { this.entities.clear(); this.latest = null; this.lastTick = -1; }

  apply(snapshot: Snapshot): SnapshotApplyResult {
    if (snapshot.full) {
      if (snapshot.tick < this.lastTick) return { accepted: false, resync: false };
      this.entities.clear();
    } else {
      if (this.lastTick < 0) return { accepted: false, resync: true };
      if (snapshot.tick <= this.lastTick) return { accepted: false, resync: false };
      // 中间丢了 tick：增量基线不再可靠。
      const gap = snapshot.tick - this.lastTick > 1;
      if (gap) {
        this.applyEntities(snapshot);
        this.lastTick = snapshot.tick;
        this.latest = snapshot;
        return { accepted: true, resync: true };
      }
    }
    this.applyEntities(snapshot);
    this.lastTick = snapshot.tick;
    this.latest = snapshot;
    return { accepted: true, resync: false };
  }

  private applyEntities(snapshot: Snapshot): void {
    for (const id of snapshot.removed) this.entities.delete(id);
    for (const entity of snapshot.entities) this.entities.set(entity.id, entity);
  }
}

interface Frame { tick: number; time: number; entities: Map<number, EntitySnapshot> }
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpAngle = (a: number, b: number, t: number) => {
  let delta = (b - a) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
};

/**
 * 远端实体的延迟插值：渲染时刻 = 当前时间 - delay，在相邻两帧之间线性插值。
 * 按服务端 tick 计算时间轴，避免网络抖动造成的抖动。
 */
export class Interpolator {
  private frames: Frame[] = [];
  private offset: number | null = null;
  constructor(private delayMs = 100, private tickMs = 50) {}

  push(tick: number, entities: Map<number, EntitySnapshot>, receivedAt = performance.now()): void {
    const serverTime = tick * this.tickMs;
    const offset = receivedAt - serverTime;
    // 偏移取最小值（最快到达的包），并缓慢回升以适应时钟漂移。
    this.offset = this.offset === null ? offset : Math.min(offset, this.offset + 0.5);
    this.frames.push({ tick, time: serverTime, entities: new Map(entities) });
    if (this.frames.length > 30) this.frames.splice(0, this.frames.length - 30);
  }

  clear(): void { this.frames = []; this.offset = null; }

  sample(now = performance.now()): EntitySnapshot[] {
    if (this.frames.length === 0 || this.offset === null) return [];
    const target = now - this.offset - this.delayMs;
    const frames = this.frames;
    if (target <= frames[0].time) return [...frames[0].entities.values()];
    const last = frames[frames.length - 1];
    if (target >= last.time) return [...last.entities.values()];
    let i = frames.length - 2;
    while (i > 0 && frames[i].time > target) i--;
    const older = frames[i], newer = frames[i + 1];
    const alpha = Math.max(0, Math.min(1, (target - older.time) / Math.max(1, newer.time - older.time)));
    const result: EntitySnapshot[] = [];
    for (const [id, b] of newer.entities) {
      const a = older.entities.get(id);
      // 复活/位移技能导致的瞬移不做插值。
      if (!a || Math.hypot(a.x - b.x, a.y - b.y) > 160) { result.push(b); continue; }
      result.push({ ...b, x: lerp(a.x, b.x, alpha), y: lerp(a.y, b.y, alpha), hp: lerp(a.hp, b.hp, alpha), facing: lerpAngle(a.facing, b.facing, alpha) });
    }
    return result;
  }
}
