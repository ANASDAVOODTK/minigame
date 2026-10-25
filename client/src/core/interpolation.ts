// Remote player interpolation: renders other players slightly in the past,
// between two received snapshots, so their motion is smooth even though
// snapshots arrive at 10-30 Hz with jitter. Falls back to short, capped
// extrapolation when updates are late or lost.

import { NET, TICK_RATE } from './config';
import { POS_SCALE, VEL_SCALE } from './physics';
import { F_ALIVE, type WorldFrame } from './snapshot';
import type { RenderPlayer } from './view';

const CAP = 32;

export class Interpolator {
  private frames: WorldFrame[] = [];
  extrapolating = 0;

  clear(): void {
    this.frames.length = 0;
  }

  /** Inserts a frame (sorted by tick). Frames are referenced, not copied. */
  push(f: WorldFrame): void {
    const fr = this.frames;
    let i = fr.length;
    while (i > 0 && fr[i - 1].tick > f.tick) i--;
    if (i > 0 && fr[i - 1].tick === f.tick) {
      fr[i - 1] = f;
      return;
    }
    if (fr.length >= CAP) {
      if (i === 0) return; // older than everything we keep
      // Drop the oldest and insert at i-1 (in place, no allocation).
      for (let k = 0; k < i - 1; k++) fr[k] = fr[k + 1];
      fr[i - 1] = f;
      return;
    }
    fr.push(f);
    for (let k = fr.length - 1; k > i; k--) fr[k] = fr[k - 1];
    fr[i] = f;
  }

  newestTick(): number {
    const n = this.frames.length;
    return n ? this.frames[n - 1].tick : -1;
  }

  /** Samples player `id` at fractional host tick `t`. Returns false if the player is unknown. */
  sample(id: number, t: number, out: RenderPlayer): boolean {
    const fr = this.frames;
    let a: WorldFrame | null = null;
    let b: WorldFrame | null = null;
    for (let i = fr.length - 1; i >= 0; i--) {
      const f = fr[i];
      if (!f.present[id]) continue;
      if (f.tick <= t) {
        a = f;
        break;
      }
      b = f;
    }
    if (a && b && a.spawn[id] === b.spawn[id]) {
      const k = (t - a.tick) / (b.tick - a.tick);
      fill(out, id, a);
      out.x = lerp(a.x[id], b.x[id], k) / POS_SCALE;
      out.y = lerp(a.y[id], b.y[id], k) / POS_SCALE;
      out.vx = lerp(a.vx[id], b.vx[id], k) / VEL_SCALE;
      out.vy = lerp(a.vy[id], b.vy[id], k) / VEL_SCALE;
      out.aim = lerpAim(a.aim[id], b.aim[id], k);
      return true;
    }
    if (a) {
      fill(out, id, a);
      // Late or missing update: extrapolate a little along the last velocity, then hold.
      const dtTicks = Math.min(t - a.tick, NET.maxExtrapolateTicks);
      if (dtTicks > 0 && b === null && a.flags[id] & F_ALIVE) {
        out.x += (out.vx * dtTicks) / TICK_RATE;
        out.y += (out.vy * dtTicks) / TICK_RATE;
        this.extrapolating++;
      }
      return true;
    }
    if (b) {
      fill(out, id, b);
      return true;
    }
    return false;
  }
}

function fill(out: RenderPlayer, id: number, f: WorldFrame): void {
  out.id = id;
  out.x = f.x[id] / POS_SCALE;
  out.y = f.y[id] / POS_SCALE;
  out.vx = f.vx[id] / VEL_SCALE;
  out.vy = f.vy[id] / VEL_SCALE;
  out.aim = f.aim[id];
  out.flags = f.flags[id];
  out.hp = f.hp[id];
  out.weapon = f.weapon[id];
  out.spawn = f.spawn[id];
  out.local = false;
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

/** Interpolates u16 angles along the shortest arc. */
export function lerpAim(a: number, b: number, k: number): number {
  let d = b - a;
  if (d > 32768) d -= 65536;
  else if (d < -32768) d += 65536;
  let r = Math.round(a + d * k);
  if (r < 0) r += 65536;
  else if (r >= 65536) r -= 65536;
  return r;
}
