// Procedurally drawn textures (original art, zero image downloads).
// Soldier parts are drawn in light greys so a per-player tint colors them.

import type Phaser from 'phaser';
import { TILE } from '../core/config';
import type { GameMap, MapTheme } from '../core/maps';

type Draw = (c: CanvasRenderingContext2D, w: number, h: number) => void;

function canvasTex(scene: Phaser.Scene, key: string, w: number, h: number, draw: Draw): void {
  if (scene.textures.exists(key)) return;
  const t = scene.textures.createCanvas(key, w, h);
  if (!t) return;
  const c = t.getContext();
  draw(c, w, h);
  t.refresh();
}

function rr(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

export function generateTextures(scene: Phaser.Scene): void {
  canvasTex(scene, 'px', 2, 2, (c) => {
    c.fillStyle = '#fff';
    c.fillRect(0, 0, 2, 2);
  });
  canvasTex(scene, 'dot', 8, 8, (c) => {
    c.fillStyle = '#fff';
    c.beginPath();
    c.arc(4, 4, 3.6, 0, Math.PI * 2);
    c.fill();
  });

  // Torso (tinted): vest with darker belt and strap.
  canvasTex(scene, 'torso', 20, 18, (c) => {
    c.fillStyle = '#f2f2f2';
    rr(c, 1, 0, 18, 17, 5);
    c.fill();
    c.fillStyle = '#b8b8b8';
    c.fillRect(1, 12, 18, 3);
    c.fillStyle = '#d0d0d0';
    c.fillRect(6, 1, 3, 11);
    c.strokeStyle = 'rgba(0,0,0,0.35)';
    c.lineWidth = 1;
    rr(c, 1.5, 0.5, 17, 16, 5);
    c.stroke();
  });

  // Helmet (tinted) with a dark visor.
  canvasTex(scene, 'helmet', 18, 16, (c) => {
    c.fillStyle = '#f2f2f2';
    c.beginPath();
    c.arc(9, 9, 8, Math.PI, 0);
    c.lineTo(17, 13);
    c.lineTo(1, 13);
    c.closePath();
    c.fill();
    c.fillStyle = '#1b2230';
    rr(c, 8, 6, 9, 5, 2);
    c.fill();
    c.fillStyle = 'rgba(160,220,255,0.8)';
    c.fillRect(12, 7, 3, 1);
    c.fillStyle = '#e8c9a0';
    c.fillRect(7, 12, 8, 4);
  });

  // Legs: standing, two run strides, airborne (tinted, dark boots).
  const legs: [number, number, number, number][] = [
    [5, 0, 13, 0],
    [2, 3, 15, -2],
    [7, -2, 10, 3],
    [4, -3, 13, -5],
  ];
  legs.forEach(([lx, ly, rx, ry], i) =>
    canvasTex(scene, `legs${i}`, 20, 16, (c) => {
      for (const [x, dy] of [
        [lx, ly],
        [rx, ry],
      ]) {
        c.fillStyle = '#d6d6d6';
        c.fillRect(x, 0, 5, 12 + Math.min(0, dy));
        c.fillStyle = '#2a2a2a';
        c.fillRect(x - 1 + (dy > 0 ? 1 : 0), 11 + Math.min(0, dy), 7, 4);
      }
    }),
  );

  canvasTex(scene, 'pack', 8, 15, (c) => {
    c.fillStyle = '#5b6170';
    rr(c, 0, 0, 8, 15, 2);
    c.fill();
    c.fillStyle = '#8a92a6';
    c.fillRect(2, 2, 4, 3);
    c.fillStyle = '#3a3f4a';
    c.fillRect(1, 12, 6, 3);
  });

  canvasTex(scene, 'flame', 10, 18, (c) => {
    const g = c.createLinearGradient(0, 0, 0, 18);
    g.addColorStop(0, 'rgba(255,250,200,1)');
    g.addColorStop(0.35, 'rgba(255,190,60,0.95)');
    g.addColorStop(1, 'rgba(255,80,20,0)');
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(1, 0);
    c.quadraticCurveTo(5, 22, 9, 0);
    c.closePath();
    c.fill();
  });

  // Weapons (not tinted). Origin at the grip; barrel points right.
  const guns: Draw[] = [
    (c) => {
      c.fillStyle = '#2b2f36';
      c.fillRect(6, 2, 13, 4);
      c.fillRect(6, 4, 4, 6);
    },
    (c) => {
      c.fillStyle = '#2f3a2f';
      c.fillRect(2, 2, 26, 4);
      c.fillRect(8, 5, 4, 6);
      c.fillRect(15, 5, 3, 5);
      c.fillRect(0, 3, 5, 5);
    },
    (c) => {
      c.fillStyle = '#4a3324';
      c.fillRect(0, 3, 8, 5);
      c.fillStyle = '#2d2d2d';
      c.fillRect(7, 2, 21, 5);
      c.fillRect(10, 6, 9, 3);
    },
    (c) => {
      c.fillStyle = '#2c3440';
      c.fillRect(0, 3, 6, 5);
      c.fillRect(5, 3, 30, 3);
      c.fillRect(14, 0, 9, 3);
      c.fillRect(10, 5, 4, 5);
    },
    (c) => {
      c.fillStyle = '#3d4a2c';
      c.fillRect(2, 1, 28, 7);
      c.fillStyle = '#20251a';
      c.fillRect(28, 0, 4, 9);
      c.fillRect(10, 7, 4, 4);
    },
  ];
  guns.forEach((d, i) =>
    canvasTex(scene, `gun${i}`, 36, 12, (c, w, h) => {
      d(c, w, h);
      c.fillStyle = '#e8c9a0'; // hand
      c.beginPath();
      c.arc(7, 7, 3, 0, Math.PI * 2);
      c.fill();
    }),
  );

  canvasTex(scene, 'flash', 18, 18, (c) => {
    const g = c.createRadialGradient(9, 9, 1, 9, 9, 9);
    g.addColorStop(0, 'rgba(255,255,230,1)');
    g.addColorStop(0.4, 'rgba(255,210,90,0.9)');
    g.addColorStop(1, 'rgba(255,140,40,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 18, 18);
  });
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

/** Tileset frames are extruded by 1 px with 2 px spacing so linear filtering never bleeds between them. */
export const TILESET_MARGIN = 1;
export const TILESET_SPACING = 2;

/** Tileset for a map theme: frame 0 = solid inner, 1 = solid with surface, 2 = one-way platform. */
export function mapTextures(scene: Phaser.Scene, map: GameMap): string {
  const key = `tiles-${map.key}`;
  if (scene.textures.exists(key)) return key;
  const th: MapTheme = map.theme;
  const src = document.createElement('canvas');
  src.width = TILE * 3;
  src.height = TILE;
  ((c: CanvasRenderingContext2D) => {
    const T = TILE;
    // 0: inner
    c.fillStyle = th.ground;
    c.fillRect(0, 0, T, T);
    c.fillStyle = shade(th.ground, 0.85);
    for (let i = 0; i < 5; i++) c.fillRect((i * 7) % (T - 4), (i * 13) % (T - 3), 4, 3);
    c.fillStyle = shade(th.ground, 1.08);
    c.fillRect(3, 20, 5, 3);
    // 1: surface
    c.fillStyle = th.ground;
    c.fillRect(T, 0, T, T);
    c.fillStyle = shade(th.ground, 0.85);
    c.fillRect(T + 18, 18, 5, 4);
    c.fillStyle = th.groundTop;
    c.fillRect(T, 0, T, 8);
    c.fillStyle = shade(th.groundTop, 0.8);
    c.fillRect(T, 7, T, 2);
    c.fillStyle = shade(th.groundTop, 1.15);
    for (let x = 2; x < T; x += 7) c.fillRect(T + x, 1, 3, 2);
    // 2: one-way platform (planks)
    c.fillStyle = th.platform;
    c.fillRect(2 * T, 0, T, 9);
    c.fillStyle = shade(th.platform, 0.7);
    c.fillRect(2 * T, 8, T, 2);
    c.fillRect(2 * T + 15, 0, 2, 9);
    c.fillStyle = shade(th.platform, 1.25);
    c.fillRect(2 * T, 0, T, 2);
  })(src.getContext('2d')!);

  const cell = TILE + TILESET_SPACING;
  canvasTex(scene, key, 3 * cell, cell, (c) => {
    for (let i = 0; i < 3; i++) {
      const x = TILESET_MARGIN + i * cell;
      const y = TILESET_MARGIN;
      // Extrude: draw the frame shifted by 1 px in every direction, then on top.
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]]) {
        c.drawImage(src, i * TILE, 0, TILE, TILE, x + dx, y + dy, TILE, TILE);
      }
    }
  });
  return key;
}

/** Far background silhouettes for the parallax layer, as a data URL for CSS. */
export function farLayerDataUrl(map: GameMap): string {
  const w = 640;
  const h = 260;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const c = cv.getContext('2d')!;
  c.fillStyle = map.theme.far;
  if (map.key === 'desert') {
    c.beginPath();
    c.moveTo(0, h);
    for (let x = 0; x <= w; x += 20) c.lineTo(x, h - 70 - 45 * Math.sin(x / 90) - 25 * Math.sin(x / 37));
    c.lineTo(w, h);
    c.fill();
    c.fillRect(420, h - 160, 18, 70); // mesa / cactus shapes
    c.fillRect(408, h - 140, 42, 10);
  } else if (map.key === 'jungle') {
    for (let i = 0; i < 9; i++) {
      const x = i * 75 + 20;
      c.fillRect(x, h - 150, 10, 150);
      c.beginPath();
      c.arc(x + 5, h - 160, 42, 0, Math.PI * 2);
      c.fill();
    }
  } else {
    for (let x = 0; x < w; x += 64) {
      c.fillRect(x, 0, 10, h);
      c.fillRect(x, 40, 64, 6);
      c.fillRect(x, h - 60, 64, 6);
    }
  }
  return cv.toDataURL('image/png');
}
