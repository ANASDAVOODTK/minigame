// Pure room logic (no Cloudflare APIs) so it can be unit-tested in Node.
// The RoomDO Durable Object owns one RoomData, persists it, and applies these rules.

import {
  MAX_PLAYERS,
  NICKNAME_MAX_LEN,
  PLAYER_COLORS,
  TIMING,
  isValidColor,
  sanitizeNickname,
  type MemberInfo,
  type RoomInfo,
  type RoomNotice,
  type RoomPhase,
  type RoomSettings,
} from '@minimi/shared';

export interface Member {
  id: number;
  name: string;
  color: number;
  ready: boolean;
  connected: boolean;
  token: string;
  tokenExp: number;
  lastSeen: number;
  joinedAt: number;
}

export interface RoomData {
  v: 1;
  code: string;
  createdAt: number;
  settings: RoomSettings;
  phase: RoomPhase;
  ownerId: number;
  hostId: number;
  matchId: number;
  members: Member[];
  /** When the host's signaling socket dropped; 0 while the host is connected. */
  hostLostAt: number;
  /** Listed by the matchmaker (Play Online); starts automatically. */
  public: boolean;
  /** Epoch ms when a public room auto-starts; 0 = not scheduled. */
  autoStartAt: number;
}

export type JoinOutcome =
  | { ok: true; member: Member; rejoined: boolean }
  | { ok: false; status: number; error: string; message: string };

export interface TickOutcome {
  changed: boolean;
  destroy: boolean;
  notice?: RoomNotice;
}

