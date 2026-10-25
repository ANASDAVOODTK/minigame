// World snapshots: quantized player state indexed by player id, plus the
// delta codec used for host -> client SNAPSHOT packets.
//
// SNAPSHOT layout (unreliable channel):
//   u8 type | u16 seq | u8 flags(bit0 hasBase, bit1 hasAck) | [u16 baseSeq] | u32 tick | [u16 ackInputSeq]
//   u8 removedCount, removedIds...
//   u8 entityCount, entities: u8 id | u8 groupMask | fields of each group present
//   u8 eventCount, events (see writeShotEvent)
//
// Delta compression: only field groups that differ from the baseline snapshot the
// client last acknowledged are sent. A standing-still player costs 0 bytes.

import { SLOTS } from './config';
import type { ByteReader, ByteWriter } from './bytes';
import { MSG } from './protocol';
import { POS_SCALE, VEL_SCALE, type PlayerSim } from './physics';

// Field groups.
export const G_POS = 1; // u16 x, u16 y            (1/8 px)
export const G_VEL = 2; // i16 vx, i16 vy          (1/16 px/s)
export const G_AIM = 4; // u16 aim
export const G_STATE = 8; // u8 hp, u8 flags, u8 spawnCount, u8 weapon
export const G_SCORE = 16; // u8 kills, u8 deaths
export const G_OWN = 32; // u16 fuel, u8 ammo, u8 reload, u8 cooldown (recipient's own player only)
const G_ALL_PUBLIC = G_POS | G_VEL | G_AIM | G_STATE | G_SCORE;

// Player flags.
export const F_ALIVE = 1;
export const F_GROUND = 2;
export const F_JET = 4;
export const F_PROTECT = 8;
export const F_DISCONNECTED = 16;
export const F_RELOAD = 32;

export class WorldFrame {
  tick = 0;
  readonly present = new Uint8Array(SLOTS);
  readonly x = new Uint16Array(SLOTS);
  readonly y = new Uint16Array(SLOTS);
  readonly vx = new Int16Array(SLOTS);
  readonly vy = new Int16Array(SLOTS);
  readonly aim = new Uint16Array(SLOTS);
  readonly hp = new Uint8Array(SLOTS);
  readonly flags = new Uint8Array(SLOTS);
  readonly spawn = new Uint8Array(SLOTS);
  readonly weapon = new Uint8Array(SLOTS);
  readonly kills = new Uint8Array(SLOTS);
  readonly deaths = new Uint8Array(SLOTS);
  readonly fuel = new Uint16Array(SLOTS);
  readonly ammo = new Uint8Array(SLOTS);
  readonly reload = new Uint8Array(SLOTS);
  readonly cooldown = new Uint8Array(SLOTS);

  clear(): void {
    this.tick = 0;
    this.present.fill(0);
  }

  copyFrom(o: WorldFrame): void {
    this.tick = o.tick;
    this.present.set(o.present);
    this.x.set(o.x);
    this.y.set(o.y);
    this.vx.set(o.vx);
    this.vy.set(o.vy);
    this.aim.set(o.aim);
    this.hp.set(o.hp);
    this.flags.set(o.flags);
    this.spawn.set(o.spawn);
    this.weapon.set(o.weapon);
    this.kills.set(o.kills);
    this.deaths.set(o.deaths);
    this.fuel.set(o.fuel);
    this.ammo.set(o.ammo);
    this.reload.set(o.reload);
    this.cooldown.set(o.cooldown);
  }

  /** Stores a simulated player (already on the quantization grid). */
  setPlayer(id: number, p: PlayerSim, hp: number, flags: number, spawn: number, kills: number, deaths: number): void {
    this.present[id] = 1;
    this.x[id] = clampU16(Math.round(p.x * POS_SCALE));
    this.y[id] = clampU16(Math.round(p.y * POS_SCALE));
    this.vx[id] = clampI16(Math.round(p.vx * VEL_SCALE));
    this.vy[id] = clampI16(Math.round(p.vy * VEL_SCALE));
    this.aim[id] = p.aim;
    this.hp[id] = hp;
    this.flags[id] = flags;
    this.spawn[id] = spawn & 255;
    this.weapon[id] = p.weapon;
    this.kills[id] = Math.min(255, kills);
    this.deaths[id] = Math.min(255, deaths);
    this.fuel[id] = p.fuel;
    this.ammo[id] = p.ammo;
    this.reload[id] = Math.min(255, p.reload);
    this.cooldown[id] = Math.min(255, p.cooldown);
  }

