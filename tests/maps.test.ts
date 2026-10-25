import { describe, expect, it } from 'vitest';
import { MAPS, MAX_PLAYERS } from '@minimi/shared';
import { PLAYER_HH, PLAYER_HW, TILE } from '../client/src/core/config';
import { T_EMPTY, T_SOLID, getMap } from '../client/src/core/maps';
import { tileAt } from '../client/src/core/physics';

describe('maps', () => {
  for (const meta of MAPS) {
    describe(meta.name, () => {
      const m = getMap(meta.id);

      it('matches the shared map list and fits the wire format', () => {
        expect(m.key).toBe(meta.key);
        expect(m.pxW).toBeLessThan(8191);
        expect(m.pxH).toBeLessThan(8191);
      });

      it('is enclosed by solid tiles', () => {
        for (let x = 0; x < m.w; x++) {
          expect(tileAt(m, x, 0)).toBe(T_SOLID);
          expect(tileAt(m, x, m.h - 1)).toBe(T_SOLID);
        }
        for (let y = 0; y < m.h; y++) {
          expect(tileAt(m, 0, y)).toBe(T_SOLID);
          expect(tileAt(m, m.w - 1, y)).toBe(T_SOLID);
        }
      });

      it(`has at least ${MAX_PLAYERS} valid spawn points standing on ground`, () => {
        expect(m.spawns.length).toBeGreaterThanOrEqual(MAX_PLAYERS);
        for (const s of m.spawns) {
          // Hitbox is free of solid tiles...
          for (let y = s.y - PLAYER_HH; y < s.y + PLAYER_HH; y += 4) {
            for (const x of [s.x - PLAYER_HW, s.x + PLAYER_HW - 1]) {
              expect(tileAt(m, Math.floor(x / TILE), Math.floor(y / TILE))).not.toBe(T_SOLID);
            }
          }
          // ...and there is ground (solid or platform) right below the feet.
          const below = tileAt(m, Math.floor(s.x / TILE), Math.floor((s.y + PLAYER_HH) / TILE));
          expect(below).not.toBe(T_EMPTY);
        }
      });
    });
  }
});
