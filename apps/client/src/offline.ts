/**
 * 单机演练：加载由 crates/sim-wasm 编译的 sim.wasm，在浏览器内运行与服务端完全相同的 Rust 规则。
 * 收发的仍是 MessagePack 编码的 ClientMessage / ServerMessage，因此上层代码与联网模式完全一致。
 */
import { decodeServerMessage, encodeClientMessage, type ClientMessage, type ServerMessage } from './protocol';

interface SimExports {
  memory: WebAssembly.Memory;
  mdtr_alloc(len: number): number;
  mdtr_free(ptr: number, len: number): void;
  mdtr_out_ptr(): number;
  mdtr_out_len(): number;
  mdtr_send(ptr: number, len: number): void;
  mdtr_step(): number;
  /** 可选：设置下一局随机种子（旧版 sim.wasm 没有该导出）。 */
  mdtr_seed?(lo: number, hi: number): void;
}

let modulePromise: Promise<WebAssembly.Module> | null = null;

function loadModule(): Promise<WebAssembly.Module> {
  if (!modulePromise) {
    modulePromise = fetch(`${import.meta.env.BASE_URL}sim.wasm`).then(async (response) => {
      if (!response.ok) throw new Error('未找到 sim.wasm，请先运行 npm run build:wasm');
      return WebAssembly.compile(await response.arrayBuffer());
    });
  }
  return modulePromise;
}

export class LocalSimulation {
  onMessage: (message: ServerMessage) => void = () => {};
  private exports: SimExports | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: ClientMessage[] = [];
  private nextTickAt = 0;

  async start(): Promise<void> {
    const module = await loadModule();
    const instance = await WebAssembly.instantiate(module, {});
    this.exports = instance.exports as unknown as SimExports;
    // 每局不同的 AI 阵容
    this.exports.mdtr_seed?.((Math.random() * 0x100000000) >>> 0, (Date.now() & 0xffffffff) >>> 0);
    for (const message of this.pending.splice(0)) this.send(message);
    this.nextTickAt = performance.now();
    // 固定 20Hz 推进；页面卡顿时最多追帧 5 次，保持时间一致。
    this.timer = setInterval(() => {
      const now = performance.now();
      let steps = 0;
      while (now >= this.nextTickAt && steps < 5) { this.step(); this.nextTickAt += 50; steps++; }
      if (steps === 5) this.nextTickAt = now + 50;
    }, 10);
  }

  private output(): Uint8Array {
    const e = this.exports!;
    const len = e.mdtr_out_len();
    if (len === 0) return new Uint8Array();
    return new Uint8Array(e.memory.buffer, e.mdtr_out_ptr(), len).slice();
  }

  send(message: ClientMessage): void {
    const e = this.exports;
    if (!e) { this.pending.push(message); return; }
    const bytes = encodeClientMessage(message);
    const ptr = e.mdtr_alloc(bytes.length);
    new Uint8Array(e.memory.buffer, ptr, bytes.length).set(bytes);
    e.mdtr_send(ptr, bytes.length);
    e.mdtr_free(ptr, bytes.length);
    const out = this.output();
    if (out.length) this.onMessage(decodeServerMessage(out));
  }

  private step(): void {
    const e = this.exports;
    if (!e) return;
    const kind = e.mdtr_step();
    if (kind === 0) return;
    const out = this.output();
    if (kind === 1) { this.onMessage(decodeServerMessage(out)); return; }
    // 长度前缀拼接的两条消息：快照 + 结算。
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    let offset = 0;
    while (offset + 4 <= out.length) {
      const len = view.getUint32(offset, true); offset += 4;
      this.onMessage(decodeServerMessage(out.subarray(offset, offset + len)));
      offset += len;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.exports) this.send('Leave');
    this.exports = null;
  }
}