  /** Writes the replicated state of player `id` into a PlayerSim (prediction reset). */
  toSim(id: number, out: PlayerSim): PlayerSim {
    out.x = this.x[id] / POS_SCALE;
    out.y = this.y[id] / POS_SCALE;
    out.vx = this.vx[id] / VEL_SCALE;
    out.vy = this.vy[id] / VEL_SCALE;
    out.aim = this.aim[id];
    out.onGround = (this.flags[id] & F_GROUND) !== 0;
    out.jetting = (this.flags[id] & F_JET) !== 0;
    out.weapon = this.weapon[id];
    out.fuel = this.fuel[id];
    out.ammo = this.ammo[id];
    out.reload = this.reload[id];
    out.cooldown = this.cooldown[id];
    return out;
  }
}

function clampU16(v: number): number {
  return v < 0 ? 0 : v > 65535 ? 65535 : v;
}
function clampI16(v: number): number {
  return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
}

function diffMask(a: WorldFrame, b: WorldFrame, id: number, own: boolean): number {
  let m = 0;
  if (a.x[id] !== b.x[id] || a.y[id] !== b.y[id]) m |= G_POS;
  if (a.vx[id] !== b.vx[id] || a.vy[id] !== b.vy[id]) m |= G_VEL;
  if (a.aim[id] !== b.aim[id]) m |= G_AIM;
  if (a.hp[id] !== b.hp[id] || a.flags[id] !== b.flags[id] || a.spawn[id] !== b.spawn[id] || a.weapon[id] !== b.weapon[id]) m |= G_STATE;
  if (a.kills[id] !== b.kills[id] || a.deaths[id] !== b.deaths[id]) m |= G_SCORE;
  if (own && (a.fuel[id] !== b.fuel[id] || a.ammo[id] !== b.ammo[id] || a.reload[id] !== b.reload[id] || a.cooldown[id] !== b.cooldown[id])) m |= G_OWN;
  return m;
}

export const SNAP_HAS_BASE = 1;
export const SNAP_HAS_ACK = 2;

/**
 * Writes header + entity section. The caller appends the event section
 * (`u8 count` + events) afterwards.
 */
export function writeSnapshot(
  w: ByteWriter,
  seq: number,
  base: WorldFrame | null,
  baseSeq: number,
  cur: WorldFrame,
  recipient: number,
  ackInput: number,
): void {
  w.u8(MSG.SNAPSHOT);
  w.u16(seq);
  w.u8((base ? SNAP_HAS_BASE : 0) | (ackInput >= 0 ? SNAP_HAS_ACK : 0));
  if (base) w.u16(baseSeq);
  w.u32(cur.tick);
  if (ackInput >= 0) w.u16(ackInput);

  const remAt = w.mark();
  let removed = 0;
  if (base) {
    for (let id = 1; id < SLOTS; id++) {
      if (base.present[id] && !cur.present[id]) {
        w.u8(id);
        removed++;
      }
    }
  }
  w.setU8(remAt, removed);

  const cntAt = w.mark();
  let count = 0;
  for (let id = 1; id < SLOTS; id++) {
    if (!cur.present[id]) continue;
    const own = id === recipient;
    const mask =
      base && base.present[id] ? diffMask(base, cur, id, own) : G_ALL_PUBLIC | (own ? G_OWN : 0);
    if (!mask) continue;
    w.u8(id);
    w.u8(mask);
    if (mask & G_POS) w.u16(cur.x[id]).u16(cur.y[id]);
    if (mask & G_VEL) w.i16(cur.vx[id]).i16(cur.vy[id]);
    if (mask & G_AIM) w.u16(cur.aim[id]);
    if (mask & G_STATE) w.u8(cur.hp[id]).u8(cur.flags[id]).u8(cur.spawn[id]).u8(cur.weapon[id]);
    if (mask & G_SCORE) w.u8(cur.kills[id]).u8(cur.deaths[id]);
    if (mask & G_OWN) w.u16(cur.fuel[id]).u8(cur.ammo[id]).u8(cur.reload[id]).u8(cur.cooldown[id]);
    count++;
  }
  w.setU8(cntAt, count);
}

