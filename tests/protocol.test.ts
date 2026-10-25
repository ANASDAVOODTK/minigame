import { describe, expect, it } from 'vitest';
import { ByteReader, ByteWriter } from '../client/src/core/bytes';
import { makeInput, type InputCmd } from '../client/src/core/input';
import { makePlayerSim } from '../client/src/core/physics';
import { MSG, readInputPacket, readWelcome, writeInputPacket, writeWelcome, type InputPacketHeader } from '../client/src/core/protocol';
import { seqDiff } from '../client/src/core/seq';
import {
  F_ALIVE,
  WorldFrame,
  readEvents,
  readSnapshotBody,
  readSnapshotHeader,
  writeShotEvent,
  writeSnapshot,
  type ShotEvent,
  type SnapshotHeader,
} from '../client/src/core/snapshot';

describe('sequence numbers', () => {
  it('wrap around correctly', () => {
    expect(seqDiff(1, 65535)).toBe(2);
    expect(seqDiff(65535, 1)).toBe(-2);
    expect(seqDiff(100, 100)).toBe(0);
  });
});

describe('INPUT packets', () => {
  it('round-trip with run-length compression of repeated axes', () => {
    const ring: InputCmd[] = [];
    for (let i = 0; i < 20; i++) {
      const c = makeInput();
      c.seq = (65530 + i) & 0xffff;
      c.buttons = i % 3;
      c.moveX = i < 10 ? 127 : -64;
      c.aim = i < 15 ? 1000 : 2000 + i;
      ring.push(c);
    }
    const get = (s: number) => ring.find((c) => c.seq === s)!;
    const w = new ByteWriter();
    const newest = ring[19].seq;
    writeInputPacket(w, 1234, 98765, newest, 16, get);
    // 11-byte header + 16 full entries would be 75 bytes; repeated axes collapse to 1 byte each.
    expect(w.pos).toBe(48);

    const r = new ByteReader(w.bytes().slice());
    expect(r.u8()).toBe(MSG.INPUT);
    const hdr: InputPacketHeader = { ackSnap: 0, renderTick: 0, newestSeq: 0, count: 0 };
    const out = Array.from({ length: 16 }, makeInput);
    expect(readInputPacket(r, hdr, out)).toBe(true);
    expect(hdr).toEqual({ ackSnap: 1234, renderTick: 98765, newestSeq: newest, count: 16 });
    for (let i = 0; i < 16; i++) expect(out[i]).toEqual(ring[19 - i]);
  });

  it('rejects malformed packets', () => {
    const r = new ByteReader(new Uint8Array([0, 0, 0, 0, 0, 0, 5, 0, 0x80]));
    const hdr: InputPacketHeader = { ackSnap: 0, renderTick: 0, newestSeq: 0, count: 0 };
    expect(readInputPacket(r, hdr, Array.from({ length: 16 }, makeInput))).toBe(false);
    expect(() => readInputPacket(new ByteReader(new Uint8Array([1])), hdr, [])).toThrow();
  });
});

function frameWith(tick: number, players: [number, number, number][]): WorldFrame {
  const f = new WorldFrame();
  f.tick = tick;
  for (const [id, x, y] of players) {
    const s = makePlayerSim();
    s.x = x;
    s.y = y;
    s.aim = 1234;
    f.setPlayer(id, s, 100, F_ALIVE, 1, 2, 3);
  }
  return f;
}

function decode(bytes: Uint8Array, base: WorldFrame | null): { hdr: SnapshotHeader; f: WorldFrame; shots: ShotEvent[] } {
  const r = new ByteReader(bytes.slice());
  expect(r.u8()).toBe(MSG.SNAPSHOT);
  const hdr: SnapshotHeader = { seq: 0, baseSeq: 0, tick: 0, ackInput: 0 };
  readSnapshotHeader(r, hdr);
  const f = new WorldFrame();
  readSnapshotBody(r, base, hdr.tick, f);
  const shots: ShotEvent[] = [];
  readEvents(r, (e) => shots.push({ ...e }), { shooter: 0, weapon: 0, ox: 0, oy: 0, ex: 0, ey: 0, flags: 0 });
  return { hdr, f, shots };
}

describe('SNAPSHOT delta compression', () => {
  it('full snapshot round-trips', () => {
    const cur = frameWith(500, [
      [1, 100.5, 200.25],
      [3, 900.125, 40],
    ]);
    const w = new ByteWriter();
    writeSnapshot(w, 7, null, -1, cur, 3, 42);
    w.u8(1);
    writeShotEvent(w, { shooter: 1, weapon: 0, ox: 10, oy: 20, ex: 300, ey: 400, flags: 1 });
    const { hdr, f, shots } = decode(w.bytes(), null);
    expect(hdr).toEqual({ seq: 7, baseSeq: -1, tick: 500, ackInput: 42 });
    expect(Array.from(f.present)).toEqual(Array.from(cur.present));
    expect(Array.from(f.x)).toEqual(Array.from(cur.x));
    expect(Array.from(f.y)).toEqual(Array.from(cur.y));
    expect(f.kills[1]).toBe(2);
    expect(f.fuel[3]).toBe(cur.fuel[3]); // recipient's own fields
    expect(shots).toEqual([{ shooter: 1, weapon: 0, ox: 10, oy: 20, ex: 300, ey: 400, flags: 1 }]);
  });

  it('delta against a baseline only sends what changed, including removals', () => {
    const base = frameWith(500, [
      [1, 100, 200],
      [2, 300, 200],
      [3, 500, 200],
    ]);
    const cur = new WorldFrame();
    cur.copyFrom(base);
    cur.tick = 503;
    cur.x[2] = 3000; // player 2 moved
    cur.present[3] = 0; // player 3 left

    const full = new ByteWriter();
    writeSnapshot(full, 9, null, -1, cur, 1, -1);
    const delta = new ByteWriter();
    writeSnapshot(delta, 9, base, 8, cur, 1, -1);
    delta.u8(0);
    expect(delta.pos).toBeLessThan(full.pos / 2);

    const { hdr, f } = decode(delta.bytes(), base);
    expect(hdr.baseSeq).toBe(8);
    expect(f.present[3]).toBe(0);
    expect(f.x[2]).toBe(3000);
    expect(f.x[1]).toBe(base.x[1]);
    expect(f.tick).toBe(503);
  });

  it('an idle world costs only the header', () => {
    const base = frameWith(500, [
      [1, 100, 200],
      [2, 300, 200],
    ]);
    const cur = new WorldFrame();
    cur.copyFrom(base);
    cur.tick = 520;
    const w = new ByteWriter();
    writeSnapshot(w, 2, base, 1, cur, 1, 10);
    expect(w.pos).toBeLessThanOrEqual(15);
  });
});

describe('WELCOME', () => {
  it('round-trips', () => {
    const m = { version: 1, yourId: 3, mapId: 2, hostTick: 123456, startTick: 0, endTick: 18000, snapshotHz: 20, matchId: 4 };
    const w = new ByteWriter();
    writeWelcome(w, m);
    const r = new ByteReader(w.bytes().slice());
    expect(r.u8()).toBe(MSG.WELCOME);
    expect(readWelcome(r)).toEqual(m);
  });
});
