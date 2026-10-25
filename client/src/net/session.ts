// A player's membership in a room: signaling WebSocket + WebRTC links.
//
// Topology is a star around the host: the host answers one PeerLink per player;
// every other player keeps exactly one PeerLink to the host (and is the offerer).
// Links are re-established automatically after failures.

import type { ClientMessage, IceServer, RoomInfo, RoomNotice, ServerMessage, SignalData } from '@minimi/shared';
import type { Settings } from '../config';
import { ApiError, api, signalingUrl } from './api';
import { Conditioner } from './conditioner';
import { PeerLink, type LinkHandlers } from './peerLink';
import { SignalingClient, type SignalingState } from './signaling';

export interface SessionEvents {
  room(room: RoomInfo, notice?: RoomNotice): void;
  error(code: string, message: string): void;
  /** The seat is gone (token expired / room closed). The UI should go home. */
  fatal(message: string): void;
  linkOpen(peerId: number, link: PeerLink): void;
  linkClose(peerId: number, link: PeerLink): void;
  message(peerId: number, data: ArrayBuffer): void;
  status(): void;
}

const ICE_REFRESH_MS = 60 * 60_000;
const LINK_TIMEOUT_MS = 15_000;

export class RoomSession {
  room: RoomInfo | null = null;
  /** performance.now() when `room` was received (for relative timers like auto-start). */
  roomAt = 0;
  readonly links = new Map<number, PeerLink>();
  signaling: SignalingClient;
  turnAvailable = false;
  readonly conditioner: Conditioner;

