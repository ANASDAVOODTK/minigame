// TEST AUTOMATION ONLY (?bot=1): drives this browser's own player so automated
// multi-browser tests produce real movement and shooting over real WebRTC links.
// It is always labelled "TEST BOT" in the HUD and is never presented as a person.

import { SHOULDER_Y } from '../core/config';
import { BTN, aimFromAngle, quantizeMove, type InputState } from '../core/input';
import { raycastTiles } from '../core/physics';
import { F_ALIVE } from '../core/snapshot';
import type { ControlView, Controls } from './controls';

export class BotControls implements Controls {
  readonly state: InputState = { buttons: 0, moveX: 0, aim: 0 };
  readonly label = 'TEST BOT';
  private dir = 1;
  private nextTurn = 0;
  private lastX = 0;
  private stuckMs = 0;
  private lastNow = 0;
  private enabled = true;

  update(now: number, v: ControlView): void {
    const dt = this.lastNow ? now - this.lastNow : 16;
    this.lastNow = now;
    const me = v.local;
    this.state.buttons = 0;
    this.state.moveX = 0;
    if (!this.enabled || !me || !(me.flags & F_ALIVE) || !v.map) return;

    // Wander, turning around periodically or when stuck against a wall.
    if (now > this.nextTurn) {
      this.dir = Math.random() < 0.5 ? -1 : 1;
      this.nextTurn = now + 1500 + Math.random() * 2500;
    }
    this.stuckMs = Math.abs(me.x - this.lastX) < 0.5 ? this.stuckMs + dt : 0;
    this.lastX = me.x;
    let b = 0;
    if (this.stuckMs > 400) {
      b |= BTN.JET;
      if (this.stuckMs > 1200) {
        this.dir = -this.dir;
        this.stuckMs = 0;
      }
    }
    if (Math.sin(now / 900) > 0.6) b |= BTN.JET;

    // Target the nearest visible enemy.
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < v.count; i++) {
      const o = v.players[i];
      if (o.local || !(o.flags & F_ALIVE)) continue;
      const d = Math.hypot(o.x - me.x, o.y - me.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      const o = v.players[best];
      const ox = me.x;
      const oy = me.y + SHOULDER_Y;
      const a = Math.atan2(o.y - oy, o.x - ox) + (Math.random() - 0.5) * 0.08;
      this.state.aim = aimFromAngle(a);
      const wall = raycastTiles(v.map, ox, oy, Math.cos(a), Math.sin(a), bestD);
      if (bestD < 750 && wall >= bestD - 12) b |= BTN.FIRE;
      if (bestD > 350) this.dir = o.x > me.x ? 1 : -1;
      if (o.y < me.y - 80) b |= BTN.JET;
    } else {
      this.state.aim = aimFromAngle(this.dir > 0 ? 0 : Math.PI);
    }
    this.state.buttons = b;
    this.state.moveX = quantizeMove(this.dir);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  dispose(): void {}
}
