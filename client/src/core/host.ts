// Authoritative match simulation. Runs inside the host player's browser.
//
// - Processes each player's input stream in order (one input = one 60 Hz tick of
//   that player's movement), at most one tick of credit per real tick: clients
//   cannot move faster than real time (speedhack protection).
// - All damage, kills, ammo and fire rate are decided here. Clients never
//   report hits.
// - Hitscan shots are lag-compensated: targets are rewound to the moment the
//   shooter saw them (bounded by NET.maxRewindTicks).
// - Sends per-peer delta-compressed snapshots at an adaptive rate.

import { ByteReader, ByteWriter } from './bytes';
import { HEAD_H, MATCH, MAX_HP, MOVE, NET, PLAYER_HH, PLAYER_HW, SHOULDER_Y, SLOTS, TICK_MS, TICK_RATE } from './config';
import { Interpolator } from './interpolation';
import { angleFromAim, copyInput, makeInput, type InputCmd, type InputState } from './input';
import { getMap, type GameMap } from './maps';
import { RateMeter } from './netstats';
import { copySim, makePlayerSim, raycastTiles, rayAabb, resetSimForSpawn, stepPlayer } from './physics';
import {
  HIT_HEADSHOT,
  HIT_KILL,
  KILL_HEADSHOT,
  MSG,
  REJECT_REASON,
  readInputPacket,
  readStats,
  writeEnd,
  writeHit,
  writeKill,
  writePong,
  writeWelcome,
  type ClientStats,
  type InputPacketHeader,
  type ResultRow,
} from './protocol';
import { clamp, hashSpread, seqAdd, seqDiff, seqNext } from './seq';
import {
  F_ALIVE,
  F_DISCONNECTED,
  F_GROUND,
  F_JET,
  F_PROTECT,
  F_RELOAD,
  SHOT_HEADSHOT,
  SHOT_HIT,
  WorldFrame,
  writeShotEvent,
  writeSnapshot,
  type ShotEvent,
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
  type HudInfo,
  type MatchPhase,
  type MatchView,
  type NetInfo,
  type RenderPlayer,
  type ScoreRow,
} from './view';
import { WEAPONS, weaponDamage } from './weapons';

const HIST = NET.historyTicks; // power of two
const SHOT_RING = 64;
const MAX_EVENTS_PER_SNAPSHOT = 16;

interface QueuedInput {
  cmd: InputCmd;
  renderTick: number;
}

interface ShotRec extends ShotEvent {
  seq: number;
}

class HostPlayer {
  readonly sim = makePlayerSim();
  readonly prevSim = makePlayerSim();
  alive = false;
  hp = 0;
  spawn = 0;
  respawnAt = 0;
  protectUntil = 0;
  kills = 0;
  deaths = 0;
  connected = true;
  disconnectedAt = 0;

  readonly queue: QueuedInput[] = [];
  qHead = 0;
  qLen = 0;
  lastQueued = -1;
  lastProcessed = -1;
  /** False until an input of the current stream (since HELLO) was processed: no ack yet. */
  ackValid = false;
  budget = 0;
  readonly lastCmd = makeInput();
  inputsReceived = 0;
  inputsFilled = 0;
  inputsDropped = 0;

  readonly histX = new Float64Array(HIST);
  readonly histY = new Float64Array(HIST);
  readonly histTick = new Int32Array(HIST).fill(-1);

  constructor(readonly id: number) {
    for (let i = 0; i < NET.maxQueuedInputs; i++) this.queue.push({ cmd: makeInput(), renderTick: 0 });
  }

  enqueue(cmd: InputCmd, seq: number, renderTick: number): boolean {
    if (this.qLen >= this.queue.length) {
      this.inputsDropped++;
      return false;
    }
    const q = this.queue[(this.qHead + this.qLen) % this.queue.length];
    copyInput(q.cmd, cmd);
    q.cmd.seq = seq;
    q.renderTick = renderTick;
    this.qLen++;
    return true;
  }

