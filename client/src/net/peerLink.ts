// One WebRTC peer connection with two DataChannels:
//   "u": ordered=false, maxRetransmits=0  -> inputs, snapshots, pings (stale data is useless)
//   "r": ordered, reliable                -> joins, kills, match end (must arrive)
// Both are pre-negotiated (fixed SCTP stream ids), so no extra round trip and no
// ondatachannel race. SCTP streams are independent: a retransmitting reliable
// message never blocks the unreliable stream.

import type { SignalData } from '@minimi/shared';
import type { PeerTransport } from '../core/transport';
import type { Conditioner } from './conditioner';

export type LinkState = 'connecting' | 'open' | 'closed';
export type LinkRoute = 'direct' | 'relay' | 'unknown';

export interface LinkHandlers {
  onSignal(data: SignalData): void;
  onOpen(link: PeerLink): void;
  onClose(link: PeerLink, reason: string): void;
  onMessage(link: PeerLink, data: ArrayBuffer): void;
}

const MAX_BUFFERED_R = 512 * 1024;

export class PeerLink implements PeerTransport {
  state: LinkState = 'connecting';
  route: LinkRoute = 'unknown';
  /** RTT of the selected ICE candidate pair (from getStats), ms. */
  iceRttMs = 0;
  /** Actual bytes on the wire (including DTLS/SCTP overhead), from getStats. */
  wireBytesSent = 0;
  wireBytesReceived = 0;
  wireUpKbps = 0;
  wireDownKbps = 0;
  readonly createdAt = performance.now();
  openedAt = 0;
  /** performance.now() of the last message received on either channel. */
  lastRecvAt = 0;

  private pc: RTCPeerConnection;
  private u: RTCDataChannel;
  private r: RTCDataChannel;
  private pendingIce: RTCIceCandidateInit[] = [];
  private remoteSet = false;
  private chain: Promise<void> = Promise.resolve();
  private statsTimer: ReturnType<typeof setInterval>;
  private disconnectedTimer: ReturnType<typeof setTimeout> | null = null;
  private restarts = 0;
  private lastStatsAt = 0;

