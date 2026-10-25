import { describe, expect, it } from 'vitest';
import { TIMING } from '@minimi/shared';
import { Room, newRoom } from '../worker/src/roomState';

const settings = { maxPlayers: 4, mapId: 0, durationSec: 300 };

function roomWith(n: number, now = 1000) {
  const room = new Room(newRoom('ABCDE', settings, now));
  const members = [];
  for (let i = 0; i < n; i++) {
    const r = room.join(`P${i}`, i, undefined, now);
    if (!r.ok) throw new Error('join failed');
    room.connect(r.member.id, now);
    members.push(r.member);
  }
  return { room, members };
}

describe('room membership', () => {
  it('first member owns and hosts the room; ids are unique and small', () => {
    const { room, members } = roomWith(3);
    expect(room.d.ownerId).toBe(1);
    expect(room.d.hostId).toBe(1);
    expect(members.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(new Set(members.map((m) => m.token)).size).toBe(3);
  });

  it('enforces max players and reuses freed ids', () => {
    const { room, members } = roomWith(4);
    const r = room.join('late', 0, undefined, 2000);
    expect(r.ok).toBe(false);
    room.leave(members[1].id, 2000);
    const again = room.join('late', 0, undefined, 2000);
    expect(again.ok && again.member.id).toBe(2);
  });

  it('dedupes names and colors, sanitizes names', () => {
    const room = new Room(newRoom('ABCDE', settings, 0));
    const a = room.join('Ace', 2, undefined, 0);
    const b = room.join('ace', 2, undefined, 0);
    const c = room.join('<b>', 2, undefined, 0);
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(b.member.name).toBe('ace 2');
    expect(b.member.color).not.toBe(a.member.color);
    expect(c.member.name).toBe('b');
  });

  it('rejoin with a valid token returns the same player; expired tokens do not', () => {
    const { room, members } = roomWith(2);
    room.disconnect(2, 5000);
    const r = room.join('whoever', 0, members[1].token, 6000);
    expect(r.ok && r.rejoined && r.member.id).toBe(2);
    room.disconnect(2, 7000);
    expect(room.byToken(members[1].token, 7000 + TIMING.reconnectTokenTtlMs + 1)).toBeUndefined();
  });
});

describe('match lifecycle', () => {
  it('only the owner can start, needs 2 players, all ready', () => {
    const { room } = roomWith(3);
    expect(room.start(2)).toBe('not_owner');
    expect(room.start(1)).toBe('not_all_ready');
    room.setReady(2, true);
    room.setReady(3, true);
    expect(room.start(1)).toBeNull();
    expect(room.d.phase).toBe('playing');
    expect(room.d.matchId).toBe(1);
    expect(room.end(2, 1)).toBe(false); // not the host
    expect(room.end(1, 1)).toBe(true);
    expect(room.d.phase).toBe('lobby');
    expect(room.info().members.every((m) => !m.ready)).toBe(true);
  });

  it('host disconnect during a match: grace period, then match ends and a new host is chosen', () => {
    const { room } = roomWith(3, 0);
    room.setReady(2, true);
    room.setReady(3, true);
    room.start(1);
    room.disconnect(1, 10_000);
    expect(room.tick(10_000 + TIMING.hostGraceMs - 1).changed).toBe(false);
    const res = room.tick(10_000 + TIMING.hostGraceMs + 1);
    expect(res.notice).toBe('host_left');
    expect(room.d.phase).toBe('lobby');
    expect(room.d.hostId).toBe(2);
    expect(room.d.ownerId).toBe(2);
  });

  it('a player confirming the host is unreachable shortens the grace period (only while the host is offline)', () => {
    const { room } = roomWith(3, 0);
    room.setReady(2, true);
    room.setReady(3, true);
    room.start(1);
    expect(room.reportHostLost(2, 1000)).toBe(false); // host still connected: ignored
    room.disconnect(1, 10_000);
    expect(room.reportHostLost(1, 10_500)).toBe(false); // the host itself cannot report
    expect(room.reportHostLost(2, 10_500)).toBe(true);
    expect(room.tick(10_500 + TIMING.hostConfirmedLostMs - 10).notice).toBeUndefined();
    expect(room.tick(10_500 + TIMING.hostConfirmedLostMs + 10).notice).toBe('host_left');
    expect(room.d.hostId).toBe(2);
  });

  it('host reconnecting within the grace period keeps the match', () => {
    const { room } = roomWith(2, 0);
    room.setReady(2, true);
    room.start(1);
    room.disconnect(1, 1000);
    room.connect(1, 3000);
    room.tick(1000 + TIMING.hostGraceMs + 1);
    expect(room.d.phase).toBe('playing');
    expect(room.d.hostId).toBe(1);
  });

  it('removes long-disconnected lobby members and destroys empty rooms', () => {
    const { room } = roomWith(2, 0);
    room.disconnect(2, 1000);
    room.tick(1000 + TIMING.lobbyDisconnectRemoveMs + 1);
    expect(room.d.members.map((m) => m.id)).toEqual([1]);
    room.leave(1, 2000);
    expect(room.tick(3000).destroy).toBe(true);
  });

  it('only the owner can change settings, not below the current player count', () => {
    const { room } = roomWith(3);
    expect(room.updateSettings(2, { mapId: 2 })).toBe('not_owner');
    expect(room.updateSettings(1, { maxPlayers: 2 })).toBe('too_many_players');
    expect(room.updateSettings(1, { mapId: 2, maxPlayers: 6 })).toBeNull();
    expect(room.d.settings).toEqual({ maxPlayers: 6, mapId: 2, durationSec: 300 });
  });
});
