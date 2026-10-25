// Weapon definitions. All numbers are tunable; the host enforces them (fire rate,
// magazine size, reload time), and the shooter's client predicts the same rules.

export interface WeaponDef {
  id: number;
  key: string;
  name: string;
  /** Damage per pellet at close range. */
  damage: number;
  pellets: number;
  /** Ticks between shots (60 ticks = 1 s). */
  intervalTicks: number;
  magSize: number;
  reloadTicks: number;
  /** Max hitscan distance in px. */
  range: number;
  /** Damage starts falling off (linearly to 50%) beyond this distance. */
  falloffStart: number;
  /** Random cone half-angle in radians. */
  spread: number;
  /** Velocity pushed back on the shooter per shot (px/s) - the "recoil" you feel. */
  recoil: number;
  headshotMult: number;
  /** Projectile weapons (rocket) are simulated as entities instead of hitscan. Added in stage 2. */
  projectile: boolean;
}

export const WEAPONS: readonly WeaponDef[] = [
  { id: 0, key: 'pistol', name: 'Sparrow P9', damage: 20, pellets: 1, intervalTicks: 16, magSize: 12, reloadTicks: 66, range: 900, falloffStart: 450, spread: 0.022, recoil: 30, headshotMult: 1.5, projectile: false },
  { id: 1, key: 'rifle', name: 'Hornet AR', damage: 13, pellets: 1, intervalTicks: 6, magSize: 30, reloadTicks: 108, range: 1100, falloffStart: 550, spread: 0.045, recoil: 25, headshotMult: 1.5, projectile: false },
  { id: 2, key: 'shotgun', name: 'Bulldog 12', damage: 10, pellets: 8, intervalTicks: 48, magSize: 6, reloadTicks: 120, range: 480, falloffStart: 160, spread: 0.2, recoil: 260, headshotMult: 1.2, projectile: false },
  { id: 3, key: 'sniper', name: 'Longbow .338', damage: 80, pellets: 1, intervalTicks: 75, magSize: 5, reloadTicks: 150, range: 2400, falloffStart: 2400, spread: 0.003, recoil: 200, headshotMult: 2, projectile: false },
  { id: 4, key: 'rocket', name: 'Thunder RL', damage: 95, pellets: 1, intervalTicks: 60, magSize: 2, reloadTicks: 150, range: 1600, falloffStart: 1600, spread: 0.01, recoil: 150, headshotMult: 1, projectile: true },
];

/** Weapons usable in the current build (projectiles/pickups arrive in stage 2). */
export const DEFAULT_WEAPON = 0;

export function weaponDamage(w: WeaponDef, dist: number, headshot: boolean): number {
  let d = w.damage;
  if (dist > w.falloffStart && w.range > w.falloffStart) {
    const t = Math.min(1, (dist - w.falloffStart) / (w.range - w.falloffStart));
    d *= 1 - 0.5 * t;
  }
  if (headshot) d *= w.headshotMult;
  return Math.max(1, Math.round(d));
}