  constructor(
    readonly remoteId: number,
    readonly conn: number,
    readonly offerer: boolean,
    iceServers: RTCIceServer[],
    relayOnly: boolean,
    private h: LinkHandlers,
    private cond: Conditioner,
  ) {
    this.pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: relayOnly ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
    });
    this.u = this.pc.createDataChannel('u', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    this.r = this.pc.createDataChannel('r', { negotiated: true, id: 1, ordered: true });
    for (const [ch, reliable] of [
      [this.u, false],
      [this.r, true],
    ] as const) {
      ch.binaryType = 'arraybuffer';
      ch.onopen = () => this.checkOpen();
      ch.onclose = () => this.close('channel closed');
      ch.onerror = () => {
        /* followed by close */
      };
      ch.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer) || this.state === 'closed') return;
        this.lastRecvAt = performance.now();
        this.cond.receive(reliable, ev.data, (d) => this.state !== 'closed' && this.h.onMessage(this, d));
      };
    }
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate && ev.candidate.candidate) this.h.onSignal({ conn: this.conn, ice: ev.candidate.toJSON() as SignalData['ice'] });
    };
    this.pc.onconnectionstatechange = () => this.onConnState();
    this.pc.oniceconnectionstatechange = () => this.onIceState();
    if (offerer) this.pc.onnegotiationneeded = () => this.serial(() => this.makeOffer());
    this.statsTimer = setInterval(() => void this.pollStats(), 2000);
  }

  private serial(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn).catch((e) => console.warn('[link]', e));
  }

  private async makeOffer(): Promise<void> {
    if (this.state === 'closed') return;
    await this.pc.setLocalDescription();
    const d = this.pc.localDescription!;
    this.h.onSignal({ conn: this.conn, sdp: { type: d.type as 'offer', sdp: d.sdp } });
  }

  handleSignal(data: SignalData): void {
    this.serial(async () => {
      if (this.state === 'closed') return;
      if (data.sdp) {
        if (data.sdp.type === 'offer' && this.offerer) return; // we never accept offers as offerer (no glare)
        await this.pc.setRemoteDescription(data.sdp);
        this.remoteSet = true;
        for (const c of this.pendingIce.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
        if (data.sdp.type === 'offer') {
          await this.pc.setLocalDescription();
          const d = this.pc.localDescription!;
          this.h.onSignal({ conn: this.conn, sdp: { type: d.type as 'answer', sdp: d.sdp } });
        }
      } else if (data.ice) {
        if (!this.remoteSet) this.pendingIce.push(data.ice);
        else await this.pc.addIceCandidate(data.ice).catch(() => {});
      }
    });
  }

  private checkOpen(): void {
    if (this.state !== 'connecting') return;
    if (this.u.readyState === 'open' && this.r.readyState === 'open') {
      this.state = 'open';
      this.openedAt = performance.now();
      void this.pollStats();
      this.h.onOpen(this);
    }
  }

  private onConnState(): void {
    const s = this.pc.connectionState;
    if (s === 'failed') {
      if (this.offerer && this.restarts < 2) this.restartIce();
      else this.close('connection failed');
    } else if (s === 'closed') this.close('connection closed');
  }

  private onIceState(): void {
    const s = this.pc.iceConnectionState;
    if (s === 'disconnected') {
      // Often recovers by itself (network blip); otherwise restart ICE.
      if (!this.disconnectedTimer && this.offerer) this.disconnectedTimer = setTimeout(() => this.restartIce(), 2500);
    } else if (s === 'connected' || s === 'completed') {
      if (this.disconnectedTimer) clearTimeout(this.disconnectedTimer);
      this.disconnectedTimer = null;
      void this.pollStats();
    }
  }

  private restartIce(): void {
    if (this.state === 'closed' || !this.offerer) return;
    if (this.disconnectedTimer) clearTimeout(this.disconnectedTimer);
    this.disconnectedTimer = null;
    this.restarts++;
    this.pc.restartIce(); // triggers negotiationneeded -> new offer with fresh ICE credentials
  }

  /** Swap in fresh TURN credentials (e.g. before they expire). */
  updateIceServers(iceServers: RTCIceServer[]): void {
    try {
      this.pc.setConfiguration({ ...this.pc.getConfiguration(), iceServers });
    } catch {
      /* ignore */
    }
  }

  private async pollStats(): Promise<void> {
    if (this.state === 'closed') return;
    let report: RTCStatsReport;
    try {
      report = await this.pc.getStats();
    } catch {
      return;
    }
    let pair: RTCIceCandidatePairStats | undefined;
    report.forEach((s) => {
      if (s.type === 'transport' && (s as RTCTransportStats).selectedCandidatePairId) {
        pair = report.get((s as RTCTransportStats).selectedCandidatePairId!) as RTCIceCandidatePairStats;
      }
    });
    if (!pair) {
      report.forEach((s) => {
        const p = s as RTCIceCandidatePairStats & { selected?: boolean };
        if (s.type === 'candidate-pair' && (p.selected || (p.nominated && p.state === 'succeeded'))) pair = p;
      });
    }
    if (!pair) return;
    const local = report.get(pair.localCandidateId) as { candidateType?: string } | undefined;
    const remote = report.get(pair.remoteCandidateId) as { candidateType?: string } | undefined;
    this.route = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : local ? 'direct' : 'unknown';
    if (pair.currentRoundTripTime !== undefined) this.iceRttMs = pair.currentRoundTripTime * 1000;
    const now = performance.now();
    const sent = pair.bytesSent ?? 0;
    const recv = pair.bytesReceived ?? 0;
    if (this.lastStatsAt) {
      const dt = (now - this.lastStatsAt) / 1000;
      this.wireUpKbps = ((sent - this.wireBytesSent) * 8) / 1000 / dt;
      this.wireDownKbps = ((recv - this.wireBytesReceived) * 8) / 1000 / dt;
    }
    this.lastStatsAt = now;
    this.wireBytesSent = sent;
    this.wireBytesReceived = recv;
  }

  /**
   * Open and actually alive. A peer that vanished (tab closed, network gone) can leave the
   * DataChannels "open" for many seconds until ICE consent fails; callers that expect a
   * steady stream (snapshots during a match) can pass silenceMs to detect that sooner.
   */
  healthy(silenceMs = Infinity): boolean {
    if (this.state !== 'open') return false;
    const ice = this.pc.iceConnectionState;
    if (ice === 'disconnected' || ice === 'failed' || ice === 'closed') return false;
    return performance.now() - Math.max(this.lastRecvAt, this.openedAt) < silenceMs;
  }

  // ---------------------------------------------------------------- PeerTransport

  sendU(data: Uint8Array): boolean {
    if (this.state !== 'open' || this.u.readyState !== 'open') return false;
    // Don't queue fresh state behind stale state on a congested link.
    if (this.u.bufferedAmount > 8 * 1024) return false;
    this.cond.send(false, data, (d) => {
      try {
        if (this.u.readyState === 'open') this.u.send(d as Uint8Array<ArrayBuffer>);
      } catch {
        /* closing */
      }
    });
    return true;
  }

  sendR(data: Uint8Array): boolean {
    if (this.state !== 'open' || this.r.readyState !== 'open') return false;
    if (this.r.bufferedAmount > MAX_BUFFERED_R) return false;
    this.cond.send(true, data, (d) => {
      try {
        if (this.r.readyState === 'open') this.r.send(d as Uint8Array<ArrayBuffer>);
      } catch {
        /* closing */
      }
    });
    return true;
  }

  bufferedU(): number {
    return this.u.readyState === 'open' ? this.u.bufferedAmount : 0;
  }

  isOpen(): boolean {
    return this.state === 'open';
  }

  close(reason = 'closed'): void {
    if (this.state === 'closed') return;
    const wasOpen = this.state === 'open';
    this.state = 'closed';
    clearInterval(this.statsTimer);
    if (this.disconnectedTimer) clearTimeout(this.disconnectedTimer);
    try {
      this.u.close();
      this.r.close();
      this.pc.close();
    } catch {
      /* ignore */
    }
    if (wasOpen || reason) this.h.onClose(this, reason);
  }
}
