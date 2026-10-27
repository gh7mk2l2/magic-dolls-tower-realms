// 与 crates/shared/src/lib.rs 一一对应的协议类型（MessagePack，字段名作为 map key）。
import { decode, encode } from '@msgpack/msgpack';

export const PROTOCOL_VERSION = 2;
export const TICK_RATE = 20;

export const FLAGS = { STUNNED: 1, SLOWED: 2, INVULNERABLE: 4, CONTROL_IMMUNE: 8, AI: 16 } as const;

export type Team = 'Red' | 'Blue';
export type EntityKind = 'Hero' | 'Tower' | 'Base' | 'Minion' | 'SuperMinion' | 'PoisonZone';
export type HeroKind = 'Arcanist' | 'Ranger' | 'Guardian' | 'Assassin' | 'Priestess' | 'Brawler';
export type Phase = 'Battle' | 'SuddenDeath' | 'Ended';
export type EventKind =
  | 'Shot' | 'Hit' | 'Skill' | 'Poison' | 'TowerDestroyed' | 'SuddenDeath'
  | 'Announcement' | 'Death' | 'Respawn' | 'Victory' | 'WaveSpawned' | 'HelpRequest' | 'HelpAccepted';

export interface Vec2 { x: number; y: number }

export interface InputFrame {
  seq: number; move_x: number; move_y: number; aim_x: number; aim_y: number; attack: boolean; skills: number;
  /** 本帧发出求救 */ help?: boolean;
  /** 接受求救：求救者实体 id */ accept_help?: number;
}

export interface JoinRequest {
  version: number; room: string; name: string; team: Team | null; hero: HeroKind; token: string | null;
  /** 自定义战队名（该队首位命名者生效） */ team_name?: string | null;
}

export type ClientMessage = { Join: JoinRequest } | { Input: InputFrame } | 'Resync' | 'Leave' | { Ping: number };

export interface EntitySnapshot {
  id: number; kind: EntityKind; team: Team; x: number; y: number; vx: number; vy: number;
  hp: number; max_hp: number; radius: number; hero: HeroKind | null; owner: number | null; name: string | null;
  cooldowns: [number, number, number]; respawn: number; facing: number; attacking: boolean;
  flags: number; speed_mul: number; level: number;
}

export interface GameEvent {
  id: number; kind: EventKind; x: number; y: number; tx: number; ty: number; value: number;
  source: number; target: number; text: string; team: Team | null;
}

export interface Snapshot {
  tick: number; server_time: number; remaining: number; phase: Phase; winner: Team | null; full: boolean;
  acks: [number, number][]; entities: EntitySnapshot[]; removed: number[]; events: GameEvent[];
  red_score: number; blue_score: number; wave: number; team_names?: string[];
}

export interface Rect { x: number; y: number; w: number; h: number }
export interface SkillInfo { key: string; name: string; effect: string; cooldown_ticks: number; range: number; radius: number }
export interface HeroInfo { kind: HeroKind; name: string; hp: number; speed: number; attack_range: number; skills: SkillInfo[] }
export interface MapInfo {
  width: number; height: number; grid: number; blocked: Uint8Array | number[]; obstacles: Rect[];
  poison_radius: number; match_seconds: number; sudden_death_seconds: number; wave_seconds: number; heroes: HeroInfo[];
}
export interface Welcome {
  player_id: number; entity_id: number; team: Team; room: string; token: string; tick_rate: number; map: MapInfo;
}
export interface PlayerResult { name: string; team: Team; hero: HeroKind; human: boolean; kills: number; deaths: number; damage: number }
export interface MatchSummary {
  winner: Team | null; ticks: number; red_score: number; blue_score: number;
  towers_destroyed_red: number; towers_destroyed_blue: number; players: PlayerResult[];
}

export type ServerMessage =
  | { Welcome: Welcome } | { Snapshot: Snapshot } | { Pong: number } | { Error: string } | { MatchEnd: MatchSummary };

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Uint8Array) {
    throw new Error('服务端消息必须是 Map');
  }
  return value as Record<string, unknown>;
};

export function encodeClientMessage(message: ClientMessage): Uint8Array {
  return encode(message, { ignoreUndefined: true });
}

export function decodeServerMessage(bytes: Uint8Array): ServerMessage {
  const raw = asRecord(decode(bytes));
  const keys = Object.keys(raw);
  if (keys.length !== 1) throw new Error('服务端枚举必须为单键 Map');
  const tag = keys[0];
  const value = raw[tag];
  switch (tag) {
    case 'Pong': return { Pong: Number(value) };
    case 'Error': return { Error: String(value) };
    case 'Welcome': {
      const welcome = asRecord(value) as unknown as Welcome;
      if (!welcome.map || typeof welcome.player_id !== 'number') throw new Error('Welcome 字段无效');
      return { Welcome: welcome };
    }
    case 'Snapshot': {
      const snapshot = asRecord(value) as unknown as Snapshot;
      if (!Array.isArray(snapshot.entities) || typeof snapshot.tick !== 'number') throw new Error('Snapshot 字段无效');
      return { Snapshot: snapshot };
    }
    case 'MatchEnd': return { MatchEnd: asRecord(value) as unknown as MatchSummary };
    default: throw new Error(`未知服务端消息: ${tag}`);
  }
}