  dequeue(): QueuedInput {
    const q = this.queue[this.qHead];
    this.qHead = (this.qHead + 1) % this.queue.length;
    this.qLen--;
    return q;
  }

  clearQueue(): void {
    this.qHead = 0;
    this.qLen = 0;
  }

  flags(tick: number): number {
    let f = 0;
    if (this.alive) f |= F_ALIVE;
    if (this.sim.onGround) f |= F_GROUND;
    if (this.alive && this.sim.jetting) f |= F_JET;
    if (this.alive && tick < this.protectUntil) f |= F_PROTECT;
    if (!this.connected) f |= F_DISCONNECTED;
    if (this.sim.reload > 0) f |= F_RELOAD;
    return f;
  }
}

class HostPeer {
  snapHz: number = NET.snapshotHzDefault;
  snapAccum = 0;
  snapSeq = 0xffff;
  readonly seqNum = new Int32Array(NET.peerSeqRing).fill(-1);
  readonly seqTick = new Int32Array(NET.peerSeqRing);
  ackSnap = -1;
  welcomed = false;
  lastEventSent = 0;
  stats: ClientStats | null = null;
  skippedBusy = 0;
  malformed = 0;
  readonly up = new RateMeter();
  readonly down = new RateMeter();

  constructor(
    readonly id: number,
    public transport: PeerTransport,
  ) {}
}

export interface HostMatchOptions {
  matchId: number;
  mapId: number;
  durationSec: number;
  hostId: number;
  nowMs: number;
  /** Called once when the match timer runs out. */
  onEnded?: (rows: ResultRow[]) => void;
}

export class HostMatch implements MatchView {
  readonly role = 'host' as const;
  readonly myId: number;
  readonly map: GameMap;
  readonly fx = new FxQueue();
  readonly matchId: number;
  phase: MatchPhase = 'live';
  results: ResultRow[] | null = null;

  tick = 0;
  readonly startTick = 0;
  readonly endTick: number;

  private players: (HostPlayer | null)[] = new Array(SLOTS).fill(null);
  private peers: (HostPeer | null)[] = new Array(SLOTS).fill(null);
  private savedScores = new Map<number, { kills: number; deaths: number }>();
  private frames: WorldFrame[] = [];
  private interp = new Interpolator();
  private shots: ShotRec[] = [];
  private shotSeq = 0;

  private w = new ByteWriter(4096);
  private acc = 0;
  private lastNow: number;
  private localSeq = 0;
  private localCmd = makeInput();
  private inHdr: InputPacketHeader = { ackSnap: -1, renderTick: 0, newestSeq: 0, count: 0 };
  private inCmds: InputCmd[] = [];
  private onEnded?: (rows: ResultRow[]) => void;

  constructor(opts: HostMatchOptions) {
    this.myId = opts.hostId;
    this.matchId = opts.matchId;
    this.map = getMap(opts.mapId);
    this.endTick = this.startTick + Math.round(opts.durationSec * TICK_RATE);
    this.lastNow = opts.nowMs;
    this.onEnded = opts.onEnded;
    for (let i = 0; i < NET.hostFrameRing; i++) this.frames.push(new WorldFrame());
    for (let i = 0; i < SHOT_RING; i++) this.shots.push({ seq: 0, shooter: 0, weapon: 0, ox: 0, oy: 0, ex: 0, ey: 0, flags: 0 });
    for (let i = 0; i < NET.maxInputsPerPacket; i++) this.inCmds.push(makeInput());
    const me = new HostPlayer(this.myId);
    this.players[this.myId] = me;
    this.spawnPlayer(me);
    this.captureFrame();
  }

  // ---------------------------------------------------------------- peer lifecycle (called by the session)

