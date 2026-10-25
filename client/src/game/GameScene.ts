// Renders a running match. All game logic lives in core/ (MatchView); this
// scene only draws interpolated/predicted state and cosmetic effects.
// Object pools everywhere: no allocation in the per-frame path.

import Phaser from 'phaser';
import { PLAYER_COLORS } from '@minimi/shared';
import { SHOULDER_Y, SLOTS, TILE } from '../core/config';
import { angleFromAim } from '../core/input';
import { T_PLATFORM, T_SOLID, type GameMap } from '../core/maps';
import { F_ALIVE, F_DISCONNECTED, F_GROUND, F_JET, F_PROTECT, SHOT_HIT } from '../core/snapshot';
import {
  FX_DAMAGED,
  FX_HIT_CONFIRM,
  FX_KILL,
  FX_SPAWN,
  FX_TRACER,
  makeHudInfo,
  makeNetInfo,
  makeRenderPlayer,
  type FxEvent,
  type MatchView,
  type RenderPlayer,
} from '../core/view';
import type { ControlView, Controls } from '../input/controls';
import type { Hud } from '../ui/hud';
import type { Quality } from './quality';
import type { Sfx } from './sfx';
import { TILESET_MARGIN, TILESET_SPACING, farLayerDataUrl, generateTextures, mapTextures } from './textures';

export interface PlayerInfo {
  name: string;
  color: number;
}

export interface SceneContext {
  match: MatchView;
  info(id: number): PlayerInfo | null;
  controls: Controls;
  hud: Hud;
  sfx: Sfx;
  quality: Quality;
  /** DOM layer behind the (transparent) canvas: sky gradient + parallax. */
  backdrop: HTMLElement;
}

/** Muzzle distance from the grip, per weapon. */
const MUZZLE = [13, 21, 21, 28, 25];
const MAX_TRACERS = 40;
const CAMERA_MARGIN_X = 320;
const CAMERA_MARGIN_Y = 160;

const colorNum = (i: number) => parseInt((PLAYER_COLORS[i] ?? PLAYER_COLORS[0]).slice(1), 16);
function darker(c: number, k: number): number {
  return (Math.round(((c >> 16) & 255) * k) << 16) | (Math.round(((c >> 8) & 255) * k) << 8) | Math.round((c & 255) * k);
}

class PlayerView {
  readonly root: Phaser.GameObjects.Container;
  readonly legs: Phaser.GameObjects.Image;
  readonly torso: Phaser.GameObjects.Image;
  readonly helmet: Phaser.GameObjects.Image;
  readonly pack: Phaser.GameObjects.Image;
  readonly flame: Phaser.GameObjects.Image;
  readonly gun: Phaser.GameObjects.Image;
  readonly label: Phaser.GameObjects.Text;
  readonly hpBg: Phaser.GameObjects.Image;
  readonly hpFg: Phaser.GameObjects.Image;
  readonly flash: Phaser.GameObjects.Image;
  name = '';
  color = -1;
  weapon = -1;
  runPhase = 0;
  flashUntil = 0;
  shown = false;
  x = 0;
  y = 0;
  aim = 0;

  constructor(scene: Phaser.Scene) {
    this.flame = scene.add.image(-8, 4, 'flame').setOrigin(0.5, 0).setVisible(false);
    this.pack = scene.add.image(-8, -3, 'pack');
    this.legs = scene.add.image(0, 12, 'legs0');
    this.torso = scene.add.image(0, -2, 'torso');
    this.helmet = scene.add.image(1, -13, 'helmet');
    this.gun = scene.add.image(0, SHOULDER_Y, 'gun0').setOrigin(7 / 36, 7 / 12);
    this.root = scene.add
      .container(0, 0, [this.flame, this.pack, this.legs, this.torso, this.helmet, this.gun])
      .setDepth(20)
      .setVisible(false);
    this.label = scene.add
      .text(0, 0, '', { fontFamily: 'system-ui, sans-serif', fontSize: '11px', color: '#ffffff', stroke: '#000000', strokeThickness: 3 })
      .setOrigin(0.5, 1)
      .setDepth(30)
      .setVisible(false);
    this.hpBg = scene.add.image(0, 0, 'px').setOrigin(0, 0.5).setDisplaySize(28, 5).setTint(0x000000).setAlpha(0.6).setDepth(30).setVisible(false);
    this.hpFg = scene.add.image(0, 0, 'px').setOrigin(0, 0.5).setDisplaySize(26, 3).setDepth(31).setVisible(false);
    this.flash = scene.add.image(0, 0, 'flash').setDepth(26).setVisible(false).setBlendMode(Phaser.BlendModes.ADD);
  }

