// Binary game protocol over WebRTC DataChannels.
//
// Channel "u" (unordered, maxRetransmits 0): INPUT, PING, PONG, SNAPSHOT - disposable, newest wins.
// Channel "r" (reliable, ordered):            HELLO, WELCOME, KILL, HIT, END, STATS, REJECT - must arrive.
//
// Every message starts with a u8 type. Multi-byte values are little-endian.

import type { ByteReader, ByteWriter } from './bytes';
import { BTN_MASK, type InputCmd } from './input';
import { seqAdd } from './seq';

export const MSG = {
  INPUT: 1,
  PING: 2,
  PONG: 3,
  SNAPSHOT: 4,
  HELLO: 10,
  WELCOME: 11,
  KILL: 12,
  HIT: 13,
  END: 14,
  STATS: 15,
  REJECT: 16,
} as const;

export const REJECT_REASON = { VERSION: 1, NOT_MEMBER: 2, MATCH_OVER: 3 } as const;

// ------------------------------------------------------------------ INPUT (client -> host, unreliable)
//
// u8 type | u8 flags(bit0 hasAck) | [u16 ackSnapSeq] | u32 renderTick | u16 newestSeq | u8 count
// then `count` entries, newest first. Entry: u8 buttons (bit7 = same moveX/aim as the previous
// (newer) entry); when bit7 is clear: i8 moveX, u16 aim. A typical packet is 12-40 bytes.

export interface InputPacketHeader {
  ackSnap: number; // -1 = none
  renderTick: number;
  newestSeq: number;
  count: number;
}

export function writeInputPacket(
  w: ByteWriter,
  ackSnap: number,
  renderTick: number,
  newestSeq: number,
  count: number,
  getInput: (seq: number) => InputCmd,
): void {
  w.u8(MSG.INPUT);
  w.u8(ackSnap >= 0 ? 1 : 0);
  if (ackSnap >= 0) w.u16(ackSnap);
  w.u32(Math.max(0, Math.floor(renderTick)));
  w.u16(newestSeq);
  w.u8(count);
  let prev: InputCmd | null = null;
  for (let i = 0; i < count; i++) {
    const c = getInput(seqAdd(newestSeq, -i));
    const b = c.buttons & BTN_MASK;
    if (prev && prev.moveX === c.moveX && prev.aim === c.aim) {
      w.u8(b | 0x80);
    } else {
      w.u8(b);
      w.i8(c.moveX);
      w.u16(c.aim);
    }
    prev = c;
  }
}

/** Decodes into `out` (newest first). Returns false if the packet is malformed. */
export function readInputPacket(r: ByteReader, hdr: InputPacketHeader, out: InputCmd[]): boolean {
  const flags = r.u8();
  hdr.ackSnap = flags & 1 ? r.u16() : -1;
  hdr.renderTick = r.u32();
  hdr.newestSeq = r.u16();
  const count = r.u8();
  if (count === 0 || count > out.length) return false;
  hdr.count = count;
  for (let i = 0; i < count; i++) {
    const c = out[i];
    const b = r.u8();
    c.seq = seqAdd(hdr.newestSeq, -i);
    c.buttons = b & BTN_MASK;
    if (b & 0x80) {
      if (i === 0) return false;
      c.moveX = out[i - 1].moveX;
      c.aim = out[i - 1].aim;
    } else {
      c.moveX = r.i8();
      if (c.moveX < -127) c.moveX = -127;
      c.aim = r.u16();
    }
  }
  return true;
}

// ------------------------------------------------------------------ PING / PONG (unreliable)

export function writePing(w: ByteWriter, t: number): void {
  w.u8(MSG.PING).u32(t >>> 0);
}

export function writePong(w: ByteWriter, t: number, hostTick: number): void {
  w.u8(MSG.PONG).u32(t >>> 0).u32(hostTick >>> 0);
}

// ------------------------------------------------------------------ reliable messages

/**
 * HELLO: u8 version | u16 inputSeq. The client's current input sequence lets the
 * host resynchronise the input stream after a reconnect or a page reload.
 */
export function writeHello(w: ByteWriter, version: number, inputSeq: number): void {
  w.u8(MSG.HELLO).u8(version).u16(inputSeq & 0xffff);
}

export interface WelcomeMsg {
  version: number;
  yourId: number;
  mapId: number;
  hostTick: number;
  startTick: number;
  endTick: number;
  snapshotHz: number;
  matchId: number;
}

export function writeWelcome(w: ByteWriter, m: WelcomeMsg): void {
  w.u8(MSG.WELCOME).u8(m.version).u8(m.yourId).u8(m.mapId);
  w.u32(m.hostTick).u32(m.startTick).u32(m.endTick).u8(m.snapshotHz).u16(m.matchId & 0xffff);
}

export function readWelcome(r: ByteReader): WelcomeMsg {
  return {
    version: r.u8(),
    yourId: r.u8(),
    mapId: r.u8(),
    hostTick: r.u32(),
    startTick: r.u32(),
    endTick: r.u32(),
    snapshotHz: r.u8(),
    matchId: r.u16(),
  };
}

export const KILL_HEADSHOT = 1;

export function writeKill(w: ByteWriter, killer: number, victim: number, weapon: number, flags: number): void {
  w.u8(MSG.KILL).u8(killer).u8(victim).u8(weapon).u8(flags);
}

export const HIT_HEADSHOT = 1;
export const HIT_KILL = 2;

export function writeHit(w: ByteWriter, victim: number, damage: number, flags: number): void {
  w.u8(MSG.HIT).u8(victim).u8(Math.min(255, damage)).u8(flags);
}

export interface ResultRow {
  id: number;
  kills: number;
  deaths: number;
}

export function writeEnd(w: ByteWriter, matchId: number, rows: ResultRow[]): void {
  w.u8(MSG.END).u16(matchId & 0xffff).u8(rows.length);
  for (const row of rows) w.u8(row.id).u8(Math.min(255, row.kills)).u8(Math.min(255, row.deaths));
}

export function readEnd(r: ByteReader): { matchId: number; rows: ResultRow[] } {
  const matchId = r.u16();
  const n = r.u8();
  const rows: ResultRow[] = [];
  for (let i = 0; i < n; i++) rows.push({ id: r.u8(), kills: r.u8(), deaths: r.u8() });
  return { matchId, rows };
}

export interface ClientStats {
  rttMs: number;
  lossPermille: number;
  jitterMs: number;
  fps: number;
  corrections: number;
}

export function writeStats(w: ByteWriter, s: ClientStats): void {
  w.u8(MSG.STATS);
  w.u16(Math.min(65535, Math.round(s.rttMs)));
  w.u16(Math.min(1000, Math.round(s.lossPermille)));
  w.u16(Math.min(65535, Math.round(s.jitterMs)));
  w.u8(Math.min(255, Math.round(s.fps)));
  w.u16(Math.min(65535, s.corrections));
}

export function readStats(r: ByteReader): ClientStats {
  return { rttMs: r.u16(), lossPermille: r.u16(), jitterMs: r.u16(), fps: r.u8(), corrections: r.u16() };
}