  /** A WebRTC link to player `id` opened. The player joins once it sends HELLO. */
  attachPeer(id: number, transport: PeerTransport): void {
    if (id < 1 || id >= SLOTS || id === this.myId) return;
    this.peers[id] = new HostPeer(id, transport);
  }

  /** The link to `id` closed. The player stays (frozen, invulnerable) for a grace period. */
  detachPeer(id: number, transport?: PeerTransport): void {
    const peer = this.peers[id];
    if (!peer || (transport && peer.transport !== transport)) return;
    this.peers[id] = null;
    const p = this.players[id];
    if (p) {
      p.connected = false;
      p.disconnectedAt = this.tick;
      p.clearQueue();
    }
  }

  /** The member left the room: remove immediately. */
  removePlayer(id: number): void {
    if (id === this.myId) return;
    this.players[id] = null;
    this.peers[id] = null;
    this.savedScores.delete(id);
  }

  hasPlayer(id: number): boolean {
    return this.players[id] !== null;
  }

  onMessage(id: number, data: ArrayBuffer): void {
    const peer = this.peers[id];
    if (!peer) return;
    peer.down.add(data.byteLength, this.lastNow);
    try {
      const r = new ByteReader(data);
      switch (r.u8()) {
        case MSG.HELLO:
          this.onHello(peer, r);
          break;
        case MSG.INPUT:
          if (peer.welcomed) this.onInput(peer, r);
          break;
        case MSG.PING: {
          const t = r.u32();
          this.w.reset();
          writePong(this.w, t, this.tick);
          this.sendU(peer, this.w.bytes());
          break;
        }
        case MSG.STATS:
          peer.stats = readStats(r);
          this.adaptRate(peer);
          break;
        default:
          peer.malformed++;
      }
    } catch {
      peer.malformed++;
    }
  }

  private onHello(peer: HostPeer, r: ByteReader): void {
    const version = r.u8();
    const clientSeq = r.u16();
    const w = this.w.reset();
    if (version !== NET.protocolVersion) {
      w.u8(MSG.REJECT).u8(REJECT_REASON.VERSION);
      peer.transport.sendR(w.bytes());
      return;
    }
    if (this.phase === 'ended' && this.results) {
      writeEnd(w, this.matchId, this.results);
      peer.transport.sendR(w.bytes());
      return;
    }
    let p = this.players[peer.id];
    if (!p) {
      p = new HostPlayer(peer.id);
      const saved = this.savedScores.get(peer.id);
      if (saved) {
        p.kills = saved.kills;
        p.deaths = saved.deaths;
      }
      this.players[peer.id] = p;
      this.spawnPlayer(p);
    }
    p.connected = true;
    p.clearQueue();
    // Resync the input stream: the client (possibly a reloaded page) continues after clientSeq.
    p.lastQueued = p.lastProcessed = clientSeq;
    p.ackValid = false;
    p.budget = 0;
    peer.welcomed = true;
    peer.ackSnap = -1;
    peer.lastEventSent = this.shotSeq;
    writeWelcome(w, {
      version: NET.protocolVersion,
      yourId: peer.id,
      mapId: this.map.id,
      hostTick: this.tick,
      startTick: this.startTick,
      endTick: this.endTick,
      snapshotHz: peer.snapHz,
      matchId: this.matchId,
    });
    peer.transport.sendR(w.bytes());
  }

