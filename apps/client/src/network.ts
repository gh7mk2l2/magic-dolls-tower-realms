import { LocalSimulation } from './offline';
import {
  decodeServerMessage, encodeClientMessage, PROTOCOL_VERSION,
  type ClientMessage, type InputFrame, type JoinRequest, type MatchSummary, type Snapshot, type Welcome,
} from './protocol';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'closed';

const TOKEN_KEY = 'mdtr-session';

interface SavedSession { room: string; token: string; savedAt: number }

/** 统一的连接层：联网模式走 WebSocket（指数退避自动重连 + token 恢复），单机模式走 WASM。 */
export class GameConnection {
  onWelcome: (welcome: Welcome) => void = () => {};
  onSnapshot: (snapshot: Snapshot) => void = () => {};
  onMatchEnd: (summary: MatchSummary) => void = () => {};
  onStatus: (status: ConnectionStatus, detail?: string) => void = () => {};
  onError: (message: string, fatal: boolean) => void = () => {};
  onPong: (latency: number) => void = () => {};
  private socket: WebSocket | null = null;
  private local: LocalSimulation | null = null;
  private join: JoinRequest | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private manuallyClosed = false;
  private welcomed = false;
  welcome: Welcome | null = null;
  isOffline = false;

  start(request: Omit<JoinRequest, 'version' | 'token'>, offline: boolean): void {
    this.close();
    this.manuallyClosed = false;
    this.welcomed = false;
    this.isOffline = offline;
    const saved = GameConnection.savedSession();
    const token = saved && saved.room === request.room ? saved.token : null;
    this.join = { ...request, version: PROTOCOL_VERSION, token: offline ? null : token };
    if (offline) {
      const local = new LocalSimulation();
      this.local = local;
      local.onMessage = (message) => this.dispatch(message);
      this.onStatus('offline', '本地 WASM 模拟');
      local.start().catch((error: unknown) => this.onError(error instanceof Error ? error.message : String(error), true));
      local.send({ Join: this.join });
      return;
    }
    this.openSocket();
  }

  static savedSession(): SavedSession | null {
    try {
      const raw = localStorage.getItem(TOKEN_KEY);
      if (!raw) return null;
      const saved = JSON.parse(raw) as SavedSession;
      return Date.now() - saved.savedAt < 30_000 ? saved : null;
    } catch { return null; }
  }

  private saveSession(): void {
    if (!this.welcome || this.isOffline) return;
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ room: this.welcome.room, token: this.welcome.token, savedAt: Date.now() }));
  }

  private dispatch(message: ReturnType<typeof decodeServerMessage>): void {
    if ('Welcome' in message) {
      this.welcome = message.Welcome;
      this.welcomed = true;
      this.reconnectAttempt = 0;
      if (this.join) this.join.token = message.Welcome.token;
      this.saveSession();
      this.onWelcome(message.Welcome);
    } else if ('Snapshot' in message) {
      this.onSnapshot(message.Snapshot);
    } else if ('MatchEnd' in message) {
      localStorage.removeItem(TOKEN_KEY);
      this.onMatchEnd(message.MatchEnd);
    } else if ('Pong' in message) {
      this.onPong(Math.max(0, Math.round(performance.now() - message.Pong)));
    } else if ('Error' in message) {
      // 加入前的错误（房间满、版本不符）是致命的，不再重连。
      const fatal = !this.welcomed;
      if (fatal) this.manuallyClosed = true;
      this.onError(message.Error, fatal);
    }
  }

  private badFrames = 0;

  private openSocket(): void {
    if (!this.join) return;
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/ws`);
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    this.onStatus(this.reconnectAttempt ? 'reconnecting' : 'connecting', this.reconnectAttempt ? `第 ${this.reconnectAttempt} 次重连` : '正在连接');
    socket.onopen = () => {
      if (socket !== this.socket || !this.join) return;
      this.send({ Join: this.join });
      this.onStatus('connected');
      this.clearHeartbeat();
      this.heartbeat = setInterval(() => {
        this.send({ Ping: Math.floor(performance.now()) });
        this.saveSession();
      }, 2000);
    };
    socket.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (socket !== this.socket) return;
      try {
        this.dispatch(decodeServerMessage(new Uint8Array(event.data)));
        this.badFrames = 0;
      } catch (error) {
        // 单帧解析失败只记录并重同步；连续失败才提示玩家。
        console.warn('[mdtr] 协议解析失败', error, new Uint8Array(event.data).slice(0, 32));
        this.badFrames++;
        if (this.badFrames >= 3) { this.onError(`协议解析失败：${error instanceof Error ? error.message : String(error)}`, false); this.badFrames = 0; }
        this.requestResync();
        return;
      }
    };
    socket.onclose = () => {
      if (socket !== this.socket) return;
      this.clearHeartbeat();
      if (!this.manuallyClosed) this.scheduleReconnect();
      else this.onStatus('closed');
    };
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt++;
    const delay = Math.min(5000, 400 * 2 ** Math.min(4, this.reconnectAttempt - 1));
    this.onStatus('reconnecting', `${(delay / 1000).toFixed(1)} 秒后重连`);
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
  }

  private send(message: ClientMessage): void {
    if (this.local) { this.local.send(message); return; }
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encodeClientMessage(message));
  }

  sendInput(input: InputFrame): void { this.send({ Input: input }); }
  requestResync(): void { this.send('Resync'); }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** leave=true 表示主动离开（服务端立即释放英雄）；false 只是断开。 */
  close(leave = false): void {
    if (leave) { this.send('Leave'); localStorage.removeItem(TOKEN_KEY); }
    this.manuallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearHeartbeat();
    this.local?.stop(); this.local = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) { socket.onclose = null; socket.close(); }
    this.welcome = null;
  }
}
