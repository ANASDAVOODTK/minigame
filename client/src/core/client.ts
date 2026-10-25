// Non-host player's view of a match: sends inputs, predicts the local player,
// reconciles with authoritative snapshots, and interpolates everyone else.

import { ByteReader, ByteWriter } from './bytes';
import { MOVE, NET, SHOULDER_Y, SLOTS, TICK_MS, TICK_RATE, PLAYER_HH, PLAYER_HW } from './config';
import { BTN_MASK, angleFromAim, makeInput, type InputState } from './input';
import { Interpolator } from './interpolation';
import { getMap, type GameMap } from './maps';
import { LossTracker, RateMeter } from './netstats';
import { makePlayerSim, raycastTiles, rayAabb } from './physics';
import { Predictor } from './predictor';
import {
  MSG,
  readEnd,
  readWelcome,
  writeHello,
  writeInputPacket,
  writePing,
  writeStats,
  type ResultRow,
  type WelcomeMsg,
} from './protocol';
import { clamp, hashSpread, seqDiff, seqNext } from './seq';
import { TimeSync } from './timesync';
import {
  F_ALIVE,
  F_DISCONNECTED,
  F_GROUND,
  F_JET,
  F_PROTECT,
  F_RELOAD,
  SHOT_HIT,
  WorldFrame,
  readEvents,
  readSnapshotBody,
  readSnapshotHeader,
  type ShotEvent,
  type SnapshotHeader,
} from './snapshot';
import type { PeerTransport } from './transport';
import {
  FX_DAMAGED,
  FX_HIT_CONFIRM,
  FX_KILL,
  FX_SPAWN,
  FX_TRACER,
  FxQueue,
  classifyQuality,
  makeRenderPlayer,
  type HudInfo,
  type MatchPhase,
  type MatchView,
  type NetInfo,
  type RenderPlayer,
  type ScoreRow,
} from './view';
import { WEAPONS } from './weapons';

const PENDING_SHOTS = 64;

interface PendingShot extends ShotEvent {
  tick: number;
  used: boolean;
}

export interface ClientMatchOptions {
  myId: number;
  transport: PeerTransport;
  nowMs: number;
  /** Clock used to timestamp packet arrivals (performance.now in browsers). */
  clock?: () => number;
}

export class ClientMatch implements MatchView {
  readonly role = 'client' as const;
  readonly myId: number;
  map: GameMap | null = null;
  readonly fx = new FxQueue();
  phase: MatchPhase = 'connecting';
  results: ResultRow[] | null = null;
  matchId = -1;
  rejected = 0;

  private transport: PeerTransport;
  private welcome: WelcomeMsg | null = null;
  private needHello = true;
  private lastHelloAt = -1e9;

  readonly predictor = new Predictor();
  private interp = new Interpolator();
  readonly ts = new TimeSync();
  private loss = new LossTracker();
  private frames: WorldFrame[] = [];
  private frameSeq = new Int32Array(NET.clientFrameRing).fill(-1);
  private latestSeq = -1;
  private latestFrame: WorldFrame | null = null;
  private lastNewestTick = -1;
  private ackInput = -1;
  private hdr: SnapshotHeader = { seq: 0, baseSeq: -1, tick: 0, ackInput: -1 };

  private inputSeq = 0;
  private inputsSinceStart = 0;
  private cmd = makeInput();
  private localAlive = false;
  private localSpawn = -1;
  private lastHp = -1;
  private diedAtMs = 0;
  private scratchSim = makePlayerSim();

  interpDelayMs = 100;
  snapIntervalMs = 1000 / NET.snapshotHzDefault;
  rttMs = 0;
  private rttSeen = false;
  fps = 60;

  private acc = 0;
  private lastNow: number;
  private clock: () => number;
  private sendAcc = 0;
  private lastPingAt = -1e9;
  private lastStatsAt = 0;
  private w = new ByteWriter(1024);
  private up = new RateMeter();
  private down = new RateMeter();

  private pending: PendingShot[] = [];
  private pendingHead = 0;
  private remote: RenderPlayer[] = [];
  private remoteCount = 0;
  private shotScratch: ShotEvent = { shooter: 0, weapon: 0, ox: 0, oy: 0, ex: 0, ey: 0, flags: 0 };
  /** Set by the session while the WebRTC link to the host is down. */
  linkDown = false;
  private lastSnapshotAt = -1;
  private readonly createdAt: number;

