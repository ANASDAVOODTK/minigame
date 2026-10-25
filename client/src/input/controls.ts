// Player input: keyboard + mouse and touch (two floating joysticks + buttons),
// merged into one InputState that the match samples every simulation tick.
//
// Desktop: A/D move, W/Space jetpack, S drop through platforms, mouse aim,
//          left click fire, R reload, G grenade, Q/E switch weapon.
// Touch:   left stick = move (push up = jetpack, down = drop), right stick = aim
//          (push to the edge = fire), plus FIRE / JET / RELOAD buttons.

import { BTN, aimFromAngle, quantizeMove, type InputState } from '../core/input';
import type { GameMap } from '../core/maps';
import type { RenderPlayer } from '../core/view';

export interface ControlView {
  /** Local player's shoulder in viewport CSS pixels (mouse aim origin). */
  originX: number;
  originY: number;
  local: RenderPlayer | null;
  players: RenderPlayer[];
  count: number;
  map: GameMap | null;
}

export interface Controls {
  readonly state: InputState;
  readonly label: string;
  update(now: number, view: ControlView): void;
  setEnabled(on: boolean): void;
  dispose(): void;
}

const STICK_RADIUS = 56;

class Stick {
  pointerId = -1;
  dx = 0;
  dy = 0;
  private cx = 0;
  private cy = 0;
  private base: HTMLDivElement;
  private knob: HTMLDivElement;

  constructor(private zone: HTMLElement) {
    this.base = document.createElement('div');
    this.base.className = 'stick-base';
    this.knob = document.createElement('div');
    this.knob.className = 'stick-knob';
    this.base.appendChild(this.knob);
    zone.appendChild(this.base);
    zone.addEventListener('pointerdown', this.down);
    zone.addEventListener('pointermove', this.move);
    zone.addEventListener('pointerup', this.up);
    zone.addEventListener('pointercancel', this.up);
    zone.addEventListener('lostpointercapture', this.up);
  }

  get mag(): number {
    return Math.hypot(this.dx, this.dy);
  }

  private down = (e: PointerEvent) => {
    if (this.pointerId !== -1) return;
    e.preventDefault();
    this.pointerId = e.pointerId;
    try {
      this.zone.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const r = this.zone.getBoundingClientRect();
    this.cx = e.clientX;
    this.cy = e.clientY;
    this.base.style.transform = `translate(${this.cx - r.left - STICK_RADIUS}px, ${this.cy - r.top - STICK_RADIUS}px)`;
    this.base.classList.add('on');
    this.set(e);
  };

  private move = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return;
    e.preventDefault();
    this.set(e);
  };

  private up = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = -1;
    this.dx = this.dy = 0;
    this.knob.style.transform = '';
    this.base.classList.remove('on');
  };

  private set(e: PointerEvent): void {
    let dx = (e.clientX - this.cx) / STICK_RADIUS;
    let dy = (e.clientY - this.cy) / STICK_RADIUS;
    const m = Math.hypot(dx, dy);
    if (m > 1) {
      dx /= m;
      dy /= m;
    }
    this.dx = dx;
    this.dy = dy;
    this.knob.style.transform = `translate(${dx * STICK_RADIUS}px, ${dy * STICK_RADIUS}px)`;
  }

  reset(): void {
    this.pointerId = -1;
    this.dx = this.dy = 0;
    this.knob.style.transform = '';
    this.base.classList.remove('on');
  }
}

export class PlayerControls implements Controls {
  readonly state: InputState = { buttons: 0, moveX: 0, aim: 0 };
  readonly label = '';
  private keys = new Set<string>();
  private mouseX = -1;
  private mouseY = -1;
  private mouseFire = false;
  private mouseActive = false;
  private aimAngle = 0;
  private enabled = true;
  private touchRoot: HTMLElement;
  private left: Stick;
  private right: Stick;
  private held = new Map<string, number>(); // touch button -> pointerId
  private reloadPulseUntil = 0;
  touchMode: boolean;

