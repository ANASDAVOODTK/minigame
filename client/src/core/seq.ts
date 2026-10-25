// 16-bit wrap-around sequence numbers.

/** Signed distance a - b for u16 sequence numbers (-32768..32767). */
export function seqDiff(a: number, b: number): number {
  return ((a - b + 0x8000) & 0xffff) - 0x8000;
}

export function seqNext(a: number): number {
  return (a + 1) & 0xffff;
}

export function seqAdd(a: number, n: number): number {
  return (a + n) & 0xffff;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function approach(v: number, target: number, step: number): number {
  if (v < target) return Math.min(v + step, target);
  if (v > target) return Math.max(v - step, target);
  return v;
}

/** Cheap deterministic hash -> [-1, 1). Same result in every JS engine (integer math only). */
export function hashSpread(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return ((h >>> 0) / 4294967296) * 2 - 1;
}
