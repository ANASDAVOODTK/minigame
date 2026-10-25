import { describe, expect, it } from 'vitest';
import { MOVE, PLAYER_HH, TILE } from '../client/src/core/config';
import { BTN, makeInput } from '../client/src/core/input';
import { T_PLATFORM, T_SOLID, getMap, type GameMap } from '../client/src/core/maps';
import { copySim, makePlayerSim, raycastTiles, rayAabb, stepPlayer } from '../client/src/core/physics';
import { WEAPONS } from '../client/src/core/weapons';

/** 20x12 test map: solid border + floor at row 10, a one-way platform at row 6, a wall at column 14. */
function testMap(): GameMap {
  const w = 20;
  const h = 12;
  const tiles = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    tiles[x] = T_SOLID;
    tiles[10 * w + x] = T_SOLID;
    tiles[11 * w + x] = T_SOLID;
  }
  for (let y = 0; y < h; y++) {
    tiles[y * w] = T_SOLID;
    tiles[y * w + w - 1] = T_SOLID;
    tiles[y * w + 14] = y >= 7 ? T_SOLID : tiles[y * w + 14];
  }
  for (let x = 3; x <= 8; x++) tiles[6 * w + x] = T_PLATFORM;
  const base = getMap(0);
  return { ...base, w, h, pxW: w * TILE, pxH: h * TILE, tiles, spawns: [{ x: 100, y: 10 * TILE - PLAYER_HH }] };
}

function run(map: GameMap, ticks: number, buttons: number, moveX: number, p = makePlayerSim()) {
  const cmd = makeInput();
  for (let i = 0; i < ticks; i++) {
    cmd.seq = i;
    cmd.buttons = buttons;
    cmd.moveX = moveX;
    stepPlayer(p, cmd, map);
  }
  return p;
}

describe('player physics', () => {
  const map = testMap();
  const floorY = 10 * TILE - PLAYER_HH;

  it('falls under gravity and lands on solid ground', () => {
    const p = makePlayerSim();
    p.x = 12 * TILE;
    p.y = 50;
    run(map, 120, 0, 0, p);
    expect(p.y).toBe(floorY);
    expect(p.onGround).toBe(true);
    expect(p.vy).toBe(0);
  });

  it('runs at the configured speed and stops at walls', () => {
    const p = makePlayerSim();
    p.x = 300;
    p.y = floorY;
    run(map, 30, 0, 127, p);
    expect(p.vx).toBeCloseTo(MOVE.runSpeed, 0);
    run(map, 120, 0, 127, p);
    expect(p.x + 11).toBe(14 * TILE); // flush against the wall
    expect(p.vx).toBe(0);
  });

  it('jetpack lifts off, burns fuel, and refuels on the ground', () => {
    const p = makePlayerSim();
    p.x = 300;
    p.y = floorY;
    run(map, 2, 0, 0, p);
    run(map, 30, BTN.JET, 0, p);
    expect(p.y).toBeLessThan(floorY - 40);
    expect(p.fuel).toBe(MOVE.fuelMax - 30 * MOVE.fuelBurn);
    run(map, 200, 0, 0, p);
    expect(p.onGround).toBe(true);
    expect(p.fuel).toBe(MOVE.fuelMax);
  });

  it('one-way platforms: pass through going up, land on top, drop with DOWN', () => {
    const p = makePlayerSim();
    p.x = 5 * TILE;
    p.y = floorY;
    run(map, 2, 0, 0, p);
    run(map, 40, BTN.JET, 0, p); // fly up through the platform
    expect(p.y).toBeLessThan(6 * TILE);
    run(map, 120, 0, 0, p); // fall back: lands on the platform
    expect(p.y).toBe(6 * TILE - PLAYER_HH);
    expect(p.onGround).toBe(true);
    run(map, 1, BTN.DOWN, 0, p);
    run(map, 120, 0, 0, p);
    expect(p.y).toBe(floorY);
  });

  it('is deterministic and stays on the quantization grid', () => {
    const a = makePlayerSim();
    a.x = 200;
    a.y = 100;
    const b = copySim(makePlayerSim(), a);
    const cmd = makeInput();
    for (let i = 0; i < 400; i++) {
      cmd.seq = i;
      cmd.moveX = Math.round(Math.sin(i / 17) * 127);
      cmd.buttons = i % 90 < 40 ? BTN.JET : 0;
      cmd.aim = (i * 977) & 0xffff;
      stepPlayer(a, cmd, map);
      stepPlayer(b, cmd, map);
      expect(a.x * 8).toBe(Math.round(a.x * 8));
      expect(a.vy * 16).toBe(Math.round(a.vy * 16));
    }
    expect(b).toEqual(a);
  });

  it('weapon: fire rate, magazine, auto-reload', () => {
    const w = WEAPONS[0];
    const p = makePlayerSim();
    p.x = 300;
    p.y = floorY;
    let shots = 0;
    const cmd = makeInput();
    cmd.buttons = BTN.FIRE;
    for (let i = 0; i < w.intervalTicks * w.magSize; i++) if (stepPlayer(p, cmd, map)) shots++;
    expect(shots).toBe(w.magSize);
    expect(p.ammo).toBe(0);
    expect(p.reload).toBeGreaterThan(0);
    for (let i = 0; i < w.reloadTicks; i++) stepPlayer(p, makeInput(), map);
    expect(p.ammo).toBe(w.magSize);
  });
});

describe('ray casts', () => {
  const map = testMap();
  it('stops at solid tiles and ignores one-way platforms', () => {
    expect(raycastTiles(map, 100, 260, 1, 0, 2000)).toBeCloseTo(14 * TILE - 100, 5);
    expect(raycastTiles(map, 5 * TILE, 300, 0, -1, 2000)).toBeCloseTo(300 - TILE, 5); // through the platform to the ceiling
    expect(raycastTiles(map, 100, 260, 1, 0, 50)).toBe(50);
  });
  it('ray vs box', () => {
    expect(rayAabb(0, 0, 1, 0, 10, -5, 20, 5)).toBe(10);
    expect(rayAabb(0, 0, -1, 0, 10, -5, 20, 5)).toBe(-1);
    expect(rayAabb(0, 0, 0, 1, -5, 10, 5, 20)).toBe(10);
  });
});
