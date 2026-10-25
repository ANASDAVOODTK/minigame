// Deterministic network simulator: runs the real HostMatch + ClientMatch code
// over simulated links with latency, jitter and packet loss. No browser needed.

import { ClientMatch } from '../../client/src/core/client';
import { TICK_MS } from '../../client/src/core/config';
import { HostMatch } from '../../client/src/core/host';
import { BTN, aimFromAngle, type InputState } from '../../client/src/core/input';
import type { PeerTransport } from '../../client/src/core/transport';
import { makeHudInfo, makeNetInfo, makeRenderPlayer, type RenderPlayer } from '../../client/src/core/view';
import { F_ALIVE } from '../../client/src/core/snapshot';

export interface LinkConditions {
  /** Round-trip latency added by the network (split evenly per direction). */
  rttMs: number;
  /** Random extra one-way delay, uniformly 0..jitterMs. */
  jitterMs: number;
  /** Unreliable-channel loss probability 0..1. Lost reliable messages are retransmitted (one extra RTT). */
  loss: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Scheduled {
  at: number;
  seq: number;
  fn: () => void;
}

export class SimNet {
  now = 0;
  private q: Scheduled[] = [];
  private seq = 0;
  readonly rand: () => number;

  constructor(seed: number) {
    this.rand = mulberry32(seed);
  }

  schedule(delayMs: number, fn: () => void): void {
    this.q.push({ at: this.now + delayMs, seq: this.seq++, fn });
  }

  runUntil(t: number): void {
    for (;;) {
      let best = -1;
      for (let i = 0; i < this.q.length; i++) {
        const e = this.q[i];
        if (e.at > t) continue;
        if (best < 0 || e.at < this.q[best].at || (e.at === this.q[best].at && e.seq < this.q[best].seq)) best = i;
      }
      if (best < 0) break;
      const [e] = this.q.splice(best, 1);
      const prev = this.now;
      this.now = Math.max(prev, e.at);
      e.fn();
      this.now = prev;
    }
    this.now = t;
  }
}

/** One direction of a simulated DataChannel pair. */
export class SimPipe implements PeerTransport {
  bytesU = 0;
  bytesR = 0;
  packetsU = 0;
  droppedU = 0;
  open = true;
  private lastReliableAt = 0;

  constructor(
    private net: SimNet,
    private cond: LinkConditions,
    private deliver: (data: ArrayBuffer) => void,
  ) {}

  private delay(): number {
    return this.cond.rttMs / 2 + this.net.rand() * this.cond.jitterMs;
  }

  sendU(data: Uint8Array): boolean {
    if (!this.open) return false;
    this.bytesU += data.byteLength;
    this.packetsU++;
    if (this.net.rand() < this.cond.loss) {
      this.droppedU++;
      return true; // looks sent; lost in transit
    }
    const copy = data.slice().buffer;
    this.net.schedule(this.delay(), () => this.open && this.deliver(copy));
    return true;
  }

  sendR(data: Uint8Array): boolean {
    if (!this.open) return false;
    this.bytesR += data.byteLength;
    const copy = data.slice().buffer;
    let d = this.delay();
    if (this.net.rand() < this.cond.loss) d += this.cond.rttMs + 30; // retransmission
    // Ordered delivery: never before the previous reliable message.
    const at = Math.max(this.net.now + d, this.lastReliableAt);
    this.lastReliableAt = at;
    this.net.schedule(at - this.net.now, () => this.open && this.deliver(copy));
    return true;
  }

  bufferedU(): number {
    return 0;
  }