  private onInput(peer: HostPeer, r: ByteReader): void {
    const p = this.players[peer.id];
    if (!p || !p.connected) return;
    const hdr = this.inHdr;
    if (!readInputPacket(r, hdr, this.inCmds)) {
      peer.malformed++;
      return;
    }
    // Snapshot acknowledgement -> delta baseline. Never trust an ack for a snapshot we didn't send.
    if (hdr.ackSnap >= 0 && seqDiff(hdr.ackSnap, peer.snapSeq) <= 0) {
      if (peer.ackSnap < 0 || seqDiff(hdr.ackSnap, peer.ackSnap) > 0) peer.ackSnap = hdr.ackSnap;
    }
    // The client renders others at renderTick; it can't be in the future.
    const rtNewest = Math.min(hdr.renderTick, this.tick);

    for (let i = hdr.count - 1; i >= 0; i--) {
      const c = this.inCmds[i];
      if (p.lastQueued >= 0) {
        const d = seqDiff(c.seq, p.lastQueued);
        if (d <= 0) continue; // already have it (redundant copy)
        const gap = d - 1;
        if (gap > 0 && gap <= NET.maxGapFill) {
          // Lost beyond the redundancy window: repeat the last known input.
          for (let k = 1; k <= gap; k++) {
            if (!p.enqueue(p.lastCmd, seqAdd(p.lastQueued, k), rtNewest - i - (gap - k + 1))) return;
            p.inputsFilled++;
          }
        }
      }
      if (!p.enqueue(c, c.seq, rtNewest - i)) return;
      copyInput(p.lastCmd, c);
      p.lastQueued = c.seq;
      p.inputsReceived++;
    }
  }

  private adaptRate(peer: HostPeer): void {
    const s = peer.stats;
    if (!s) return;
    const lossPct = s.lossPermille / 10;
    let hz = 20;
    if (lossPct > 10 || peer.skippedBusy > 4 || s.rttMs > 400) hz = 10;
    else if (lossPct > 4 || s.jitterMs > 70 || s.rttMs > 250) hz = 15;
    peer.skippedBusy = 0;
    peer.snapHz = hz;
  }

  // ---------------------------------------------------------------- simulation

  update(nowMs: number, input: InputState): void {
    const dt = nowMs - this.lastNow;
    this.lastNow = nowMs;
    if (dt > 0) this.acc += Math.min(dt, 250);
    let steps = 0;
    while (this.acc >= TICK_MS && steps < 15) {
      this.stepTick(input);
      this.acc -= TICK_MS;
      steps++;
    }
    if (this.acc >= TICK_MS) this.acc = 0;
    for (let id = 1; id < SLOTS; id++) {
      const peer = this.peers[id];
      if (peer) {
        peer.up.tick(nowMs);
        peer.down.tick(nowMs);
      }
    }
  }

  private stepTick(input: InputState): void {
    if (this.phase !== 'live') return;
    this.tick++;
    const tick = this.tick;

    // Host's own player: no network delay.
    const me = this.players[this.myId]!;
    copySim(me.prevSim, me.sim);
    const lc = this.localCmd;
    this.localSeq = seqNext(this.localSeq);
    lc.seq = this.localSeq;
    lc.buttons = input.buttons;
    lc.moveX = input.moveX;
    lc.aim = input.aim;
    this.applyInput(me, lc, tick - NET.hostViewDelayTicks);

    // Remote players: consume one input per tick so their authoritative motion is smooth
    // (packets arrive in bursts); catch up gradually when a backlog builds. The budget
    // caps the long-run rate at real time, so a client cannot speed-hack by sending more.
    for (let id = 1; id < SLOTS; id++) {
      const p = this.players[id];
      if (!p || id === this.myId || !p.connected) continue;
      p.budget = Math.min(p.budget + 1, NET.maxInputBudget);
      let n = p.qLen > 8 ? 3 : p.qLen > 3 ? 2 : 1;
      while (n-- > 0 && p.qLen > 0 && p.budget >= 1) {
        const q = p.dequeue();
        this.applyInput(p, q.cmd, q.renderTick);
        p.budget -= 1;
      }
    }

    // Timers.
    for (let id = 1; id < SLOTS; id++) {
      const p = this.players[id];
      if (!p) continue;
      if (!p.alive && p.connected && tick >= p.respawnAt) this.spawnPlayer(p);
      if (!p.connected && tick - p.disconnectedAt > MATCH.disconnectRemoveTicks) {
        this.savedScores.set(id, { kills: p.kills, deaths: p.deaths });
        this.players[id] = null;
      }
    }

    // Lag-compensation history.
    const hi = tick & (HIST - 1);
    for (let id = 1; id < SLOTS; id++) {
      const p = this.players[id];
      if (!p) continue;
      p.histX[hi] = p.sim.x;
      p.histY[hi] = p.sim.y;
      p.histTick[hi] = tick;
    }

    const frame = this.captureFrame();
    this.sendSnapshots(frame);

    if (tick >= this.endTick) this.endMatch();
  }

