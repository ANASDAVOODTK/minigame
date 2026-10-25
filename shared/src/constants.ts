// Values shared by the Cloudflare Worker / Durable Object and the browser client.

/** Room codes avoid look-alike characters (0/O, 1/I/L). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 5;
export const ROOM_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;

/** Player ids are small integers 1..MAX_PLAYERS so they fit in one byte on the wire. */
export const MAX_PLAYERS = 8;
export const MAX_PLAYER_OPTIONS = [2, 4, 6, 8] as const;
export const MATCH_DURATION_OPTIONS = [180, 300, 600] as const;

export const MAPS = [
  { id: 0, key: 'desert', name: 'Desert Battlefield' },
  { id: 1, key: 'jungle', name: 'Jungle Arena' },
  { id: 2, key: 'underground', name: 'Underground Base' },
] as const;

/** Soldier colors. Index is sent on the wire, never the raw string. */
export const PLAYER_COLORS = [
  '#e8553f', // red
  '#3f8ee8', // blue
  '#46c063', // green
  '#f0c23a', // yellow
  '#a65fe8', // purple
  '#38cfd0', // cyan
  '#ef7fb8', // pink
  '#f4f1e8', // white
] as const;

export const NICKNAME_MAX_LEN = 16;
export const CHAT_MAX_LEN = 120;

export const TIMING = {
  /** Reconnect tokens expire this long after the player's last disconnect. */
  reconnectTokenTtlMs: 10 * 60_000,
  /** Disconnected lobby members are dropped after this long (frees the slot). */
  lobbyDisconnectRemoveMs: 45_000,
  /** If the host is gone this long during a match, the match is ended for everyone. */
  hostGraceMs: 15_000,
  /** Grace left once another player confirms it lost its WebRTC link to the (offline) host too. */
  hostConfirmedLostMs: 3_000,
  /** Hard cap on room lifetime. */
  roomMaxAgeMs: 6 * 3600_000,
  /** Durable Object housekeeping interval. */
  alarmIntervalMs: 15_000,
  /** Public rooms start this long after the second player arrives (or after a match ends). */
  publicAutoStartMs: 15_000,
} as const;

/** Lifetime of TURN credentials handed to a browser. */
export const TURN_TTL_SEC = 4 * 3600;

/** Max size of one signaling message (SDP offers are typically 1-4 KB). */
export const MAX_SIGNAL_BYTES = 16_384;
