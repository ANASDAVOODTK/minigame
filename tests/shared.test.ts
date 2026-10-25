import { describe, expect, it } from 'vitest';
import { normalizeRoomCode, parseClientMessage, sanitizeNickname, validateSettings } from '@minimi/shared';

describe('sanitizeNickname', () => {
  it('trims, collapses whitespace and limits length by code points', () => {
    expect(sanitizeNickname('  Ace   Pilot  ')).toBe('Ace Pilot');
    expect(sanitizeNickname('x'.repeat(40))).toHaveLength(16);
    expect(Array.from(sanitizeNickname('😀'.repeat(20)))).toHaveLength(16);
  });
  it('removes markup characters, control and invisible/bidi characters', () => {
    expect(sanitizeNickname('<b>Bob</b>')).toBe('bBob/b');
    expect(sanitizeNickname('a"b' + "'" + 'c&d')).toBe('abcd');
    expect(sanitizeNickname('a' + String.fromCharCode(0) + 'b' + String.fromCharCode(0x202e) + 'c' + String.fromCharCode(0x200b) + 'd')).toBe('abcd');
    expect(sanitizeNickname(42)).toBe('');
  });
});

describe('room codes and settings', () => {
  it('normalizes room codes', () => {
    expect(normalizeRoomCode(' abcde ')).toBe('ABCDE');
    expect(normalizeRoomCode('ABCD0')).toBeNull(); // 0 is not in the alphabet
    expect(normalizeRoomCode('ABCDEF')).toBeNull();
  });
  it('validates settings strictly', () => {
    expect(validateSettings({ maxPlayers: 4, mapId: 1, durationSec: 300 })).toEqual({ maxPlayers: 4, mapId: 1, durationSec: 300 });
    expect(validateSettings({ maxPlayers: 5, mapId: 1, durationSec: 300 })).toBeNull();
    expect(validateSettings({ maxPlayers: 4, mapId: 9, durationSec: 300 })).toBeNull();
    expect(validateSettings({ maxPlayers: 4, mapId: 1, durationSec: 1 })).toBeNull();
  });
});

describe('parseClientMessage', () => {
  it('accepts valid signaling messages', () => {
    expect(parseClientMessage('{"t":"ready","ready":true}')).toEqual({ t: 'ready', ready: true });
    const offer = { t: 'signal', to: 1, data: { conn: 1, sdp: { type: 'offer', sdp: 'v=0' } } };
    expect(parseClientMessage(JSON.stringify(offer))).toEqual(offer);
    const ice = { t: 'signal', to: 2, data: { conn: 3, ice: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 } } };
    expect(parseClientMessage(JSON.stringify(ice))).toEqual(ice);
  });
  it('rejects malformed or hostile messages', () => {
    expect(parseClientMessage('not json')).toBeNull();
    expect(parseClientMessage('{"t":"signal","to":9,"data":{"conn":1,"sdp":{"type":"offer","sdp":""}}}')).toBeNull();
    expect(parseClientMessage('{"t":"signal","to":1,"data":{"conn":1}}')).toBeNull();
    expect(parseClientMessage('{"t":"signal","to":1,"data":{"conn":1,"sdp":{"type":"pranswer","sdp":""}}}')).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'signal', to: 1, data: { conn: 1, sdp: { type: 'offer', sdp: 'x'.repeat(13000) } } }))).toBeNull();
    expect(parseClientMessage('{"t":"settings","settings":{"maxPlayers":99}}')).toBeNull();
    expect(parseClientMessage('{"t":"admin"}')).toBeNull();
  });
});