  private applyInput(p: HostPlayer, cmd: InputCmd, renderTick: number): void {
    p.lastProcessed = cmd.seq;
    p.ackValid = true;
    if (!p.alive) {
      p.sim.aim = cmd.aim;
      p.sim.btn = cmd.buttons;
      return;
    }
    if (stepPlayer(p.sim, cmd, this.map)) {
      p.protectUntil = 0; // shooting ends spawn protection
      this.fireWeapon(p, cmd.seq, renderTick);
    }
  }

  private rewound = { x: 0, y: 0 };

  private positionAt(p: HostPlayer, tick: number): { x: number; y: number } {
    const i = tick & (HIST - 1);
    if (p.histTick[i] === tick) {
      this.rewound.x = p.histX[i];
      this.rewound.y = p.histY[i];
    } else {
      this.rewound.x = p.sim.x;
      this.rewound.y = p.sim.y;
    }
    return this.rewound;
  }

  private fireWeapon(p: HostPlayer, seq: number, renderTick: number): void {
    const w = WEAPONS[p.sim.weapon];
    const ox = p.sim.x;
    const oy = p.sim.y + SHOULDER_Y;
    const base = angleFromAim(p.sim.aim);
    const rt = clamp(Math.floor(renderTick), this.tick - NET.maxRewindTicks, this.tick);
    for (let pellet = 0; pellet < w.pellets; pellet++) {
      const a = base + hashSpread(p.id, seq, pellet) * w.spread;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      let best = raycastTiles(this.map, ox, oy, dx, dy, w.range);
      let victim: HostPlayer | null = null;
      let head = false;
      for (let id = 1; id < SLOTS; id++) {
        const q = this.players[id];
        if (!q || q === p || !q.alive || !q.connected) continue;
        const pos = this.positionAt(q, rt);
        const t = rayAabb(ox, oy, dx, dy, pos.x - PLAYER_HW, pos.y - PLAYER_HH, pos.x + PLAYER_HW, pos.y + PLAYER_HH);
        if (t >= 0 && t < best) {
          best = t;
          victim = q;
          head = oy + dy * t < pos.y - PLAYER_HH + HEAD_H;
        }
      }
      const rec = this.shots[this.shotSeq % SHOT_RING];
      this.shotSeq++;
      rec.seq = this.shotSeq;
      rec.shooter = p.id;
      rec.weapon = w.id;
      rec.ox = ox;
      rec.oy = oy;
      rec.ex = ox + dx * best;
      rec.ey = oy + dy * best;
      rec.flags = (victim ? SHOT_HIT : 0) | (head ? SHOT_HEADSHOT : 0);

      const e = this.fx.push(FX_TRACER);
      e.id = p.id;
      e.weapon = w.id;
      e.x0 = rec.ox;
      e.y0 = rec.oy;
      e.x1 = rec.ex;
      e.y1 = rec.ey;
      e.flags = rec.flags;
      e.local = p.id === this.myId;

      if (victim) this.damage(victim, weaponDamage(w, best, head), p, w.id, head);
    }
  }