  constructor(opts: ClientMatchOptions) {
    this.myId = opts.myId;
    this.transport = opts.transport;
    this.lastNow = opts.nowMs;
    this.createdAt = opts.nowMs;
    this.clock = opts.clock ?? (() => this.lastNow);
    for (let i = 0; i < NET.clientFrameRing; i++) this.frames.push(new WorldFrame());
    for (let i = 0; i < PENDING_SHOTS; i++) this.pending.push({ tick: 0, used: false, shooter: 0, weapon: 0, ox: 0, oy: 0, ex: 0, ey: 0, flags: 0 });
    for (let i = 0; i < SLOTS; i++) this.remote.push(makeRenderPlayer());
  }

  /** A new link to the host replaced the old one (reconnect). */
  setTransport(t: PeerTransport): void {
    this.transport = t;
    this.needHello = true;
    this.lastHelloAt = -1e9;
    this.latestSeq = -1;
    this.frameSeq.fill(-1);
    this.loss.reset();
  }

  // ---------------------------------------------------------------- network input

  onMessage(data: ArrayBuffer): void {
    this.down.add(data.byteLength, this.lastNow);
    try {
      const r = new ByteReader(data);
      switch (r.u8()) {
        case MSG.SNAPSHOT:
          this.onSnapshot(r);
          break;
        case MSG.PONG: {
          const t = r.u32();
          const rtt = ((Math.floor(this.clock()) >>> 0) - t) >>> 0;
          if (rtt < 10_000) {
            this.rttMs = this.rttSeen ? this.rttMs + (rtt - this.rttMs) * 0.25 : rtt;
            this.rttSeen = true;
          }
          break;
        }
        case MSG.WELCOME:
          this.onWelcome(readWelcome(r));
          break;
        case MSG.KILL: {
          const e = this.fx.push(FX_KILL);
          e.id = r.u8();
          e.other = r.u8();
          e.weapon = r.u8();
          e.flags = r.u8();
          break;
        }
        case MSG.HIT: {
          const e = this.fx.push(FX_HIT_CONFIRM);
          e.other = r.u8();
          e.value = r.u8();
          e.flags = r.u8();
          break;
        }
        case MSG.END: {
          const end = readEnd(r);
          this.results = end.rows;
          this.phase = 'ended';
          break;
        }
        case MSG.REJECT:
          this.rejected = r.u8();
          this.phase = 'ended';
          break;
      }
    } catch {
      /* malformed packet: ignore */
    }
  }

  private onWelcome(m: WelcomeMsg): void {
    if (m.version !== NET.protocolVersion || m.yourId !== this.myId) {
      this.rejected = 1;
      this.phase = 'ended';
      return;
    }
    this.welcome = m;
    this.matchId = m.matchId;
    this.map = getMap(m.mapId);
    this.needHello = false;
    this.snapIntervalMs = 1000 / m.snapshotHz;
    if (this.phase === 'connecting') this.phase = 'live';
  }

  private onSnapshot(r: ByteReader): void {
    const hdr = this.hdr;
    readSnapshotHeader(r, hdr);
    if (!this.welcome) return;
    let base: WorldFrame | null = null;
    if (hdr.baseSeq >= 0) {
      if (seqDiff(hdr.seq, hdr.baseSeq) >= NET.clientFrameRing || seqDiff(hdr.seq, hdr.baseSeq) <= 0) return;
      const bi = hdr.baseSeq % NET.clientFrameRing;
      if (this.frameSeq[bi] !== hdr.baseSeq) return; // baseline gone: wait for a newer snapshot
      base = this.frames[bi];
    }
    if (this.latestSeq >= 0 && seqDiff(hdr.seq, this.latestSeq) <= -(NET.clientFrameRing / 2)) return;
    const slot = hdr.seq % NET.clientFrameRing;
    const out = this.frames[slot];
    readSnapshotBody(r, base, hdr.tick, out);
    this.frameSeq[slot] = hdr.seq;
    this.lastSnapshotAt = this.lastNow;
    this.loss.onSeq(hdr.seq);
    this.ts.addSample(hdr.tick, this.clock());
    this.interp.push(out);

    const newest = this.latestSeq < 0 || seqDiff(hdr.seq, this.latestSeq) > 0;
    readEvents(r, (e) => this.queueShot(e, hdr.tick), this.shotScratch);
    if (!newest) return;

    if (this.lastNewestTick >= 0) {
      const dTick = hdr.tick - this.lastNewestTick;
      if (dTick > 0 && dTick < 30) this.snapIntervalMs += (dTick * TICK_MS - this.snapIntervalMs) * 0.1;
    }
    this.lastNewestTick = hdr.tick;
    this.latestSeq = hdr.seq;
    this.latestFrame = out;
    if (hdr.ackInput >= 0) this.ackInput = hdr.ackInput;
    this.reconcileLocal(out, hdr.ackInput);
  }

