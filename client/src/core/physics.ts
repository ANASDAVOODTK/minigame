// Deterministic player simulation shared by the authoritative host and the
// predicting client. State is snapped to the network quantization grid after
// every tick, so a replicated state replays exactly like the original.

import { DT, MOVE, PLAYER_HH, PLAYER_HW, TILE } from './config';
import { BTN, angleFromAim, type InputCmd } from './input';
import { T_PLATFORM, T_SOLID, type GameMap } from './maps';
import { approach } from './seq';
import { DEFAULT_WEAPON, WEAPONS } from './weapons';

export interface PlayerSim {
  x: number;
  y: number;
  vx: number;
  vy: number;
  onGround: boolean;
  jetting: boolean;
  fuel: number;
  aim: number;
  weapon: number;
  ammo: number;
  reload: number;
  cooldown: number;
  /** Buttons held on the previous tick (edge detection). */
  btn: number;
}

export function makePlayerSim(): PlayerSim {
  return {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    onGround: false,
    jetting: false,
    fuel: MOVE.fuelMax,
    aim: 0,
    weapon: DEFAULT_WEAPON,
    ammo: WEAPONS[DEFAULT_WEAPON].magSize,
    reload: 0,
    cooldown: 0,
    btn: 0,
  };
}

export function copySim(dst: PlayerSim, s: PlayerSim): PlayerSim {
  dst.x = s.x;
  dst.y = s.y;
  dst.vx = s.vx;
  dst.vy = s.vy;
  dst.onGround = s.onGround;
  dst.jetting = s.jetting;
  dst.fuel = s.fuel;
  dst.aim = s.aim;
  dst.weapon = s.weapon;
  dst.ammo = s.ammo;
  dst.reload = s.reload;
  dst.cooldown = s.cooldown;
  dst.btn = s.btn;
  return dst;
}

export function resetSimForSpawn(p: PlayerSim, x: number, y: number): void {
  p.x = x;
  p.y = y;
  p.vx = 0;
  p.vy = 0;
  p.onGround = false;
  p.jetting = false;
  p.fuel = MOVE.fuelMax;
  p.weapon = DEFAULT_WEAPON;
  p.ammo = WEAPONS[DEFAULT_WEAPON].magSize;
  p.reload = 0;
  p.cooldown = 0;
}

// Network quantization grid: positions 1/8 px, velocities 1/16 px/s.
export const POS_SCALE = 8;
export const VEL_SCALE = 16;
const MAX_POS = 65535 / POS_SCALE;

function quantize(p: PlayerSim): void {
  p.x = Math.round(p.x * POS_SCALE) / POS_SCALE;
  p.y = Math.round(p.y * POS_SCALE) / POS_SCALE;
  p.vx = Math.round(p.vx * VEL_SCALE) / VEL_SCALE;
  p.vy = Math.round(p.vy * VEL_SCALE) / VEL_SCALE;
}

export function tileAt(map: GameMap, tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return T_SOLID;
  return map.tiles[ty * map.w + tx];
}

export function isSolidAt(map: GameMap, px: number, py: number): boolean {
  return tileAt(map, Math.floor(px / TILE), Math.floor(py / TILE)) === T_SOLID;
}

const EPS = 1e-4;

function moveX(p: PlayerSim, dx: number, map: GameMap): void {
  if (dx === 0) return;
  p.x += dx;
  const ty0 = Math.floor((p.y - PLAYER_HH) / TILE);
  const ty1 = Math.floor((p.y + PLAYER_HH - EPS) / TILE);
  if (dx > 0) {
    const tx = Math.floor((p.x + PLAYER_HW - EPS) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) {
      if (tileAt(map, tx, ty) === T_SOLID) {
        p.x = tx * TILE - PLAYER_HW;
        p.vx = 0;
        return;
      }
    }
  } else {
    const tx = Math.floor((p.x - PLAYER_HW) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) {
      if (tileAt(map, tx, ty) === T_SOLID) {
        p.x = (tx + 1) * TILE + PLAYER_HW;
        p.vx = 0;
        return;
      }
    }
  }
}

function moveY(p: PlayerSim, dy: number, map: GameMap, dropThrough: boolean): void {
  if (dy === 0) return;
  const prevBottom = p.y + PLAYER_HH;
  p.y += dy;
  const tx0 = Math.floor((p.x - PLAYER_HW) / TILE);
  const tx1 = Math.floor((p.x + PLAYER_HW - EPS) / TILE);
  if (dy > 0) {
    const ty = Math.floor((p.y + PLAYER_HH - EPS) / TILE);
    const top = ty * TILE;
    for (let tx = tx0; tx <= tx1; tx++) {
      const t = tileAt(map, tx, ty);
      // Platforms only catch a player whose feet were at or above the top last tick.
      // Landed positions sit exactly on the (integer) top, so a tiny epsilon suffices
      // and a single tick of DOWN is enough to drop through.
      if (t === T_SOLID || (t === T_PLATFORM && !dropThrough && prevBottom <= top + 0.01)) {
        p.y = top - PLAYER_HH;
        p.vy = 0;
        p.onGround = true;
        return;
      }
    }
  } else {
    const ty = Math.floor((p.y - PLAYER_HH) / TILE);
    for (let tx = tx0; tx <= tx1; tx++) {
      if (tileAt(map, tx, ty) === T_SOLID) {
        p.y = (ty + 1) * TILE + PLAYER_HH;
        p.vy = 0;
        return;
      }
    }
  }
}