  private damage(victim: HostPlayer, amount: number, attacker: HostPlayer, weapon: number, head: boolean): void {
    if (!victim.alive || this.tick < victim.protectUntil) return;
    victim.hp = Math.max(0, victim.hp - amount);
    const killed = victim.hp === 0;
    const hitFlags = (head ? HIT_HEADSHOT : 0) | (killed ? HIT_KILL : 0);

    if (attacker.id === this.myId) {
      const e = this.fx.push(FX_HIT_CONFIRM);
      e.other = victim.id;
      e.value = amount;
      e.flags = hitFlags;
    } else {
      const peer = this.peers[attacker.id];
      if (peer?.welcomed) {
        this.w.reset();
        writeHit(this.w, victim.id, amount, hitFlags);
        peer.transport.sendR(this.w.bytes());
      }
    }
    if (victim.id === this.myId) {
      const e = this.fx.push(FX_DAMAGED);
      e.value = amount;
      e.id = attacker.id;
    }

    if (killed) {
      victim.alive = false;
      victim.deaths++;
      victim.respawnAt = this.tick + MATCH.respawnTicks;
      if (attacker !== victim) attacker.kills++;
      const kf = head ? KILL_HEADSHOT : 0;
      const e = this.fx.push(FX_KILL);
      e.id = attacker.id;
      e.other = victim.id;
      e.weapon = weapon;
      e.flags = kf;
      e.x0 = victim.sim.x;
      e.y0 = victim.sim.y;
      this.w.reset();
      writeKill(this.w, attacker.id, victim.id, weapon, kf);
      this.broadcastR(this.w.bytes());
    }
  }

  private spawnPlayer(p: HostPlayer): void {
    const sp = this.pickSpawn(p.id);
    resetSimForSpawn(p.sim, sp.x, sp.y);
    copySim(p.prevSim, p.sim);
    p.alive = true;
    p.hp = MAX_HP;
    p.spawn = (p.spawn + 1) & 255;
    p.protectUntil = this.tick + MATCH.spawnProtectTicks;
    const e = this.fx.push(FX_SPAWN);
    e.id = p.id;
    e.x0 = sp.x;
    e.y0 = sp.y;
  }

