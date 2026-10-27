import type { InputFrame, MapInfo } from './protocol';

export interface Point { x: number; y: number }

/** 与 crates/sim/src/flow.rs::NavGrid 完全一致的阻挡网格与滑动移动。 */
export class NavGrid {
  readonly cellW: number;
  readonly cellH: number;
  constructor(readonly width: number, readonly height: number, readonly size: number, readonly blocked: ArrayLike<number>) {
    this.cellW = width / size;
    this.cellH = height / size;
  }

  static fromMap(map: MapInfo): NavGrid { return new NavGrid(map.width, map.height, map.grid, map.blocked); }

  isBlocked(x: number, y: number): boolean {
    const cx = Math.max(0, Math.min(this.size - 1, Math.trunc(x / this.cellW)));
    const cy = Math.max(0, Math.min(this.size - 1, Math.trunc(y / this.cellH)));
    return this.blocked[cy * this.size + cx] === 1;
  }

  slide(from: Point, dx: number, dy: number): Point {
    const result = { ...from };
    const nx = Math.max(0, Math.min(this.width, from.x + dx));
    if (!this.isBlocked(nx, result.y)) result.x = nx;
    const ny = Math.max(0, Math.min(this.height, from.y + dy));
    if (!this.isBlocked(result.x, ny)) result.y = ny;
    return result;
  }
}

export function integrate(position: Point, input: InputFrame, speed: number, dt: number, grid: NavGrid): Point {
  let mx = Number.isFinite(input.move_x) ? Math.max(-1, Math.min(1, input.move_x)) : 0;
  let my = Number.isFinite(input.move_y) ? Math.max(-1, Math.min(1, input.move_y)) : 0;
  const length = Math.hypot(mx, my);
  if (length > 1) { mx /= length; my /= length; }
  return grid.slide(position, mx * speed * dt, my * speed * dt);
}

/**
 * 本地玩家输入预测 + 服务端校正回滚：
 * 每发送一帧输入就本地积分一次；收到快照后回到服务端权威位置，丢弃已确认（seq <= ack）的输入，
 * 重放其余未确认输入。渲染位置再对校正误差做平滑，避免肉眼可见的跳变。
 */
export class Predictor {
  private pending: InputFrame[] = [];
  predicted: Point = { x: 0, y: 0 };
  /** 渲染用的平滑误差偏移，逐帧衰减到 0。 */
  private error: Point = { x: 0, y: 0 };
  lastCorrection = 0;

  constructor(private readonly grid: NavGrid, private readonly tickRate: number) {}

  reset(x: number, y: number): void {
    this.predicted = { x, y };
    this.pending = [];
    this.error = { x: 0, y: 0 };
  }

  push(input: InputFrame, speed: number): void {
    this.pending.push(input);
    if (this.pending.length > this.tickRate * 3) this.pending.shift();
    this.predicted = integrate(this.predicted, input, speed, 1 / this.tickRate, this.grid);
  }

  reconcile(authX: number, authY: number, ack: number, speed: number): void {
    const before = this.predicted;
    this.pending = this.pending.filter((input) => input.seq > ack);
    let p: Point = { x: authX, y: authY };
    for (const input of this.pending) p = integrate(p, input, speed, 1 / this.tickRate, this.grid);
    const dx = before.x - p.x, dy = before.y - p.y;
    this.lastCorrection = Math.hypot(dx, dy);
    if (this.lastCorrection > 200) {
      this.error = { x: 0, y: 0 }; // 大幅偏差（如位移技能、复活）直接对齐
    } else {
      this.error = { x: this.error.x + dx, y: this.error.y + dy };
    }
    this.predicted = p;
  }

  /** 渲染位置：预测位置 + 衰减中的校正误差。 */
  render(dtMs: number): Point {
    const decay = Math.exp(-dtMs / 90);
    this.error.x *= decay; this.error.y *= decay;
    return { x: this.predicted.x + this.error.x, y: this.predicted.y + this.error.y };
  }

  get pendingCount(): number { return this.pending.length; }
}