  private reconcileLocal(f: WorldFrame, ackInput: number): void {
    const id = this.myId;
    if (!f.present[id] || !this.map) return;
    const hp = f.hp[id];
    if (this.lastHp >= 0 && hp < this.lastHp && this.localAlive) {
      const e = this.fx.push(FX_DAMAGED);
      e.value = this.lastHp - hp;
    }
    this.lastHp = hp;

    const alive = (f.flags[id] & F_ALIVE) !== 0;
    const server = f.toSim(id, this.scratchSim);
    if (!alive) {
      if (this.localAlive) this.diedAtMs = this.lastNow;
      this.localAlive = false;
      this.predictor.set(server);
      return;
    }
    if (!this.localAlive || f.spawn[id] !== this.localSpawn) {
      this.localAlive = true;
      this.localSpawn = f.spawn[id];
      // If the host hasn't processed any of our inputs yet, all of them are still pending:
      // replay from just before the first one.
      const from = ackInput >= 0 ? ackInput : this.inputsSinceStart > 0 ? (this.inputSeq - this.inputsSinceStart) & 0xffff : -1;
      this.predictor.resetTo(server, from, this.inputSeq, this.map);
      const e = this.fx.push(FX_SPAWN);
      e.id = id;
      e.x0 = server.x;
      e.y0 = server.y;
      return;
    }
    if (ackInput >= 0) this.predictor.reconcile(server, ackInput, this.inputSeq, this.map);
  }

  private queueShot(e: ShotEvent, tick: number): void {
    const p = this.pending[this.pendingHead];
    this.pendingHead = (this.pendingHead + 1) % PENDING_SHOTS;
    p.tick = tick;
    p.used = true;
    p.shooter = e.shooter;
    p.weapon = e.weapon;
    p.ox = e.ox;
    p.oy = e.oy;
    p.ex = e.ex;
    p.ey = e.ey;
    p.flags = e.flags;
  }

  /** Remote shots are shown when render time reaches them, in sync with the shooter's sprite. */
  private releaseShots(renderTick: number): void {
    for (let i = 0; i < PENDING_SHOTS; i++) {
      const p = this.pending[i];
      if (!p.used || p.tick > renderTick + 1) continue;
      p.used = false;
      const e = this.fx.push(FX_TRACER);
      e.id = p.shooter;
      e.weapon = p.weapon;
      e.x0 = p.ox;
      e.y0 = p.oy;
      e.x1 = p.ex;
      e.y1 = p.ey;
      e.flags = p.flags;
    }
  }

  // ---------------------------------------------------------------- per frame