  /** Spawn point far from living enemies, with a little randomness. */
  private pickSpawn(id: number): { x: number; y: number } {
    const spawns = this.map.spawns;
    let best = spawns[0];
    let bestScore = -Infinity;
    for (const s of spawns) {
      let minD = 1e12;
      for (let j = 1; j < SLOTS; j++) {
        const q = this.players[j];
        if (!q || j === id || !q.alive) continue;
        const dx = q.sim.x - s.x;
        const dy = q.sim.y - s.y;
        minD = Math.min(minD, dx * dx + dy * dy);
      }
      const score = Math.sqrt(minD) + Math.random() * 400;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }

  private captureFrame(): WorldFrame {
    const f = this.frames[this.tick % NET.hostFrameRing];
    f.clear();
    f.tick = this.tick;
    for (let id = 1; id < SLOTS; id++) {
      const p = this.players[id];
      if (!p) continue;
      f.setPlayer(id, p.sim, p.hp, p.flags(this.tick), p.spawn, p.kills, p.deaths);
    }
    this.interp.push(f);
    return f;
  }

  private sendSnapshots(frame: WorldFrame): void {
    for (let id = 1; id < SLOTS; id++) {
      const peer = this.peers[id];
      if (!peer || !peer.welcomed || !peer.transport.isOpen()) continue;
      peer.snapAccum++;
      if (peer.snapAccum < Math.round(TICK_RATE / peer.snapHz)) continue;
      peer.snapAccum = 0;
      // Congested link: drop this snapshot rather than queue stale state behind it.
      if (peer.transport.bufferedU() > NET.maxBufferedU) {
        peer.skippedBusy++;
        continue;
      }

      let base: WorldFrame | null = null;
      let baseSeq = -1;
      if (peer.ackSnap >= 0) {
        const i = peer.ackSnap % NET.peerSeqRing;
        if (peer.seqNum[i] === peer.ackSnap) {
          const bt = peer.seqTick[i];
          const bf = this.frames[bt % NET.hostFrameRing];
          if (bf.tick === bt && this.tick - bt < NET.hostFrameRing - 8 && seqDiff(seqNext(peer.snapSeq), peer.ackSnap) < NET.clientFrameRing - 4) {
            base = bf;
            baseSeq = peer.ackSnap;
          }
        }
      }

      peer.snapSeq = seqNext(peer.snapSeq);
      const si = peer.snapSeq % NET.peerSeqRing;
      peer.seqNum[si] = peer.snapSeq;
      peer.seqTick[si] = frame.tick;

      const p = this.players[id];
      const w = this.w.reset();
      writeSnapshot(w, peer.snapSeq, base, baseSeq, frame, id, p && p.ackValid ? p.lastProcessed : -1);

      // Cosmetic shot events since the last snapshot (others' shots only; own shots are predicted).
      const cntAt = w.mark();
      let n = 0;
      const from = Math.max(peer.lastEventSent, this.shotSeq - SHOT_RING);
      for (let s = from + 1; s <= this.shotSeq && n < MAX_EVENTS_PER_SNAPSHOT; s++) {
        const rec = this.shots[(s - 1) % SHOT_RING];
        if (rec.shooter === id) continue;
        writeShotEvent(w, rec);
        n++;
      }
      w.setU8(cntAt, n);
      peer.lastEventSent = this.shotSeq;
      this.sendU(peer, w.bytes());
    }
  }

  private sendU(peer: HostPeer, data: Uint8Array): void {
    if (peer.transport.sendU(data)) peer.up.add(data.byteLength, this.lastNow);
  }

  private broadcastR(data: Uint8Array): void {
    for (let id = 1; id < SLOTS; id++) {
      const peer = this.peers[id];
      if (peer?.welcomed && peer.transport.isOpen()) {
        peer.transport.sendR(data);
        peer.up.add(data.byteLength, this.lastNow);
      }
    }
  }

  private endMatch(): void {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    const rows: ResultRow[] = [];
    for (let id = 1; id < SLOTS; id++) {
      const p = this.players[id];
      if (p) rows.push({ id, kills: p.kills, deaths: p.deaths });
      else {
        const s = this.savedScores.get(id);
        if (s) rows.push({ id, kills: s.kills, deaths: s.deaths });
      }
    }
    rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.id - b.id);
    this.results = rows;
    this.w.reset();
    writeEnd(this.w, this.matchId, rows);
    this.broadcastR(this.w.bytes());
    this.onEnded?.(rows);
  }

  /** Ends the match early (host quitting). */
  abort(): void {
    this.endMatch();
  }

  // ---------------------------------------------------------------- MatchView

  collectPlayers(out: RenderPlayer[]): number {
    let n = 0;
    const alpha = this.acc / TICK_MS;
    const me = this.players[this.myId];
    if (me) {
      const o = out[n++];
      o.id = this.myId;
      o.x = me.prevSim.x + (me.sim.x - me.prevSim.x) * alpha;
      o.y = me.prevSim.y + (me.sim.y - me.prevSim.y) * alpha;
      o.vx = me.sim.vx;
      o.vy = me.sim.vy;
      o.aim = me.sim.aim;
      o.flags = me.flags(this.tick);
      o.hp = me.hp;
      o.weapon = me.sim.weapon;
      o.spawn = me.spawn;
      o.local = true;
    }
    const rt = this.tick + alpha - NET.hostViewDelayTicks;
    for (let id = 1; id < SLOTS; id++) {
      if (id === this.myId || !this.players[id]) continue;
      if (this.interp.sample(id, rt, out[n])) n++;
    }
    return n;
  }