export function randomToken(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

/** Constant-time string comparison for tokens. */
export function tokenEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function newRoom(code: string, settings: RoomSettings, now: number, isPublic = false): RoomData {
  return {
    v: 1,
    code,
    createdAt: now,
    settings: { ...settings },
    phase: 'lobby',
    ownerId: 0,
    hostId: 0,
    matchId: 0,
    members: [],
    hostLostAt: 0,
    public: isPublic,
    autoStartAt: 0,
  };
}

export class Room {
  constructor(readonly d: RoomData) {}

  info(now = Date.now()): RoomInfo {
    const members: MemberInfo[] = this.d.members
      .map((m) => ({ id: m.id, name: m.name, color: m.color, ready: m.ready, connected: m.connected }))
      .sort((a, b) => a.id - b.id);
    return {
      code: this.d.code,
      settings: { ...this.d.settings },
      phase: this.d.phase,
      ownerId: this.d.ownerId,
      hostId: this.d.hostId,
      matchId: this.d.matchId,
      members,
      public: this.d.public,
      autoStartInMs: this.d.autoStartAt ? Math.max(0, this.d.autoStartAt - now) : 0,
    };
  }

  member(id: number): Member | undefined {
    return this.d.members.find((m) => m.id === id);
  }

  byToken(token: string, now: number): Member | undefined {
    if (typeof token !== 'string' || token.length !== 32) return undefined;
    const m = this.d.members.find((x) => tokenEquals(x.token, token));
    return m && m.tokenExp > now ? m : undefined;
  }

  connectedCount(): number {
    return this.d.members.reduce((n, m) => n + (m.connected ? 1 : 0), 0);
  }

  join(rawName: unknown, rawColor: unknown, token: string | undefined, now: number, rejoinOnly = false): JoinOutcome {
    if (token) {
      const existing = this.byToken(token, now);
      if (existing) {
        existing.tokenExp = now + TIMING.reconnectTokenTtlMs;
        return { ok: true, member: existing, rejoined: true };
      }
    }
    if (rejoinOnly) return { ok: false, status: 401, error: 'token_expired', message: 'Your seat in this room has expired.' };
    if (this.d.members.length >= this.d.settings.maxPlayers) {
      return { ok: false, status: 409, error: 'room_full', message: 'This room is full.' };
    }
    let id = 0;
    for (let i = 1; i <= MAX_PLAYERS; i++) {
      if (!this.member(i)) {
        id = i;
        break;
      }
    }
    if (!id) return { ok: false, status: 409, error: 'room_full', message: 'This room is full.' };

    const m: Member = {
      id,
      name: this.uniqueName(sanitizeNickname(rawName) || `Player ${id}`),
      color: this.freeColor(isValidColor(rawColor) ? rawColor : 0),
      ready: false,
      connected: false,
      token: randomToken(),
      tokenExp: now + TIMING.reconnectTokenTtlMs,
      lastSeen: now,
      joinedAt: now,
    };
    this.d.members.push(m);
    if (!this.d.ownerId) {
      this.d.ownerId = id;
      this.d.hostId = id;
    }
    return { ok: true, member: m, rejoined: false };
  }

  private uniqueName(name: string): string {
    const taken = new Set(this.d.members.map((m) => m.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; n < 20; n++) {
      const suffix = ` ${n}`;
      const base = Array.from(name).slice(0, NICKNAME_MAX_LEN - suffix.length).join('');
      const candidate = base + suffix;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return name;
  }

  private freeColor(preferred: number): number {
    const used = new Set(this.d.members.map((m) => m.color));
    if (!used.has(preferred)) return preferred;
    for (let i = 0; i < PLAYER_COLORS.length; i++) if (!used.has(i)) return i;
    return preferred;
  }

  connect(id: number, now: number): void {
    const m = this.member(id);
    if (!m) return;
    m.connected = true;
    m.lastSeen = now;
    m.tokenExp = now + TIMING.reconnectTokenTtlMs;
    if (id === this.d.hostId) this.d.hostLostAt = 0;
  }

  disconnect(id: number, now: number): void {
    const m = this.member(id);
    if (!m) return;
    m.connected = false;
    m.lastSeen = now;
    m.tokenExp = now + TIMING.reconnectTokenTtlMs;
    if (id === this.d.hostId) this.d.hostLostAt = now;
  }

  /** Explicit leave. Returns a notice if the room changed in a user-visible way. */
  leave(id: number, now: number): RoomNotice | undefined {
    const idx = this.d.members.findIndex((m) => m.id === id);
    if (idx < 0) return undefined;
    this.d.members.splice(idx, 1);
    if (id === this.d.ownerId || id === this.d.hostId) return this.replaceHost(now);
    return undefined;
  }

  /** Picks a new owner/host. Aborts a running match, because host migration is not supported. */
  private replaceHost(_now: number): RoomNotice | undefined {
    const wasPlaying = this.d.phase === 'playing';
    // Prefer connected members, then whoever joined earliest.
    const next = this.d.members
      .filter((m) => m.id !== this.d.hostId)
      .sort((a, b) => Number(b.connected) - Number(a.connected) || a.joinedAt - b.joinedAt)[0];
    this.d.ownerId = next ? next.id : 0;
    this.d.hostId = this.d.ownerId;
    this.d.hostLostAt = 0;
    if (wasPlaying) {
      this.d.phase = 'lobby';
      for (const m of this.d.members) m.ready = false;
      return 'host_left';
    }
    return 'owner_changed';
  }

  /**
   * A player reports it lost its WebRTC link to the host. Only meaningful while the host's
   * signaling socket is also down: then the remaining grace is cut to hostConfirmedLostMs.
   */
  reportHostLost(id: number, now: number): boolean {
    if (id === this.d.hostId || !this.d.hostLostAt || this.d.phase !== 'playing') return false;
    const cut = now - (TIMING.hostGraceMs - TIMING.hostConfirmedLostMs);
    if (cut >= this.d.hostLostAt) return false;
    this.d.hostLostAt = Math.max(cut, this.d.hostLostAt - TIMING.hostGraceMs);
    return true;
  }

  setReady(id: number, ready: boolean): boolean {
    const m = this.member(id);
    if (!m || this.d.phase !== 'lobby' || m.ready === ready) return false;
    m.ready = ready;
    return true;
  }

  updateSettings(id: number, s: Partial<RoomSettings>): string | null {
    if (id !== this.d.ownerId) return 'not_owner';
    if (this.d.phase !== 'lobby') return 'match_running';
    if (s.maxPlayers !== undefined && s.maxPlayers < this.d.members.length) return 'too_many_players';
    this.d.settings = { ...this.d.settings, ...s };
    return null;
  }

  /** Returns an error code, or null if the match was started. */
  start(id: number): string | null {
    if (id !== this.d.ownerId) return 'not_owner';
    if (this.d.phase !== 'lobby') return 'match_running';
    const connected = this.d.members.filter((m) => m.connected);
    if (connected.length < 2) return 'need_two_players';
    if (connected.some((m) => m.id !== this.d.ownerId && !m.ready)) return 'not_all_ready';
    this.d.autoStartAt = 0;
    this.d.phase = 'playing';
    this.d.matchId++;
    this.d.hostId = this.d.ownerId;
    return null;
  }

  end(id: number, matchId: number): boolean {
    if (id !== this.d.hostId || this.d.phase !== 'playing' || matchId !== this.d.matchId) return false;
    this.d.phase = 'lobby';
    for (const m of this.d.members) m.ready = false;
    return true;
  }

  /**
   * Public rooms: schedule an automatic start once 2+ players are connected in the lobby,
   * cancel it when that is no longer true. Returns true if the schedule changed.
   */
  updateAutoStart(now: number): boolean {
    if (!this.d.public) return false;
    const want = this.d.phase === 'lobby' && this.connectedCount() >= 2;
    if (want && !this.d.autoStartAt) {
      this.d.autoStartAt = now + TIMING.publicAutoStartMs;
      return true;
    }
    if (!want && this.d.autoStartAt) {
      this.d.autoStartAt = 0;
      return true;
    }
    return false;
  }

  private autoStart(now: number): boolean {
    if (!this.d.public || !this.d.autoStartAt || now < this.d.autoStartAt) return false;
    this.d.autoStartAt = 0;
    if (this.d.phase !== 'lobby' || this.connectedCount() < 2) return false;
    const owner = this.member(this.d.ownerId);
    if (!owner?.connected) return false;
    this.d.phase = 'playing';
    this.d.matchId++;
    this.d.hostId = this.d.ownerId;
    return true;
  }

  tick(now: number): TickOutcome {
    let changed = false;
    let notice: RoomNotice | undefined;

    for (const m of this.d.members) if (m.connected) m.tokenExp = now + TIMING.reconnectTokenTtlMs;

    // Drop members that have been gone too long.
    const lobby = this.d.phase === 'lobby';
    const stale = this.d.members.filter(
      (m) => !m.connected && (lobby ? now - m.lastSeen > TIMING.lobbyDisconnectRemoveMs : now > m.tokenExp),
    );
    for (const m of stale) {
      const n = this.leave(m.id, now);
      notice = n ?? notice;
      changed = true;
    }

    // Host vanished: give everyone else a short grace period, then end the match / hand over the room.
    if (this.d.hostLostAt && now - this.d.hostLostAt >= TIMING.hostGraceMs) {
      const someoneElse = this.d.members.some((m) => m.connected && m.id !== this.d.hostId);
      if (someoneElse) {
        notice = this.replaceHost(now) ?? notice;
        changed = true;
      }
    }

    if (this.updateAutoStart(now)) changed = true;
    if (this.autoStart(now)) changed = true;

    const destroy = this.d.members.length === 0 || now - this.d.createdAt > TIMING.roomMaxAgeMs;
    return { changed, destroy, notice };
  }

  /** When the Durable Object should next wake up for housekeeping. */
  nextAlarmAt(now: number): number {
    let at = now + TIMING.alarmIntervalMs;
    if (this.d.hostLostAt) at = Math.min(at, this.d.hostLostAt + TIMING.hostGraceMs + 250);
    if (this.d.autoStartAt) at = Math.min(at, this.d.autoStartAt + 50);
    return Math.max(at, now + 1000);
  }
}