  show(on: boolean): void {
    if (this.shown === on) return;
    this.shown = on;
    this.root.setVisible(on);
    this.hpBg.setVisible(on);
    this.hpFg.setVisible(on);
    this.label.setVisible(on && this.name !== '');
    if (!on) this.flash.setVisible(false);
  }

  setIdentity(name: string, color: number, local: boolean): void {
    if (color !== this.color) {
      this.color = color;
      const c = colorNum(color);
      this.torso.setTint(c);
      this.helmet.setTint(c);
      this.legs.setTint(darker(c, 0.7));
    }
    const label = local ? '' : name;
    if (label !== this.name) {
      this.name = label;
      this.label.setText(label);
      this.label.setVisible(this.shown && label !== '');
    }
  }
}

interface Tracer {
  img: Phaser.GameObjects.Image;
  start: number;
  dur: number;
}

interface Particle {
  img: Phaser.GameObjects.Image;
  vx: number;
  vy: number;
  g: number;
  life: number;
  max: number;
}

export class GameScene extends Phaser.Scene {
  private ctx!: SceneContext;
  private views: PlayerView[] = [];
  private render: RenderPlayer[] = [];
  private tracers: Tracer[] = [];
  private tracerNext = 0;
  private particles: Particle[] = [];
  private particleNext = 0;
  private tilemap: Phaser.Tilemaps.Tilemap | null = null;
  private outside: Phaser.GameObjects.Rectangle[] = [];
  private mapId = -1;
  private far: HTMLElement | null = null;
  private camX = 0;
  private camY = 0;
  private camInit = false;
  private lastFrame = 0;
  private hudAt = 0;
  private hudInfo = makeHudInfo();
  private netInfo = makeNetInfo();
  private local: RenderPlayer | null = null;
  private canvasRect = { left: 0, top: 0, sx: 1, sy: 1 };
  private view: ControlView = { originX: 0, originY: 0, local: null, players: [], count: 0, map: null };

  constructor() {
    super('game');
  }

  init(data: SceneContext): void {
    this.ctx = data;
    this.views = [];
    this.render = [];
    this.tracers = [];
    this.particles = [];
    this.tilemap = null;
    this.outside = [];
    this.mapId = -1;
    this.camInit = false;
    this.lastFrame = 0;
    this.local = null;
  }

  create(): void {
    generateTextures(this);
    this.views.push(null as unknown as PlayerView); // index 0 unused (ids are 1..8)
    for (let i = 1; i < SLOTS; i++) this.views.push(new PlayerView(this));
    for (let i = 0; i < SLOTS; i++) this.render.push(makeRenderPlayer());
    for (let i = 0; i < MAX_TRACERS; i++) {
      const img = this.add.image(0, 0, 'px').setOrigin(0, 0.5).setDepth(25).setVisible(false);
      this.tracers.push({ img, start: 0, dur: 0 });
    }
    for (let i = 0; i < 96; i++) {
      const img = this.add.image(0, 0, 'dot').setDepth(27).setVisible(false);
      this.particles.push({ img, vx: 0, vy: 0, g: 0, life: 0, max: 1 });
    }
    this.view.players = this.render;
    this.far = this.ctx.backdrop.querySelector('.far');
    this.scale.on('resize', this.onResize, this);
    this.events.once('shutdown', () => {
      this.scale.off('resize', this.onResize, this);
      this.ctx.sfx.mute();
    });
    this.onResize();
  }

  private onResize(): void {
    const w = this.scale.width;
    const h = this.scale.height;
    // Similar visible world area on every screen (fairness), ~1150 x 640 px.
    const zoom = Math.min(2.5, Math.max(0.4, Math.max(h / 640, w / 1150)));
    this.cameras.main.setZoom(zoom);
    const r = this.game.canvas.getBoundingClientRect();
    this.canvasRect.left = r.left;
    this.canvasRect.top = r.top;
    this.canvasRect.sx = r.width / Math.max(1, this.game.canvas.width);
    this.canvasRect.sy = r.height / Math.max(1, this.game.canvas.height);
  }