  isOpen(): boolean {
    return this.open;
  }
}

export interface ClientRun {
  id: number;
  match: ClientMatch;
  toHost: SimPipe;
  fromHost: SimPipe;
  /** Max |rendered remote position - authoritative position at that tick| seen (px). */
  maxInterpError: number;
  sumInterpError: number;
  interpSamples: number;
}

export interface SimResult {
  durationSec: number;
  host: HostMatch;
  clients: ClientRun[];
  /** Per client: did the predicted local position equal the host's after the idle settle period? */
  converged: boolean[];
  kills: number;
}

export interface SimOptions {
  players: number; // including host
  cond: LinkConditions;
  seconds: number;
  seed?: number;
  /** Variable frame times like a real device (ms range). */
  frameMs?: [number, number];
  mapId?: number;
}

function scriptedInput(id: number, t: number, me: RenderPlayer | null, others: RenderPlayer[], n: number, out: InputState, idle: boolean): void {
  out.buttons = 0;
  out.moveX = 0;
  if (idle) return;
  const phase = t * 0.6 + id * 1.7;
  out.moveX = Math.sin(phase) > 0 ? 127 : -127;
  if (Math.sin(t * 1.4 + id * 2.3) > 0.25) out.buttons |= BTN.JET;
  // Aim at the nearest living opponent and fire in bursts.
  let best: RenderPlayer | null = null;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const o = others[i];
    if (o.local || !(o.flags & F_ALIVE) || !me) continue;
    const d = (o.x - me.x) ** 2 + (o.y - me.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  if (me && best) out.aim = aimFromAngle(Math.atan2(best.y - me.y, best.x - me.x));
  if (t % 2.5 < 1.6) out.buttons |= BTN.FIRE;
}

export function runSimulation(opts: SimOptions): SimResult {
  const net = new SimNet(opts.seed ?? 1234);
  const [fMin, fMax] = opts.frameMs ?? [15, 18];
  const hostId = 1;
  const host = new HostMatch({ matchId: 1, mapId: opts.mapId ?? 0, durationSec: opts.seconds + 30, hostId, nowMs: 0 });
  const clients: ClientRun[] = [];
  for (let id = 2; id <= opts.players; id++) {
    const run = { id } as ClientRun;
    run.fromHost = new SimPipe(net, opts.cond, (buf) => run.match.onMessage(buf));
    run.toHost = new SimPipe(net, opts.cond, (buf) => host.onMessage(id, buf));
    host.attachPeer(id, run.fromHost);
    run.match = new ClientMatch({ myId: id, transport: run.toHost, nowMs: 0, clock: () => net.now });
    run.maxInterpError = 0;
    run.sumInterpError = 0;
    run.interpSamples = 0;
    clients.push(run);
  }

  const render: RenderPlayer[] = [];
  for (let i = 0; i < 9; i++) render.push(makeRenderPlayer());
  const hostInput: InputState = { buttons: 0, moveX: 0, aim: 0 };
  const inputs = clients.map(() => ({ buttons: 0, moveX: 0, aim: 0 }) as InputState);

  const endMs = opts.seconds * 1000;
  const idleFrom = endMs - 2500; // settle: everyone stops so prediction must converge
  let t = 0;
  while (t < endMs) {
    t += fMin + net.rand() * (fMax - fMin);
    net.runUntil(t);
    const idle = t >= idleFrom;

    let n = host.collectPlayers(render);
    scriptedInput(hostId, t / 1000, n > 0 ? render[0] : null, render, n, hostInput, idle);
    host.update(t, hostInput);

    clients.forEach((c, i) => {
      n = c.match.collectPlayers(render);
      const rt = c.match.renderTick(); // the render tick collectPlayers just used
      const me = n > 0 && render[0].local ? render[0] : null;
      scriptedInput(c.id, t / 1000, me, render, n, inputs[i], idle);
      // Interpolation accuracy: rendered remote position vs authoritative history at the render tick.
      if (c.match.phase === 'live') {
        const t0 = Math.floor(rt);
        const k0 = rt - t0;
        {
          for (let k = 0; k < n; k++) {
            const o = render[k];
            if (o.local || !(o.flags & F_ALIVE)) continue;
            const a = host.debugPositionAt(o.id, t0);
            const b = host.debugPositionAt(o.id, t0 + 1);
            if (!a || !b || Math.hypot(b.x - a.x, b.y - a.y) > 40) continue; // skip respawn teleports
            const truth = { x: a.x + (b.x - a.x) * k0, y: a.y + (b.y - a.y) * k0 };
            const err = Math.hypot(o.x - truth.x, o.y - truth.y);
            c.maxInterpError = Math.max(c.maxInterpError, err);
            c.sumInterpError += err;
            c.interpSamples++;
          }
        }
      }
      c.match.update(t, inputs[i]);
    });
    clients.forEach((c) => c.match.fx.drain(() => {}));
    host.fx.drain(() => {});
  }
  net.runUntil(t + 1000);

  const converged = clients.map((c) => {
    const truth = host.debugPlayer(c.id);
    if (!truth || !truth.alive) return true;
    const s = c.match.predictor.state;
    return s.x === truth.x && s.y === truth.y;
  });
  let kills = 0;
  for (let id = 1; id <= opts.players; id++) kills += host.debugPlayer(id)?.kills ?? 0;
  return { durationSec: opts.seconds, host, clients, converged, kills };
}

export function summarize(r: SimResult) {
  return r.clients.map((c) => {
    const ni = makeNetInfo();
    c.match.net(ni);
    const hud = makeHudInfo();
    c.match.hud(hud);
    const dbg = r.host.peerDebug(c.id);
    const secs = r.durationSec;
    return {
      id: c.id,
      downKbps: +(((c.fromHost.bytesU + c.fromHost.bytesR) * 8) / 1000 / secs).toFixed(1),
      upKbps: +(((c.toHost.bytesU + c.toHost.bytesR) * 8) / 1000 / secs).toFixed(1),
      snapPerSec: +(c.fromHost.packetsU / secs).toFixed(1),
      avgSnapBytes: +(c.fromHost.bytesU / Math.max(1, c.fromHost.packetsU)).toFixed(1),
      avgInputBytes: +(c.toHost.bytesU / Math.max(1, c.toHost.packetsU)).toFixed(1),
      measuredLossPct: +ni.lossPct.toFixed(1),
      rttMs: Math.round(ni.rttMs),
      interpDelayMs: Math.round(ni.interpDelayMs),
      corrections: ni.corrections,
      gapFilled: dbg?.inputsFilled ?? -1,
      interpErrAvg: +(c.sumInterpError / Math.max(1, c.interpSamples)).toFixed(2),
      interpErrMax: +c.maxInterpError.toFixed(1),
      kills: hud.kills,
    };
  });
}

export { TICK_MS };
