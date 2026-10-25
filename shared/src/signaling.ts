// JSON messages exchanged between browsers and the room Durable Object over the
// signaling WebSocket. Signaling is low-frequency (room changes + WebRTC setup),
// so JSON is fine here. Gameplay never goes through this channel.

import { MAX_PLAYERS, MAX_SIGNAL_BYTES } from './constants';
import { isValidDuration, isValidMapId, isValidMaxPlayers } from './sanitize';

export interface RoomSettings {
  maxPlayers: number;
  mapId: number;
  durationSec: number;
}

export type RoomPhase = 'lobby' | 'playing';

export interface MemberInfo {
  id: number;
  name: string;
  color: number;
  ready: boolean;
  connected: boolean;
}

export interface RoomInfo {
  code: string;
  settings: RoomSettings;
  phase: RoomPhase;
  /** Room owner (can change settings / start). */
  ownerId: number;
  /** Player whose browser runs the authoritative simulation. Equal to ownerId in this version. */
  hostId: number;
  /** Increments every time a match starts. */
  matchId: number;
  members: MemberInfo[];
  /** Public (quick-play) rooms are listed by the matchmaker and start automatically. */
  public: boolean;
  /** Milliseconds until a public room auto-starts (0 = not scheduled). */
  autoStartInMs: number;
}

/** Why the room changed in a way the UI should explain. */
export type RoomNotice = 'host_left' | 'owner_changed' | 'match_ended';

/** WebRTC negotiation payload relayed verbatim between two members. */
export interface SignalData {
  /** Connection attempt number; a higher value replaces the previous RTCPeerConnection. */
  conn: number;
  sdp?: { type: 'offer' | 'answer'; sdp: string };
  ice?: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null };
}

// ---- client -> Durable Object ----
export type ClientMessage =
  | { t: 'signal'; to: number; data: SignalData }
  | { t: 'ready'; ready: boolean }
  | { t: 'settings'; settings: Partial<RoomSettings> }
  | { t: 'start' }
  | { t: 'end'; matchId: number }
  /** "My WebRTC link to the host is gone too" - shortens the host grace period. */
  | { t: 'host_lost' }
  | { t: 'leave' };

// ---- Durable Object -> client ----
export type ServerMessage =
  | { t: 'welcome'; you: number; room: RoomInfo }
  | { t: 'room'; room: RoomInfo; notice?: RoomNotice }
  | { t: 'signal'; from: number; data: SignalData }
  | { t: 'error'; code: string; message: string };

const isPlayerId = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_PLAYERS;
const isStrMax = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isOptStrMax = (v: unknown, max: number) => v === undefined || v === null || isStrMax(v, max);
const isOptInt = (v: unknown) => v === undefined || v === null || (Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1024);

export function isValidSignalData(d: unknown): d is SignalData {
  if (!d || typeof d !== 'object') return false;
  const o = d as Record<string, unknown>;
  if (!Number.isInteger(o.conn) || (o.conn as number) < 0 || (o.conn as number) > 1_000_000) return false;
  const hasSdp = o.sdp !== undefined;
  const hasIce = o.ice !== undefined;
  if (hasSdp === hasIce) return false; // exactly one
  if (hasSdp) {
    const s = o.sdp as Record<string, unknown> | null;
    if (!s || typeof s !== 'object') return false;
    if (s.type !== 'offer' && s.type !== 'answer') return false;
    return isStrMax(s.sdp, 12_000);
  }
  const c = o.ice as Record<string, unknown> | null;
  if (!c || typeof c !== 'object') return false;
  return (
    isStrMax(c.candidate, 1024) &&
    isOptStrMax(c.sdpMid, 64) &&
    isOptInt(c.sdpMLineIndex) &&
    isOptStrMax(c.usernameFragment, 256)
  );
}

/** Strict parser used by the Durable Object. Returns null for anything malformed. */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > MAX_SIGNAL_BYTES) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  switch (o.t) {
    case 'signal':
      return isPlayerId(o.to) && isValidSignalData(o.data) ? { t: 'signal', to: o.to, data: o.data } : null;
    case 'ready':
      return typeof o.ready === 'boolean' ? { t: 'ready', ready: o.ready } : null;
    case 'settings': {
      const s = o.settings as Record<string, unknown> | null;
      if (!s || typeof s !== 'object') return null;
      const out: Partial<RoomSettings> = {};
      if (s.maxPlayers !== undefined) {
        if (!isValidMaxPlayers(s.maxPlayers)) return null;
        out.maxPlayers = s.maxPlayers;
      }
      if (s.mapId !== undefined) {
        if (!isValidMapId(s.mapId)) return null;
        out.mapId = s.mapId;
      }
      if (s.durationSec !== undefined) {
        if (!isValidDuration(s.durationSec)) return null;
        out.durationSec = s.durationSec;
      }
      return { t: 'settings', settings: out };
    }
    case 'start':
      return { t: 'start' };
    case 'end':
      return Number.isInteger(o.matchId) ? { t: 'end', matchId: o.matchId as number } : null;
    case 'leave':
      return { t: 'leave' };
    case 'host_lost':
      return { t: 'host_lost' };
    default:
      return null;
  }
}