  override update(): void {
    const now = performance.now();
    const dt = this.lastFrame ? Math.min(100, now - this.lastFrame) : 16.7;
    this.lastFrame = now;
    const m = this.ctx.match;

    // Input first (uses last frame's camera), then simulate/network, then draw.
    const cam = this.cameras.main;
    const v = this.view;
    v.local = this.local;
    v.map = m.map;
    if (this.local) {
      const sx = (this.local.x - cam.worldView.x) * cam.zoom;
      const sy = (this.local.y + SHOULDER_Y - cam.worldView.y) * cam.zoom;
      v.originX = this.canvasRect.left + sx * this.canvasRect.sx;
      v.originY = this.canvasRect.top + sy * this.canvasRect.sy;
    }
    this.ctx.controls.update(now, v);
    m.update(now, this.ctx.controls.state);

    if (m.map && m.map.id !== this.mapId) this.buildMap(m.map);
    const n = m.collectPlayers(this.render);
    v.count = n;
    this.local = null;
    for (let i = 0; i < n; i++) if (this.render[i].local) this.local = this.render[i];
    // Show the live aim for our own soldier (no tick latency on the gun).
    if (this.local && this.local.flags & F_ALIVE) this.local.aim = this.ctx.controls.state.aim;

    this.drawPlayers(n, now, dt);
    this.updateCamera(dt);
    m.fx.drain(this.onFx);
    this.updateEffects(now, dt);
    this.ctx.sfx.jet(this.local && this.local.flags & F_JET ? 1 : 0);
    this.ctx.quality.frame(dt);

    if (now - this.hudAt > 100) {
      this.hudAt = now;
      m.hud(this.hudInfo);
      m.net(this.netInfo);
      this.ctx.hud.update(this.hudInfo, this.netInfo, this.ctx.quality.fps);
    }
  }

  private buildMap(map: GameMap): void {
    this.mapId = map.id;
    this.tilemap?.destroy();
    for (const r of this.outside) r.destroy();
    this.outside = [];
    const key = mapTextures(this, map);
    const data: number[][] = [];
    for (let y = 0; y < map.h; y++) {
      const row: number[] = [];
      for (let x = 0; x < map.w; x++) {
        const t = map.tiles[y * map.w + x];
        if (t === T_SOLID) row.push(y > 0 && map.tiles[(y - 1) * map.w + x] === T_SOLID ? 0 : 1);
        else if (t === T_PLATFORM) row.push(2);
        else row.push(-1);
      }
      data.push(row);
    }
    this.tilemap = this.make.tilemap({ data, tileWidth: TILE, tileHeight: TILE });
    const ts = this.tilemap.addTilesetImage(key, key, TILE, TILE, TILESET_MARGIN, TILESET_SPACING);
    if (ts) this.tilemap.createLayer(0, ts, 0, 0)?.setDepth(10);
    // Let the camera look a little past the map edges so a player standing at the edge is
    // never pinned to a screen corner (under the touch buttons).
    this.cameras.main.setBounds(-CAMERA_MARGIN_X, -CAMERA_MARGIN_Y, map.pxW + 2 * CAMERA_MARGIN_X, map.pxH + 2 * CAMERA_MARGIN_Y);
    // Solid ground continues below the map (and all around for enclosed maps).
    const ground = parseInt(map.theme.ground.slice(1), 16);
    const mx = CAMERA_MARGIN_X + 64;
    const my = CAMERA_MARGIN_Y + 64;
    const fill = (x: number, y: number, w: number, h: number) =>
      this.outside.push(this.add.rectangle(x, y, w, h, ground).setOrigin(0).setDepth(9));
    fill(-mx, map.pxH, map.pxW + 2 * mx, my);
    if (map.theme.dark) {
      fill(-mx, -my, map.pxW + 2 * mx, my);
      fill(-mx, 0, mx, map.pxH);
      fill(map.pxW, 0, mx, map.pxH);
    }

    const bd = this.ctx.backdrop;
    bd.style.setProperty('--sky-top', map.theme.skyTop);
    bd.style.setProperty('--sky-bottom', map.theme.skyBottom);
    if (this.far) {
      this.far.style.backgroundImage = `url(${farLayerDataUrl(map)})`;
      this.far.style.display = this.ctx.quality.level === 'high' ? '' : 'none';
    }
  }