export interface SnapshotHeader {
  seq: number;
  baseSeq: number; // -1 = full snapshot
  tick: number;
  ackInput: number; // -1 = host has not processed any input yet
}

/** Reads the header (type byte already consumed). */
export function readSnapshotHeader(r: ByteReader, out: SnapshotHeader): void {
  out.seq = r.u16();
  const flags = r.u8();
  out.baseSeq = flags & SNAP_HAS_BASE ? r.u16() : -1;
  out.tick = r.u32();
  out.ackInput = flags & SNAP_HAS_ACK ? r.u16() : -1;
}

/** Reconstructs the full frame from `base` (or nothing) plus the deltas. Throws on malformed data. */
export function readSnapshotBody(r: ByteReader, base: WorldFrame | null, tick: number, out: WorldFrame): void {
  if (base) out.copyFrom(base);
  else out.clear();
  out.tick = tick;
  const removed = r.u8();
  for (let i = 0; i < removed; i++) {
    const id = r.u8();
    if (id >= 1 && id < SLOTS) out.present[id] = 0;
  }
  const count = r.u8();
  for (let i = 0; i < count; i++) {
    const id = r.u8();
    if (id < 1 || id >= SLOTS) throw new RangeError('bad entity id');
    const mask = r.u8();
    out.present[id] = 1;
    if (mask & G_POS) {
      out.x[id] = r.u16();
      out.y[id] = r.u16();
    }
    if (mask & G_VEL) {
      out.vx[id] = r.i16();
      out.vy[id] = r.i16();
    }
    if (mask & G_AIM) out.aim[id] = r.u16();
    if (mask & G_STATE) {
      out.hp[id] = r.u8();
      out.flags[id] = r.u8();
      out.spawn[id] = r.u8();
      out.weapon[id] = r.u8();
    }
    if (mask & G_SCORE) {
      out.kills[id] = r.u8();
      out.deaths[id] = r.u8();
    }
    if (mask & G_OWN) {
      out.fuel[id] = r.u16();
      out.ammo[id] = r.u8();
      out.reload[id] = r.u8();
      out.cooldown[id] = r.u8();
    }
  }
}

// ------------------------------------------------------------------ shot events (cosmetic tracers)

export const EV_SHOT = 1;
export const SHOT_HIT = 1;
export const SHOT_HEADSHOT = 2;

export interface ShotEvent {
  shooter: number;
  weapon: number;
  ox: number;
  oy: number;
  ex: number;
  ey: number;
  flags: number;
}

export function writeShotEvent(w: ByteWriter, e: ShotEvent): void {
  w.u8(EV_SHOT).u8(e.shooter).u8(e.weapon);
  w.u16(clampU16(Math.round(e.ox))).u16(clampU16(Math.round(e.oy)));
  w.u16(clampU16(Math.round(e.ex))).u16(clampU16(Math.round(e.ey)));
  w.u8(e.flags);
}

/** Reads the event section; unknown event kinds abort the section (forward compatible). */
export function readEvents(r: ByteReader, onShot: (e: ShotEvent) => void, scratch: ShotEvent): void {
  if (r.remaining < 1) return;
  const n = r.u8();
  for (let i = 0; i < n; i++) {
    const kind = r.u8();
    if (kind !== EV_SHOT) return;
    scratch.shooter = r.u8();
    scratch.weapon = r.u8();
    scratch.ox = r.u16();
    scratch.oy = r.u16();
    scratch.ex = r.u16();
    scratch.ey = r.u16();
    scratch.flags = r.u8();
    onShot(scratch);
  }
}

