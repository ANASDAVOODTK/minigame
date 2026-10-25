import {
  CHAT_MAX_LEN,
  MAPS,
  MATCH_DURATION_OPTIONS,
  MAX_PLAYER_OPTIONS,
  NICKNAME_MAX_LEN,
  PLAYER_COLORS,
  ROOM_CODE_RE,
} from './constants';
import type { RoomSettings } from './signaling';

// Control chars, zero-width chars, bidi overrides and other invisible formatting.
const INVISIBLE_RE = new RegExp('[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]', 'g');
// Characters that are risky if a name ever ends up in markup or a CSV/console.
const RISKY_RE = /[<>&"'`\\]/g;

function cleanText(raw: unknown, maxLen: number): string {
  if (typeof raw !== 'string') return '';
  let s = raw.length > maxLen * 8 ? raw.slice(0, maxLen * 8) : raw;
  s = s.normalize('NFKC').replace(INVISIBLE_RE, '').replace(RISKY_RE, '');
  s = s.replace(/\s+/g, ' ').trim();
  // Limit by code points, not UTF-16 units, so emoji are never split.
  const cps = Array.from(s);
  return cps.length > maxLen ? cps.slice(0, maxLen).join('').trim() : s;
}

export function sanitizeNickname(raw: unknown): string {
  return cleanText(raw, NICKNAME_MAX_LEN);
}

export function sanitizeChat(raw: unknown): string {
  return cleanText(raw, CHAT_MAX_LEN);
}

export function normalizeRoomCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return ROOM_CODE_RE.test(code) ? code : null;
}

export function isValidColor(c: unknown): c is number {
  return Number.isInteger(c) && (c as number) >= 0 && (c as number) < PLAYER_COLORS.length;
}

export function isValidMapId(m: unknown): m is number {
  return Number.isInteger(m) && MAPS.some((x) => x.id === m);
}

export function isValidMaxPlayers(n: unknown): n is number {
  return (MAX_PLAYER_OPTIONS as readonly number[]).includes(n as number);
}

export function isValidDuration(d: unknown): d is number {
  return (MATCH_DURATION_OPTIONS as readonly number[]).includes(d as number);
}

/** Validates a complete settings object; returns null if anything is off. */
export function validateSettings(raw: unknown): RoomSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isValidMaxPlayers(o.maxPlayers) || !isValidMapId(o.mapId) || !isValidDuration(o.durationSec)) return null;
  return { maxPlayers: o.maxPlayers, mapId: o.mapId, durationSec: o.durationSec };
}