  private drawPlayers(n: number, now: number, dt: number): void {
    const seen = this.seen;
    seen.fill(0);
    for (let i = 0; i < n; i++) {
      const r = this.render[i];
      const v = this.views[r.id];
      if (!v) continue;
      seen[r.id] = 1;
      const info = this.ctx.info(r.id);
      v.setIdentity(info?.name ?? `P${r.id}`, info?.color ?? 0, r.local);
      const alive = (r.flags & F_ALIVE) !== 0;
      v.show(alive);
      if (!alive) continue;

      const a = angleFromAim(r.aim);
      const left = Math.cos(a) < 0;
      v.x = r.x;
      v.y = r.y;
      v.aim = a;
      v.root.setPosition(r.x, r.y);
      v.root.scaleX = left ? -1 : 1;
      v.gun.rotation = left ? Math.PI - a : a;
      if (v.weapon !== r.weapon) {
        v.weapon = r.weapon;
        v.gun.setTexture(`gun${r.weapon}`);
      }

      let frame = 'legs0';
      if (!(r.flags & F_GROUND)) frame = 'legs3';
      else if (Math.abs(r.vx) > 25) {
        v.runPhase += (Math.abs(r.vx) * dt) / 1000 / 18;
        frame = Math.floor(v.runPhase) & 1 ? 'legs1' : 'legs2';
      }
      if (v.legs.texture.key !== frame) v.legs.setTexture(frame);

      const jet = (r.flags & F_JET) !== 0;
      v.flame.setVisible(jet);
      if (jet) {
        v.flame.scaleY = 0.75 + Math.random() * 0.5;
        if (this.ctx.quality.level === 'high' && Math.random() < 0.35) this.puff(r.x - (left ? -8 : 8), r.y + 14);
      }

      let alpha = 1;
      if (r.flags & F_DISCONNECTED) alpha = 0.35;
      else if (r.flags & F_PROTECT) alpha = 0.45 + 0.35 * (0.5 + 0.5 * Math.sin(now / 70));
      v.root.setAlpha(alpha);

      v.label.setPosition(r.x, r.y - 30);
      v.hpBg.setPosition(r.x - 14, r.y - 27);
      v.hpFg.setPosition(r.x - 13, r.y - 27);
      const hp = Math.max(0, Math.min(100, r.hp));
      v.hpFg.setDisplaySize(Math.max(0.01, 26 * (hp / 100)), 3);
      v.hpFg.setTint(hp > 60 ? 0x4ade80 : hp > 30 ? 0xfacc15 : 0xef4444);

      if (now < v.flashUntil) {
        const md = MUZZLE[r.weapon] ?? 14;
        v.flash.setPosition(r.x + Math.cos(a) * md, r.y + SHOULDER_Y + Math.sin(a) * md).setVisible(true);
        v.flash.setScale(0.7 + Math.random() * 0.5);
      } else if (v.flash.visible) v.flash.setVisible(false);
    }
    for (let id = 1; id < SLOTS; id++) if (!seen[id]) this.views[id].show(false);
  }

  private seen = new Uint8Array(SLOTS);

  private updateCamera(dt: number): void {
    const cam = this.cameras.main;
    const m = this.ctx.match.map;
    let tx = m ? m.pxW / 2 : 0;
    let ty = m ? m.pxH / 2 : 0;
    const l = this.local;
    if (l) {
      const a = angleFromAim(l.aim);
      tx = l.x + Math.cos(a) * 70;
      ty = l.y + Math.sin(a) * 45;
    }
    if (!this.camInit && l) {
      this.camX = tx;
      this.camY = ty;
      this.camInit = true;
    }
    const k = 1 - Math.exp(-dt / 110);
    this.camX += (tx - this.camX) * k;
    this.camY += (ty - this.camY) * k;
    cam.centerOn(this.camX, this.camY);
    if (this.far && this.far.style.display !== 'none') {
      const off = -((cam.scrollX * 0.25) % 640);
      this.far.style.transform = `translate3d(${off.toFixed(1)}px,0,0)`;
    }
  }

  private onFx = (e: FxEvent): void => {
    switch (e.kind) {
      case FX_TRACER:
        this.tracer(e);
        break;
      case FX_KILL: {
        const v = this.views[e.other];
        if (v && v.shown) this.burst(v.x, v.y, colorNum(v.color), 14);
        const killer = this.ctx.info(e.id)?.name ?? `P${e.id}`;
        const victim = this.ctx.info(e.other)?.name ?? `P${e.other}`;
        const me = this.ctx.match.myId;
        this.ctx.hud.killFeed(killer, victim, e.weapon, (e.flags & 1) !== 0, e.id === me, e.other === me);
        if (e.id === me && e.other !== me) this.ctx.sfx.kill();
        break;
      }
      case FX_HIT_CONFIRM:
        this.ctx.hud.hitMarker((e.flags & 2) !== 0);
        this.ctx.sfx.hit();
        break;
      case FX_DAMAGED:
        this.ctx.hud.damage(e.value);
        this.ctx.sfx.hurt();
        break;
      case FX_SPAWN:
        if (e.id === this.ctx.match.myId) this.camInit = false;
        break;
    }
  };