/** Advances weapon timers and decides whether this tick fires. */
function stepWeapon(p: PlayerSim, buttons: number, canFire: boolean): boolean {
  const w = WEAPONS[p.weapon];
  if (p.cooldown > 0) p.cooldown--;
  if (p.reload > 0) {
    p.reload--;
    if (p.reload === 0) p.ammo = w.magSize;
  }
  if (buttons & BTN.RELOAD && p.reload === 0 && p.ammo < w.magSize) p.reload = w.reloadTicks;
  if (canFire && buttons & BTN.FIRE && p.reload === 0 && p.cooldown === 0 && p.ammo > 0) {
    p.ammo--;
    p.cooldown = w.intervalTicks;
    if (p.ammo === 0) p.reload = w.reloadTicks; // auto-reload on empty
    return true;
  }
  return false;
}

/**
 * One 60 Hz tick for one player. Returns true if the player fired this tick.
 * `canFire` lets the host veto shots (e.g. spawn protection / match over) - the
 * client predicts with the same flag when it knows it.
 */
export function stepPlayer(p: PlayerSim, cmd: InputCmd, map: GameMap, canFire = true): boolean {
  p.aim = cmd.aim;
  const fired = stepWeapon(p, cmd.buttons, canFire);
  if (fired) {
    const a = angleFromAim(p.aim);
    const k = WEAPONS[p.weapon].recoil;
    p.vx -= Math.cos(a) * k;
    p.vy -= Math.sin(a) * k * 0.5;
  }

  // Horizontal.
  const mx = cmd.moveX / 127;
  if (mx !== 0) {
    const accel = p.onGround ? MOVE.groundAccel : MOVE.airAccel;
    p.vx = approach(p.vx, mx * MOVE.runSpeed, accel * DT);
  } else {
    p.vx = approach(p.vx, 0, (p.onGround ? MOVE.groundFriction : MOVE.airFriction) * DT);
  }

  // Jetpack.
  p.jetting = false;
  if (cmd.buttons & BTN.JET && p.fuel > 0) {
    if (p.onGround && p.vy >= 0) p.vy = -MOVE.liftoffSpeed;
    p.vy -= MOVE.jetAccel * DT;
    if (p.vy < -MOVE.jetMaxUp) p.vy = -MOVE.jetMaxUp;
    p.fuel = Math.max(0, p.fuel - MOVE.fuelBurn);
    p.jetting = true;
  } else {
    p.fuel = Math.min(MOVE.fuelMax, p.fuel + (p.onGround ? MOVE.fuelRegenGround : MOVE.fuelRegenAir));
  }

  p.vy += MOVE.gravity * DT;
  if (p.vy > MOVE.maxFall) p.vy = MOVE.maxFall;
  if (p.vx > MOVE.maxSpeed) p.vx = MOVE.maxSpeed;
  else if (p.vx < -MOVE.maxSpeed) p.vx = -MOVE.maxSpeed;
  if (p.vy < -MOVE.maxSpeed) p.vy = -MOVE.maxSpeed;

  moveX(p, p.vx * DT, map);
  p.onGround = false;
  moveY(p, p.vy * DT, map, (cmd.buttons & BTN.DOWN) !== 0);

  if (p.x < 0) p.x = 0;
  else if (p.x > MAX_POS) p.x = MAX_POS;
  if (p.y < 0) p.y = 0;
  else if (p.y > MAX_POS) p.y = MAX_POS;
  quantize(p);
  p.btn = cmd.buttons;
  return fired;
}

/**
 * Distance along a ray to the first solid tile (one-way platforms don't block bullets).
 * Amanatides-Woo grid traversal; returns maxDist if nothing is hit.
 */
export function raycastTiles(map: GameMap, ox: number, oy: number, dx: number, dy: number, maxDist: number): number {
  let tx = Math.floor(ox / TILE);
  let ty = Math.floor(oy / TILE);
  if (tileAt(map, tx, ty) === T_SOLID) return 0;
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(TILE / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(TILE / dy) : Infinity;
  let tMaxX = dx !== 0 ? ((dx > 0 ? (tx + 1) * TILE - ox : ox - tx * TILE) / Math.abs(dx)) : Infinity;
  let tMaxY = dy !== 0 ? ((dy > 0 ? (ty + 1) * TILE - oy : oy - ty * TILE) / Math.abs(dy)) : Infinity;
  for (let i = 0; i < 512; i++) {
    let t: number;
    if (tMaxX < tMaxY) {
      t = tMaxX;
      tMaxX += tDeltaX;
      tx += stepX;
    } else {
      t = tMaxY;
      tMaxY += tDeltaY;
      ty += stepY;
    }
    if (t > maxDist) return maxDist;
    if (tileAt(map, tx, ty) === T_SOLID) return t;
  }
  return maxDist;
}

/** Ray vs axis-aligned box (slab test). Returns entry distance, or -1 if missed. */
export function rayAabb(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): number {
  let tmin = 0;
  let tmax = Infinity;
  if (dx !== 0) {
    const inv = 1 / dx;
    let t1 = (minX - ox) * inv;
    let t2 = (maxX - ox) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
  } else if (ox < minX || ox > maxX) return -1;
  if (dy !== 0) {
    const inv = 1 / dy;
    let t1 = (minY - oy) * inv;
    let t2 = (maxY - oy) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
  } else if (oy < minY || oy > maxY) return -1;
  return tmax >= tmin ? tmin : -1;
}