  private ice: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];
  private iceReady: Promise<void>;
  private iceFetchedAt = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastAttemptAt = 0;
  private attemptCount = 0;
  private disposed = false;
  private checkingSeat = false;
  private hostLostSentAt = 0;
  /** Desired ready state; re-sent until the room reflects it (survives reconnects). */
  private wantReady = false;
  private onOnline = () => this.signaling.nudge();

  constructor(
    readonly code: string,
    readonly myId: number,
    readonly token: string,
    private settings: Settings,
    private ev: SessionEvents,
  ) {
    this.conditioner = new Conditioner(settings.sim);
    this.signaling = new SignalingClient(() => signalingUrl(code, token), {
      onMessage: (m) => this.onServer(m),
      onState: (s) => this.onSignalingState(s),
      onRepeatedFailure: (n) => void this.checkSeat(n),
    });
    this.iceReady = this.refreshIce();
  }

  get isHost(): boolean {
    return !!this.room && this.room.hostId === this.myId;
  }

  get signalingState(): SignalingState {
    return this.signaling.state;
  }

  start(): void {
    // ICE servers first, so incoming offers can be answered synchronously (no lost candidates).
    void this.iceReady.finally(() => {
      if (!this.disposed) this.signaling.connect();
    });
    this.watchdog = setInterval(() => this.tick(), 1000);
    window.addEventListener('online', this.onOnline);
  }

  send(msg: ClientMessage): boolean {
    return this.signaling.send(msg);
  }

  hostLink(): PeerLink | null {
    if (!this.room || this.isHost) return null;
    const l = this.links.get(this.room.hostId);
    return l && l.state === 'open' ? l : null;
  }

  leave(): void {
    this.send({ t: 'leave' });
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    window.removeEventListener('online', this.onOnline);
    for (const l of this.links.values()) l.close('session ended');
    this.links.clear();
    this.signaling.close();
  }

  // ---------------------------------------------------------------- ICE / TURN

  private async refreshIce(): Promise<void> {
    try {
      const r = await api.turn(this.code, this.token);
      this.ice = r.iceServers as RTCIceServer[];
      this.turnAvailable = r.turn;
      this.iceFetchedAt = Date.now();
      for (const l of this.links.values()) l.updateIceServers(this.ice);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) void this.checkSeat(0);
      // Keep STUN-only defaults; direct connections still work for most players.
    }
  }

  /** ICE servers in the shape RTCPeerConnection wants. */
  private iceServers(): RTCIceServer[] {
    return this.ice.map((s: IceServer) => ({ ...s }) as RTCIceServer);
  }

  // ---------------------------------------------------------------- signaling

  private onSignalingState(_s: SignalingState): void {
    this.syncReady();
    this.ev.status();
  }

  setReady(ready: boolean): void {
    this.wantReady = ready;
    this.syncReady();
  }

  private syncReady(): void {
    const room = this.room;
    if (!room || room.phase !== 'lobby' || this.signaling.state !== 'open') return;
    const me = room.members.find((m) => m.id === this.myId);
    if (me && me.ready !== this.wantReady) this.send({ t: 'ready', ready: this.wantReady });
  }

  private async checkSeat(_attempts: number): Promise<void> {
    if (this.checkingSeat || this.disposed) return;
    this.checkingSeat = true;
    try {
      await api.rejoin(this.code, this.token);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 404)) {
        this.ev.fatal(e.status === 404 ? 'This room no longer exists.' : 'Your seat in this room has expired.');
        this.dispose();
      }
    } finally {
      this.checkingSeat = false;
    }
  }

  private onServer(m: ServerMessage): void {
    switch (m.t) {
      case 'welcome':
        this.applyRoom(m.room);
        break;
      case 'room':
        this.applyRoom(m.room, m.notice);
        break;
      case 'signal':
        this.onSignal(m.from, m.data);
        break;
      case 'error':
        this.ev.error(m.code, m.message);
        break;
    }
  }

  private applyRoom(room: RoomInfo, notice?: RoomNotice): void {
    const prevHost = this.room?.hostId;
    // A match started or ended: the room reset everyone's ready flag.
    if (this.room && this.room.phase !== room.phase) this.wantReady = false;
    this.room = room;
    this.roomAt = performance.now();
    if (!room.members.some((x) => x.id === this.myId)) {
      this.ev.fatal('You are no longer in this room.');
      this.dispose();
      return;
    }
    if (prevHost !== undefined && prevHost !== room.hostId) {
      // Host changed: every link belonged to the old star.
      for (const [id, l] of this.links) {
        this.links.delete(id);
        l.close('host changed');
      }
    }
    // Drop links to players who left.
    for (const [id, l] of this.links) {
      if (!room.members.some((x) => x.id === id)) {
        this.links.delete(id);
        l.close('player left');
      }
    }
    this.ev.room(room, notice);
    this.syncReady();
    this.tick();
  }

  private onSignal(from: number, data: SignalData): void {
    if (!this.room) return;
    if (this.isHost) {
      let link = this.links.get(from);
      if (data.sdp?.type === 'offer' && (!link || link.conn !== data.conn)) {
        // New connection attempt from this player (first join, reconnect or page reload).
        link?.close('replaced');
        link = this.createLink(from, data.conn, false);
      }
      if (link && link.conn === data.conn) link.handleSignal(data);
    } else {
      if (from !== this.room.hostId) return;
      const link = this.links.get(from);
      if (link && link.conn === data.conn) link.handleSignal(data);
    }
  }

  private createLink(peerId: number, conn: number, offerer: boolean): PeerLink {
    const handlers: LinkHandlers = {
      onSignal: (d) => this.send({ t: 'signal', to: peerId, data: d }),
      onOpen: (l) => {
        if (this.links.get(peerId) !== l) return;
        this.attemptCount = 0;
        this.ev.linkOpen(peerId, l);
        this.ev.status();
      },
      onClose: (l) => {
        if (this.links.get(peerId) === l) this.links.delete(peerId);
        this.ev.linkClose(peerId, l);
        this.ev.status();
      },
      onMessage: (_l, d) => this.ev.message(peerId, d),
    };
    const link = new PeerLink(peerId, conn, offerer, this.iceServers(), this.settings.relayOnly, handlers, this.conditioner);
    this.links.set(peerId, link);
    return link;
  }

  /** Once per second: make sure a non-host player has a working link to the host. */
  private tick(): void {
    if (this.disposed || !this.room) return;
    if (Date.now() - this.iceFetchedAt > ICE_REFRESH_MS && this.iceFetchedAt) {
      this.iceFetchedAt = Date.now();
      void this.refreshIce();
    }
    if (this.isHost) return;
    const hostId = this.room.hostId;
    const host = this.room.members.find((m) => m.id === hostId);
    const link = this.links.get(hostId);
    const now = performance.now();
    // Host offline on signaling AND unreachable over WebRTC: tell the room so the match ends quickly.
    if (this.room.phase === 'playing' && host && !host.connected && !link?.healthy(2500) && now - this.hostLostSentAt > 5000) {
      this.hostLostSentAt = now;
      this.send({ t: 'host_lost' });
    }
    if (link && link.state === 'connecting' && now - link.createdAt > LINK_TIMEOUT_MS) {
      this.links.delete(hostId);
      link.close('timeout');
    }
    if (this.links.has(hostId) || !host?.connected || this.signaling.state !== 'open') return;
    const backoff = Math.min(8000, 500 * 2 ** this.attemptCount);
    if (now - this.lastAttemptAt < backoff) return;
    this.lastAttemptAt = now;
    this.attemptCount++;
    const conn = 1 + Math.floor(Math.random() * 999_998);
    this.createLink(hostId, conn, true); // negotiationneeded fires -> offer
  }
}
