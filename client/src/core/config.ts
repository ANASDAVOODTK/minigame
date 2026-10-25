// Gameplay and netcode tuning. Everything that both the host simulation and the
// client-side prediction depend on lives here, so they always agree.

import { MAX_PLAYERS } from '@minimi/shared';

export { MAX_PLAYERS };
/** Arrays indexed by player id (1..8) use this length; index 0 is unused. */
export const SLOTS = MAX_PLAYERS + 1;

export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;
export const DT = 1 / TICK_RATE;

export const TILE = 32;

// Player hitbox (centered on x,y).
export const PLAYER_HW = 11;
export const PLAYER_HH = 20;
export const HEAD_H = 12;
/** Bullets originate from the shoulder, this many px from the hitbox center. */
export const SHOULDER_Y = -6;
export const MAX_HP = 100;

export const MOVE = {
  runSpeed: 215,
  groundAccel: 2400,
  airAccel: 1300,
  groundFriction: 2600,
  airFriction: 320,
  gravity: 1500,
  maxFall: 760,
  jetAccel: 2950,
  jetMaxUp: 340,
  liftoffSpeed: 230,
  /** Fuel is an integer so it is replicated exactly (no prediction drift). */
  fuelMax: 1000,
  fuelBurn: 4,
  fuelRegenGround: 10,
  fuelRegenAir: 1,
  maxSpeed: 2000,
} as const;

export const MATCH = {
  respawnTicks: 3 * TICK_RATE,
  spawnProtectTicks: 2 * TICK_RATE,
  /** Disconnected players stay in the world (invulnerable, frozen) this long before removal. */
  disconnectRemoveTicks: 30 * TICK_RATE,
} as const;

export const NET = {
  protocolVersion: 1,

  // Client -> host input stream.
  inputSendHz: 30,
  inputSendHzPoor: 20,
  /** Unacknowledged inputs are re-sent in every packet (loss resilience), up to this many. */
  maxInputsPerPacket: 16,

  // Host -> client snapshots.
  snapshotHzDefault: 20,
  snapshotHzOptions: [10, 15, 20, 30] as readonly number[],

  pingIntervalMs: 1000,
  statsIntervalMs: 2000,

  /** Skip an unreliable send when this much data is already queued (stale data is worse than none). */
  maxBufferedU: 8 * 1024,

  // Host-side input handling / anti-speedhack.
  maxQueuedInputs: 48,
  /** Ticks of "credit" a client can bank to catch up after a lag spike. */
  maxInputBudget: 20,
  /** Missing inputs older than the redundancy window are filled by repeating the last input, up to this many. */
  maxGapFill: 30,

  // Lag compensation.
  maxRewindTicks: 24, // 400 ms
  historyTicks: 64,

  // Ring sizes.
  hostFrameRing: 128,
  clientFrameRing: 64,
  peerSeqRing: 64,

  // Interpolation.
  maxExtrapolateTicks: 9, // 150 ms
  minInterpDelayMs: 50,
  maxInterpDelayMs: 350,
  /** How far the host renders remote players in the past (smooths bursty input arrival). */
  hostViewDelayTicks: 5,
} as const;