  hud(out: HudInfo): void {
    const me = this.players[this.myId];
    if (!me) return;
    const w = WEAPONS[me.sim.weapon];
    out.alive = me.alive;
    out.hp = me.hp;
    out.ammo = me.sim.ammo;
    out.magSize = w.magSize;
    out.reload = me.sim.reload > 0 ? 1 - me.sim.reload / w.reloadTicks : 0;
    out.fuel = me.sim.fuel / MOVE.fuelMax;
    out.weapon = me.sim.weapon;
    out.kills = me.kills;
    out.deaths = me.deaths;
    out.timeLeftSec = Math.max(0, (this.endTick - this.tick) / TICK_RATE);
    out.respawnInSec = me.alive ? 0 : Math.max(0, (me.respawnAt - this.tick) / TICK_RATE);
    out.protected = me.alive && this.tick < me.protectUntil;
    out.connectingSec = -1;
  }

  net(out: NetInfo): void {
    let rtt = 0;
    let loss = 0;
    let jitter = 0;
    let up = 0;
    let down = 0;
    let corr = 0;
    let peers = 0;
    let hz: number = NET.snapshotHzDefault;
    for (let id = 1; id < SLOTS; id++) {
      const peer = this.peers[id];
      if (!peer || !peer.welcomed) continue;
      peers++;
      up += peer.up.kbps();
      down += peer.down.kbps();
      hz = Math.min(hz, peer.snapHz);
      if (peer.stats) {
        rtt = Math.max(rtt, peer.stats.rttMs);
        loss = Math.max(loss, peer.stats.lossPermille / 10);
        jitter = Math.max(jitter, peer.stats.jitterMs);
        corr += peer.stats.corrections;
      }
    }
    out.role = 'host';
    out.rttMs = rtt;
    out.lossPct = loss;
    out.jitterMs = jitter;
    out.quality = classifyQuality(rtt, loss, jitter);
    out.reconnecting = false;
    out.snapshotHz = hz;
    out.upKbps = up;
    out.downKbps = down;
    out.corrections = corr;
    out.interpDelayMs = NET.hostViewDelayTicks * TICK_MS;
    out.peers = peers;
  }

  scores(out: ScoreRow[]): number {
    let n = 0;
    for (let id = 1; id < SLOTS; id++) {
      const p = this.players[id];
      if (!p) continue;
      const row = out[n++];
      row.id = id;
      row.kills = p.kills;
      row.deaths = p.deaths;
      row.pingMs = id === this.myId ? 0 : (this.peers[id]?.stats?.rttMs ?? 0);
      row.connected = p.connected;
    }
    return n;
  }

  /** Authoritative state of a player (tests / debug overlay). */
  debugPlayer(id: number): { x: number; y: number; alive: boolean; hp: number; kills: number; deaths: number; lastProcessed: number } | null {
    const p = this.players[id];
    if (!p) return null;
    return { x: p.sim.x, y: p.sim.y, alive: p.alive, hp: p.hp, kills: p.kills, deaths: p.deaths, lastProcessed: p.lastProcessed };
  }

  /** Test/debug only: moves a player and ends its spawn protection. */
  debugTeleport(id: number, x: number, y: number): void {
    const p = this.players[id];
    if (!p) return;
    p.sim.x = p.prevSim.x = x;
    p.sim.y = p.prevSim.y = y;
    p.sim.vx = p.sim.vy = 0;
    p.protectUntil = 0;
  }

  /** Authoritative position of a player at a past tick, from the lag-compensation history. */
  debugPositionAt(id: number, tick: number): { x: number; y: number } | null {
    const p = this.players[id];
    if (!p) return null;
    const i = tick & (HIST - 1);
    return p.histTick[i] === tick ? { x: p.histX[i], y: p.histY[i] } : null;
  }

  /** Per-peer diagnostics for the debug overlay / tests. */
  peerDebug(id: number): { snapHz: number; inputsReceived: number; inputsFilled: number; inputsDropped: number; malformed: number } | null {
    const peer = this.peers[id];
    const p = this.players[id];
    if (!peer || !p) return null;
    return { snapHz: peer.snapHz, inputsReceived: p.inputsReceived, inputsFilled: p.inputsFilled, inputsDropped: p.inputsDropped, malformed: peer.malformed };
  }
}