  update(nowMs: number, input: InputState): void {
    const dt = clamp(nowMs - this.lastNow, 0, 250);
    this.lastNow = nowMs;
    this.ts.update(dt);
    this.updateInterpDelay(dt);
    this.predictor.decayError(dt);

    if (this.needHello && nowMs - this.lastHelloAt > 1000 && this.transport.isOpen()) {
      this.lastHelloAt = nowMs;
      this.w.reset();
      writeHello(this.w, NET.protocolVersion, this.inputSeq);
      this.transport.sendR(this.w.bytes());
    }

    if (this.phase === 'live' && this.map) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= TICK_MS && steps < 8) {
        this.tickOnce(input);
        this.acc -= TICK_MS;
        steps++;
      }
      if (this.acc >= TICK_MS) this.acc = 0; // long stall: don't try to catch up
      this.sendAcc += dt;
      const interval = 1000 / this.inputHz();
      if (this.sendAcc >= interval) {
        this.sendAcc = this.sendAcc >= interval * 2 ? 0 : this.sendAcc - interval;
        this.sendInputs();
      }
      this.releaseShots(this.renderTick());
    }

    if (nowMs - this.lastPingAt >= NET.pingIntervalMs && this.transport.isOpen()) {
      this.lastPingAt = nowMs;
      this.w.reset();
      writePing(this.w, Math.floor(nowMs));
      if (this.transport.sendU(this.w.bytes())) this.up.add(this.w.pos, nowMs);
    }
    if (this.phase === 'live' && nowMs - this.lastStatsAt >= NET.statsIntervalMs && this.transport.isOpen()) {
      this.lastStatsAt = nowMs;
      this.w.reset();
      writeStats(this.w, {
        rttMs: this.rttMs,
        lossPermille: this.loss.loss() * 1000,
        jitterMs: this.ts.lateMean,
        fps: this.fps,
        corrections: this.predictor.corrections,
      });
      this.transport.sendR(this.w.bytes());
    }
    this.up.tick(nowMs);
    this.down.tick(nowMs);
  }

  private inputHz(): number {
    return this.loss.loss() > 0.08 || this.rttMs > 300 ? NET.inputSendHzPoor : NET.inputSendHz;
  }

  private tickOnce(input: InputState): void {
    this.inputSeq = seqNext(this.inputSeq);
    this.inputsSinceStart++;
    const c = this.cmd;
    c.seq = this.inputSeq;
    c.buttons = input.buttons & BTN_MASK;
    c.moveX = input.moveX;
    c.aim = input.aim;
    if (this.localAlive && this.map) {
      if (this.predictor.step(c, this.map)) this.localShot(c.seq);
    } else {
      this.predictor.storeInput(c);
    }
  }

  private sendInputs(): void {
    if (!this.inputsSinceStart || !this.transport.isOpen() || this.needHello) return;
    let count = this.ackInput >= 0 ? seqDiff(this.inputSeq, this.ackInput) : this.inputsSinceStart;
    count = clamp(count, 1, Math.min(NET.maxInputsPerPacket, this.inputsSinceStart));
    this.w.reset();
    writeInputPacket(this.w, this.latestSeq, this.renderTick(), this.inputSeq, count, (s) => this.predictor.getInput(s));
    if (this.transport.sendU(this.w.bytes())) this.up.add(this.w.pos, this.lastNow);
  }

  /** Host tick at which remote players are currently rendered. */
  renderTick(): number {
    return (this.ts.hostTimeMs(this.lastNow) - this.interpDelayMs) / TICK_MS;
  }

  private updateInterpDelay(dt: number): void {
    const lossy = this.loss.loss() > 0.03;
    let target = this.snapIntervalMs + this.ts.lateP95 + 10 + (lossy ? this.snapIntervalMs : 0);
    target = clamp(target, NET.minInterpDelayMs, NET.maxInterpDelayMs);
    const d = target - this.interpDelayMs;
    // Grow quickly (avoid starving), shrink slowly (avoid visible time warps).
    this.interpDelayMs += d > 0 ? Math.min(d, dt * 0.25) : Math.max(d, -dt * 0.02);
  }

  /** Instant local tracer for a predicted shot (the host decides the real hit). */
  private localShot(seq: number): void {
    const s = this.predictor.state;
    const map = this.map!;
    const w = WEAPONS[s.weapon];
    const ox = s.x;
    const oy = s.y + SHOULDER_Y;
    const base = angleFromAim(s.aim);
    for (let pellet = 0; pellet < w.pellets; pellet++) {
      const a = base + hashSpread(this.myId, seq, pellet) * w.spread;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      let dist = raycastTiles(map, ox, oy, dx, dy, w.range);
      let hit = false;
      for (let i = 0; i < this.remoteCount; i++) {
        const rp = this.remote[i];
        if (!(rp.flags & F_ALIVE)) continue;
        const t = rayAabb(ox, oy, dx, dy, rp.x - PLAYER_HW, rp.y - PLAYER_HH, rp.x + PLAYER_HW, rp.y + PLAYER_HH);
        if (t >= 0 && t < dist) {
          dist = t;
          hit = true;
        }
      }
      const e = this.fx.push(FX_TRACER);
      e.id = this.myId;
      e.weapon = w.id;
      e.x0 = ox;
      e.y0 = oy;
      e.x1 = ox + dx * dist;
      e.y1 = oy + dy * dist;
      e.flags = hit ? SHOT_HIT : 0;
      e.local = true;
    }
  }

  // ---------------------------------------------------------------- MatchView

  collectPlayers(out: RenderPlayer[]): number {
    let n = 0;
    const f = this.latestFrame;
    if (!f) return 0;
    const id = this.myId;
    if (f.present[id]) {
      const o = out[n++];
      o.id = id;
      o.local = true;
      o.hp = f.hp[id];
      o.spawn = f.spawn[id];
      if (this.localAlive) {
        const s = this.predictor.state;
        const p = this.predictor.prev;
        const a = this.acc / TICK_MS;
        o.x = p.x + (s.x - p.x) * a + this.predictor.errX;
        o.y = p.y + (s.y - p.y) * a + this.predictor.errY;
        o.vx = s.vx;
        o.vy = s.vy;
        o.aim = s.aim;
        o.weapon = s.weapon;
        o.flags = (f.flags[id] & (F_PROTECT | F_DISCONNECTED)) | F_ALIVE | (s.onGround ? F_GROUND : 0) | (s.jetting ? F_JET : 0) | (s.reload > 0 ? F_RELOAD : 0);
      } else {
        const s = this.predictor.state;
        o.x = s.x;
        o.y = s.y;
        o.vx = 0;
        o.vy = 0;
        o.aim = s.aim;
        o.weapon = s.weapon;
        o.flags = f.flags[id];
      }
    }
    const rt = this.renderTick();
    this.remoteCount = 0;
    for (let pid = 1; pid < SLOTS; pid++) {
      if (pid === id || !f.present[pid]) continue;
      const o = out[n];
      if (this.interp.sample(pid, rt, o)) {
        n++;
        const c = this.remote[this.remoteCount++];
        c.x = o.x;
        c.y = o.y;
        c.flags = o.flags;
      }
    }
    return n;
  }

  hud(out: HudInfo): void {
    const f = this.latestFrame;
    const id = this.myId;
    const s = this.predictor.state;
    const w = WEAPONS[s.weapon];
    out.alive = this.localAlive;
    out.hp = f && f.present[id] ? f.hp[id] : 0;
    out.ammo = s.ammo;
    out.magSize = w.magSize;
    out.reload = s.reload > 0 ? 1 - s.reload / w.reloadTicks : 0;
    out.fuel = s.fuel / MOVE.fuelMax;
    out.weapon = s.weapon;
    out.kills = f && f.present[id] ? f.kills[id] : 0;
    out.deaths = f && f.present[id] ? f.deaths[id] : 0;
    if (this.welcome) {
      const hostTickNow = (this.ts.hostTimeMs(this.lastNow) + this.rttMs / 2) / TICK_MS;
      out.timeLeftSec = Math.max(0, (this.welcome.endTick - hostTickNow) / TICK_RATE);
    }
    out.respawnInSec = this.localAlive ? 0 : Math.max(0, 3 - (this.lastNow - this.diedAtMs) / 1000);
    out.protected = !!f && f.present[id] === 1 && (f.flags[id] & F_PROTECT) !== 0;
    out.connectingSec = this.phase === 'connecting' ? (this.lastNow - this.createdAt) / 1000 : -1;
  }

  net(out: NetInfo): void {
    const lossPct = this.loss.loss() * 100;
    out.role = 'client';
    out.rttMs = this.rttMs;
    out.lossPct = lossPct;
    out.jitterMs = this.ts.lateMean;
    out.quality = classifyQuality(this.rttMs, lossPct, this.ts.lateMean);
    const stale = this.phase === 'live' && this.lastSnapshotAt >= 0 && this.lastNow - this.lastSnapshotAt > 2500;
    out.reconnecting = this.linkDown || !this.transport.isOpen() || stale || (this.needHello && this.phase === 'live');
    out.snapshotHz = 1000 / this.snapIntervalMs;
    out.upKbps = this.up.kbps();
    out.downKbps = this.down.kbps();
    out.corrections = this.predictor.corrections;
    out.interpDelayMs = this.interpDelayMs;
    out.peers = 1;
  }

  scores(out: ScoreRow[]): number {
    const f = this.latestFrame;
    if (!f) return 0;
    let n = 0;
    for (let id = 1; id < SLOTS; id++) {
      if (!f.present[id]) continue;
      const row = out[n++];
      row.id = id;
      row.kills = f.kills[id];
      row.deaths = f.deaths[id];
      row.pingMs = id === this.myId ? this.rttMs : 0;
      row.connected = (f.flags[id] & F_DISCONNECTED) === 0;
    }
    return n;
  }
}
