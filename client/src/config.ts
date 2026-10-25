// Player settings (localStorage) and test/debug flags (URL query).

import { NICKNAME_MAX_LEN, PLAYER_COLORS, sanitizeNickname } from '@minimi/shared';

export type QualitySetting = 'auto' | 'low' | 'high';

export interface NetSimSettings {
  /** Extra round-trip latency (ms). */
  lagMs: number;
  /** Extra random one-way delay 0..jitterMs. */
  jitterMs: number;
  /** Unreliable-channel loss, percent. */
  lossPct: number;
  /** Upstream bandwidth cap in kbit/s (0 = unlimited). */
  bwKbps: number;
}

export interface Settings {
  name: string;
  color: number;
  quality: QualitySetting;
  sound: boolean;
  showDebug: boolean;
  /** Force TURN relay (tests the relay path). */
  relayOnly: boolean;
  sim: NetSimSettings;
}

const KEY = 'minimi.settings.v1';
const SESSION_KEY = 'minimi.session.v1';

export function defaultSettings(): Settings {
  return {
    name: '',
    color: Math.floor(Math.random() * PLAYER_COLORS.length),
    quality: 'auto',
    sound: true,
    showDebug: false,
    relayOnly: false,
    sim: { lagMs: 0, jitterMs: 0, lossPct: 0, bwKbps: 0 },
  };
}

const num = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;

export function loadSettings(): Settings {
  const s = defaultSettings();
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (raw && typeof raw === 'object') {
      s.name = sanitizeNickname(raw.name);
      s.color = Number.isInteger(raw.color) && raw.color >= 0 && raw.color < PLAYER_COLORS.length ? raw.color : s.color;
      s.quality = raw.quality === 'low' || raw.quality === 'high' ? raw.quality : 'auto';
      s.sound = raw.sound !== false;
      s.showDebug = raw.showDebug === true;
      s.relayOnly = raw.relayOnly === true;
      const sim = raw.sim ?? {};
      s.sim = {
        lagMs: num(sim.lagMs, 0, 1000, 0),
        jitterMs: num(sim.jitterMs, 0, 500, 0),
        lossPct: num(sim.lossPct, 0, 50, 0),
        bwKbps: num(sim.bwKbps, 0, 100_000, 0),
      };
    }
  } catch {
    /* storage unavailable (private mode) or corrupt: defaults */
  }
  return s;
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export interface DebugFlags {
  /** Drive the local player with a scripted test bot (automated tests only). */
  bot: boolean;
  /** Auto-ready / auto-start for automated tests. */
  autoReady: boolean;
}

/**
 * Test hooks via URL, e.g. ?lag=200&jitter=20&loss=5&bw=128&relay=1&debug=1&bot=1&name=Tester.
 * They override the stored settings for this tab only.
 */
export function applyUrlOverrides(s: Settings): DebugFlags {
  const q = new URLSearchParams(location.search);
  const n = (k: string) => (q.has(k) ? Number(q.get(k)) : NaN);
  if (q.has('lag')) s.sim.lagMs = num(n('lag'), 0, 1000, 0);
  if (q.has('jitter')) s.sim.jitterMs = num(n('jitter'), 0, 500, 0);
  if (q.has('loss')) s.sim.lossPct = num(n('loss'), 0, 50, 0);
  if (q.has('bw')) s.sim.bwKbps = num(n('bw'), 0, 100_000, 0);
  if (q.get('relay') === '1') s.relayOnly = true;
  if (q.get('debug') === '1') s.showDebug = true;
  if (q.get('quality') === 'low' || q.get('quality') === 'high') s.quality = q.get('quality') as QualitySetting;
  if (q.get('sound') === '0') s.sound = false;
  if (q.has('name')) s.name = sanitizeNickname(q.get('name')).slice(0, NICKNAME_MAX_LEN) || s.name;
  return { bot: q.get('bot') === '1', autoReady: q.get('autoready') === '1' };
}

export interface StoredSession {
  code: string;
  playerId: number;
  token: string;
}

/** Room membership survives a page reload (sessionStorage is per-tab, so two tabs = two players). */
export function loadStoredSession(): StoredSession | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null');
    if (v && typeof v.code === 'string' && typeof v.token === 'string' && Number.isInteger(v.playerId)) return v;
  } catch {
    /* ignore */
  }
  return null;
}

export function storeSession(s: StoredSession | null): void {
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}
