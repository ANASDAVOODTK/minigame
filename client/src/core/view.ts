// The interface the renderer/HUD use to read a running match, regardless of
// whether this browser is the authoritative host or a predicting client.

import type { InputState } from './input';
import type { GameMap } from './maps';
import type { ResultRow } from './protocol';

export type MatchPhase = 'connecting' | 'live' | 'ended';
export type Quality = 'good' | 'fair' | 'poor' | 'bad';

export interface RenderPlayer {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  aim: number;
  flags: number;
  hp: number;
  weapon: number;
  spawn: number;
  local: boolean;
}

export function makeRenderPlayer(): RenderPlayer {
  return { id: 0, x: 0, y: 0, vx: 0, vy: 0, aim: 0, flags: 0, hp: 0, weapon: 0, spawn: 0, local: false };
}

export interface HudInfo {
  alive: boolean;
  hp: number;
  ammo: number;
  magSize: number;
  /** 0 when not reloading, else progress 0..1. */
  reload: number;
  fuel: number; // 0..1
  weapon: number;
  kills: number;
  deaths: number;
  timeLeftSec: number;
  respawnInSec: number;
  protected: boolean;
  /** Seconds spent waiting for the host to welcome us; -1 once in the match. */
  connectingSec: number;
}

export function makeHudInfo(): HudInfo {
  return { alive: false, hp: 0, ammo: 0, magSize: 0, reload: 0, fuel: 0, weapon: 0, kills: 0, deaths: 0, timeLeftSec: 0, respawnInSec: 0, protected: false, connectingSec: -1 };
}

export interface NetInfo {
  role: 'host' | 'client';
  /** Round-trip time to the host (client) or worst peer (host). */
  rttMs: number;
  lossPct: number;
  jitterMs: number;
  quality: Quality;
  reconnecting: boolean;
  snapshotHz: number;
  upKbps: number;
  downKbps: number;
  corrections: number;
  interpDelayMs: number;
  peers: number;
}

export function makeNetInfo(): NetInfo {
  return { role: 'client', rttMs: 0, lossPct: 0, jitterMs: 0, quality: 'good', reconnecting: false, snapshotHz: 0, upKbps: 0, downKbps: 0, corrections: 0, interpDelayMs: 0, peers: 0 };
}

export interface ScoreRow {
  id: number;
  kills: number;
  deaths: number;
  pingMs: number;
  connected: boolean;
}

export function classifyQuality(rttMs: number, lossPct: number, jitterMs: number): Quality {
  if (rttMs < 100 && lossPct < 2 && jitterMs < 25) return 'good';
  if (rttMs < 200 && lossPct < 6 && jitterMs < 60) return 'fair';
  if (rttMs < 350 && lossPct < 15) return 'poor';
  return 'bad';
}

// ------------------------------------------------------------------ cosmetic effect queue

export const FX_TRACER = 1;
export const FX_KILL = 2;
export const FX_HIT_CONFIRM = 3;
export const FX_DAMAGED = 4;
export const FX_SPAWN = 5;

export interface FxEvent {
  kind: number;
  /** Shooter / killer / spawned player. */
  id: number;
  /** Victim. */
  other: number;
  weapon: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  flags: number;
  value: number;
  /** Shot predicted locally by this client (render instantly from the gun). */
  local: boolean;
}

/** Fixed-size ring of reusable event objects: no allocation per effect. */
export class FxQueue {
  private items: FxEvent[];
  private head = 0;
  private len = 0;

  constructor(capacity = 128) {
    this.items = [];
    for (let i = 0; i < capacity; i++) {
      this.items.push({ kind: 0, id: 0, other: 0, weapon: 0, x0: 0, y0: 0, x1: 0, y1: 0, flags: 0, value: 0, local: false });
    }
  }

  push(kind: number): FxEvent {
    const cap = this.items.length;
    if (this.len === cap) {
      this.head = (this.head + 1) % cap; // drop oldest
      this.len--;
    }
    const e = this.items[(this.head + this.len) % cap];
    this.len++;
    e.kind = kind;
    e.id = e.other = e.weapon = e.flags = e.value = 0;
    e.x0 = e.y0 = e.x1 = e.y1 = 0;
    e.local = false;
    return e;
  }

  drain(cb: (e: FxEvent) => void): void {
    const cap = this.items.length;
    while (this.len > 0) {
      const e = this.items[this.head];
      this.head = (this.head + 1) % cap;
      this.len--;
      cb(e);
    }
  }
}

export interface MatchView {
  readonly role: 'host' | 'client';
  readonly myId: number;
  readonly map: GameMap | null;
  readonly fx: FxQueue;
  readonly phase: MatchPhase;
  readonly results: ResultRow[] | null;
  /** Advances simulation/networking to `nowMs` (performance.now()). */
  update(nowMs: number, input: InputState): void;
  /** Fills `out` with the players to draw (local player first). Returns the count. */
  collectPlayers(out: RenderPlayer[]): number;
  hud(out: HudInfo): void;
  net(out: NetInfo): void;
  scores(out: ScoreRow[]): number;
}