  private tracer(e: FxEvent): void {
    const dx = e.x1 - e.x0;
    const dy = e.y1 - e.y0;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;
    const ux = dx / len;
    const uy = dy / len;
    const md = MUZZLE[e.weapon] ?? 14;
    let sx = e.x0 + ux * md;
    let sy = e.y0 + uy * md;
    const v = this.views[e.id];
    if (v && v.shown && !e.local) {
      // Remote shooter: start at the gun as it is drawn right now.
      sx = v.x + ux * md;
      sy = v.y + SHOULDER_Y + uy * md;
    }
    if (v) v.flashUntil = performance.now() + 45;
    const rest = Math.hypot(e.x1 - sx, e.y1 - sy);
    const t = this.tracers[this.tracerNext];
    this.tracerNext = (this.tracerNext + 1) % MAX_TRACERS;
    t.img
      .setPosition(sx, sy)
      .setRotation(Math.atan2(e.y1 - sy, e.x1 - sx))
      .setDisplaySize(Math.max(1, rest), e.weapon === 3 ? 2.5 : 1.6)
      .setTint(e.local ? 0xfff2a8 : 0xffd27a)
      .setAlpha(1)
      .setVisible(true);
    t.start = performance.now();
    t.dur = e.weapon === 3 ? 220 : 90;
    if (e.flags & SHOT_HIT) this.burst(e.x1, e.y1, 0xd62f2f, 4);
    else this.sparks(e.x1, e.y1, ux, uy);

    const me = this.local;
    const dist = me ? Math.hypot(e.x0 - me.x, e.y0 - me.y) : 0;
    this.ctx.sfx.shot(e.weapon, e.id === this.ctx.match.myId ? 1 : Math.max(0, 1 - dist / 1400) * 0.7);
  }

  private spawnParticle(x: number, y: number, vx: number, vy: number, g: number, life: number, tint: number, scale: number): void {
    if (this.particleNext >= this.ctx.quality.maxParticles) this.particleNext = 0;
    const p = this.particles[this.particleNext++];
    p.img.setPosition(x, y).setTint(tint).setScale(scale).setAlpha(1).setVisible(true);
    p.vx = vx;
    p.vy = vy;
    p.g = g;
    p.life = p.max = life;
  }

  private sparks(x: number, y: number, ux: number, uy: number): void {
    const n = this.ctx.quality.level === 'high' ? 4 : 2;
    for (let i = 0; i < n; i++) {
      const a = Math.atan2(-uy, -ux) + (Math.random() - 0.5) * 1.6;
      const s = 80 + Math.random() * 160;
      this.spawnParticle(x, y, Math.cos(a) * s, Math.sin(a) * s, 600, 220, 0xffe08a, 0.45);
    }
  }

  private burst(x: number, y: number, tint: number, count: number): void {
    const n = this.ctx.quality.level === 'high' ? count : Math.ceil(count / 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 60 + Math.random() * 200;
      this.spawnParticle(x, y, Math.cos(a) * s, Math.sin(a) * s - 80, 700, 420 + Math.random() * 300, tint, 0.5 + Math.random() * 0.5);
    }
  }

  private puff(x: number, y: number): void {
    this.spawnParticle(x, y, (Math.random() - 0.5) * 30, 60 + Math.random() * 40, -40, 380, 0xc8c8c8, 0.6);
  }

  private updateEffects(now: number, dt: number): void {
    for (const t of this.tracers) {
      if (!t.img.visible) continue;
      const k = (now - t.start) / t.dur;
      if (k >= 1) t.img.setVisible(false);
      else t.img.setAlpha(1 - k);
    }
    const s = dt / 1000;
    for (const p of this.particles) {
      if (!p.img.visible) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.img.setVisible(false);
        continue;
      }
      p.vy += p.g * s;
      p.img.x += p.vx * s;
      p.img.y += p.vy * s;
      p.img.alpha = p.life / p.max;
    }
  }
}
