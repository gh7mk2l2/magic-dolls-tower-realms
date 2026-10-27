// 跨语言集成测试：在 Node 中加载由 Rust 编译的 sim.wasm，验证
// 1) TS 端 MessagePack 编解码与 Rust 协议一致；2) 增量快照可还原；3) 客户端预测与服务端权威移动一致。
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SnapshotStore } from '../src/interpolation';
import { NavGrid, Predictor } from '../src/prediction';
import { decodeServerMessage, encodeClientMessage, PROTOCOL_VERSION, type ClientMessage, type ServerMessage, type Welcome } from '../src/protocol';

const wasmPath = new URL('../public/sim.wasm', import.meta.url);
const hasWasm = existsSync(wasmPath);

async function boot() {
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
  const e = instance.exports as unknown as {
    memory: WebAssembly.Memory; mdtr_alloc(n: number): number; mdtr_free(p: number, n: number): void;
    mdtr_out_ptr(): number; mdtr_out_len(): number; mdtr_send(p: number, n: number): void; mdtr_step(): number;
  };
  const out = () => new Uint8Array(e.memory.buffer, e.mdtr_out_ptr(), e.mdtr_out_len()).slice();
  const send = (m: ClientMessage): ServerMessage | null => {
    const bytes = encodeClientMessage(m);
    const ptr = e.mdtr_alloc(bytes.length);
    new Uint8Array(e.memory.buffer, ptr, bytes.length).set(bytes);
    e.mdtr_send(ptr, bytes.length);
    e.mdtr_free(ptr, bytes.length);
    const o = out();
    return o.length ? decodeServerMessage(o) : null;
  };
  const step = (): ServerMessage => { const kind = e.mdtr_step(); expect(kind).toBe(1); return decodeServerMessage(out()); };
  return { send, step };
}

describe.skipIf(!hasWasm)('Rust 模拟（WASM）', () => {
  it('协议、增量快照与移动预测一致', async () => {
    const sim = await boot();
    const reply = sim.send({ Join: { version: PROTOCOL_VERSION, room: 't', name: '测试', team: 'Red', hero: 'Ranger', token: null } });
    expect(reply && 'Welcome' in reply).toBe(true);
    const welcome = (reply as { Welcome: Welcome }).Welcome;
    expect(welcome.map.grid).toBe(64);
    expect(welcome.map.heroes).toHaveLength(6);

    const store = new SnapshotStore();
    const grid = NavGrid.fromMap(welcome.map);
    const predictor = new Predictor(grid, 20);
    const speed = welcome.map.heroes.find((h) => h.kind === 'Ranger')!.speed;
    let first = sim.step();
    expect('Snapshot' in first && first.Snapshot.full).toBe(true);
    store.apply((first as { Snapshot: never }).Snapshot);
    const me0 = store.entities.get(welcome.entity_id)!;
    predictor.reset(me0.x, me0.y);

    for (let seq = 1; seq <= 60; seq++) {
      const frame = { seq, move_x: seq < 30 ? 1 : 0.6, move_y: seq < 30 ? 0 : -0.8, aim_x: 0, aim_y: 0, attack: false, skills: 0 };
      sim.send({ Input: frame });
      predictor.push(frame, speed);
      first = sim.step();
      const snap = (first as { Snapshot: Parameters<SnapshotStore['apply']>[0] }).Snapshot;
      expect(store.apply(snap).accepted).toBe(true);
    }
    const me = store.entities.get(welcome.entity_id)!;
    const ack = store.latest!.acks.find(([p]) => p === welcome.player_id)![1];
    expect(ack).toBe(60);
    // 预测与权威结果误差应在量化精度内（服务端坐标保留 1 位小数）。
    expect(Math.abs(predictor.predicted.x - me.x)).toBeLessThan(0.5);
    expect(Math.abs(predictor.predicted.y - me.y)).toBeLessThan(0.5);
    predictor.reconcile(me.x, me.y, ack, speed);
    expect(predictor.lastCorrection).toBeLessThan(0.5);
    // 双方各一座基地、两座塔、两个毒区。
    const kinds = [...store.entities.values()].map((e) => `${e.team}-${e.kind}`);
    for (const team of ['Red', 'Blue']) {
      expect(kinds.filter((k) => k === `${team}-Tower`)).toHaveLength(2);
      expect(kinds.filter((k) => k === `${team}-PoisonZone`)).toHaveLength(2);
      expect(kinds.filter((k) => k === `${team}-Base`)).toHaveLength(1);
    }
  });
});