  constructor(
    private canvasHost: HTMLElement,
    touchLayer: HTMLElement,
  ) {
    this.touchRoot = touchLayer;
    this.touchMode = matchMedia('(pointer: coarse)').matches;
    touchLayer.innerHTML = `
      <div class="zone zone-left"></div>
      <div class="zone zone-right"></div>
      <button class="tbtn tbtn-jet" data-b="jet" aria-label="Jetpack">JET</button>
      <button class="tbtn tbtn-fire" data-b="fire" aria-label="Fire">FIRE</button>
      <button class="tbtn tbtn-reload" data-b="reload" aria-label="Reload">R</button>`;
    this.left = new Stick(touchLayer.querySelector('.zone-left')!);
    this.right = new Stick(touchLayer.querySelector('.zone-right')!);
    touchLayer.querySelectorAll<HTMLButtonElement>('.tbtn').forEach((b) => {
      const name = b.dataset.b!;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.held.set(name, e.pointerId);
        b.classList.add('on');
        if (name === 'reload') this.reloadPulseUntil = performance.now() + 120;
      });
      const release = (e: PointerEvent) => {
        if (this.held.get(name) === e.pointerId) {
          this.held.delete(name);
          b.classList.remove('on');
        }
      };
      b.addEventListener('pointerup', release);
      b.addEventListener('pointercancel', release);
      b.addEventListener('pointerleave', release);
      b.addEventListener('contextmenu', (e) => e.preventDefault());
    });
    touchLayer.classList.toggle('show', this.touchMode);

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.clear);
    canvasHost.addEventListener('pointermove', this.onPointerMove);
    canvasHost.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('touchstart', this.onFirstTouch, { passive: true, once: true });
    canvasHost.addEventListener('contextmenu', this.preventMenu);
  }

  private preventMenu = (e: Event) => e.preventDefault();

  private onFirstTouch = () => {
    this.touchMode = true;
    this.touchRoot.classList.add('show');
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.enabled || (e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private onPointerMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
    this.mouseActive = true;
  };

  private onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    this.mouseFire = true;
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
    this.mouseActive = true;
  };

  private onPointerUp = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button === 0) this.mouseFire = false;
  };

  private clear = () => {
    this.keys.clear();
    this.mouseFire = false;
    this.held.clear();
    this.left.reset();
    this.right.reset();
  };

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.clear();
  }

  update(now: number, view: ControlView): void {
    const k = this.keys;
    let b = 0;
    let mx = 0;
    if (!this.enabled) {
      this.state.buttons = 0;
      this.state.moveX = 0;
      return;
    }
    // Keyboard.
    if (k.has('KeyA') || k.has('ArrowLeft')) mx -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) mx += 1;
    if (k.has('KeyW') || k.has('ArrowUp') || k.has('Space')) b |= BTN.JET;
    if (k.has('KeyS') || k.has('ArrowDown')) b |= BTN.DOWN;
    if (k.has('KeyR')) b |= BTN.RELOAD;
    if (k.has('KeyG')) b |= BTN.GRENADE;
    if (k.has('KeyQ') || k.has('KeyE')) b |= BTN.SWITCH;
    if (this.mouseFire) b |= BTN.FIRE;

    // Touch: left stick moves (up = jet, down = drop).
    const L = this.left;
    if (L.pointerId !== -1) {
      if (Math.abs(L.dx) > 0.15) mx = L.dx;
      if (L.dy < -0.5) b |= BTN.JET;
      if (L.dy > 0.65) b |= BTN.DOWN;
    }
    // Right stick aims; pushed to the edge = fire.
    const R = this.right;
    if (R.pointerId !== -1 && R.mag > 0.25) {
      this.aimAngle = Math.atan2(R.dy, R.dx);
      if (R.mag > 0.85) b |= BTN.FIRE;
    } else if (this.mouseActive && view.local) {
      this.aimAngle = Math.atan2(this.mouseY - view.originY, this.mouseX - view.originX);
    }
    if (this.held.has('fire')) b |= BTN.FIRE;
    if (this.held.has('jet')) b |= BTN.JET;
    if (this.held.has('reload') || now < this.reloadPulseUntil) b |= BTN.RELOAD;

    this.state.buttons = b;
    this.state.moveX = quantizeMove(Math.max(-1, Math.min(1, mx)));
    this.state.aim = aimFromAngle(this.aimAngle);
  }

  /** True while the scoreboard key is held. */
  scoreboardHeld(): boolean {
    return this.keys.has('Tab');
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.clear);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('touchstart', this.onFirstTouch);
    this.canvasHost.removeEventListener('pointermove', this.onPointerMove);
    this.canvasHost.removeEventListener('pointerdown', this.onPointerDown);
    this.canvasHost.removeEventListener('contextmenu', this.preventMenu);
    this.touchRoot.innerHTML = '';
    this.touchRoot.classList.remove('show');
  }
}
