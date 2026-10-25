// Artificial network conditions for testing real WebRTC links in the browser:
// added latency, jitter, packet loss (unreliable channel only) and an upstream
// bandwidth cap. Applied on both send and receive of the conditioned peer, so
// enabling it on ONE browser adds the full configured round-trip latency.

import type { NetSimSettings } from '../config';

export class Conditioner {
  private lastReliableOut = 0;
  private lastReliableIn = 0;
  private tokens = 0;
  private lastRefill = performance.now();
  dropped = 0;

  constructor(readonly s: NetSimSettings) {
    this.tokens = this.bucketSize();
  }

  get active(): boolean {
    return this.s.lagMs > 0 || this.s.jitterMs > 0 || this.s.lossPct > 0 || this.s.bwKbps > 0;
  }

  private bucketSize(): number {
    return Math.max(1500, (this.s.bwKbps * 1000) / 8 / 4); // 250 ms burst
  }

  private oneWay(): number {
    // lag/2 when sending + lag/2 when receiving = full configured RTT from one conditioned peer.
    return this.s.lagMs / 2 + Math.random() * this.s.jitterMs;
  }

  /** Bandwidth gate: true if `bytes` may be sent now. */
  private takeBandwidth(bytes: number): boolean {
    if (this.s.bwKbps <= 0) return true;
    const now = performance.now();
    this.tokens = Math.min(this.bucketSize(), this.tokens + ((now - this.lastRefill) * this.s.bwKbps) / 8);
    this.lastRefill = now;
    if (this.tokens < bytes) return false;
    this.tokens -= bytes;
    return true;
  }

  send(reliable: boolean, data: Uint8Array, sendNow: (d: Uint8Array) => void): void {
    if (!this.active) return sendNow(data);
    if (!reliable && Math.random() * 100 < this.s.lossPct) {
      this.dropped++;
      return;
    }
    if (!this.takeBandwidth(data.byteLength + 60)) {
      if (!reliable) {
        this.dropped++;
        return;
      }
      // Reliable data over a saturated link: it just arrives later.
      const copy = data.slice();
      const wait = ((data.byteLength + 60) * 8) / Math.max(1, this.s.bwKbps);
      this.lastReliableOut = Math.max(performance.now() + wait, this.lastReliableOut);
      setTimeout(() => sendNow(copy), this.lastReliableOut - performance.now());
      return;
    }
    const copy = data.slice();
    let at = performance.now() + this.oneWay();
    if (reliable) at = this.lastReliableOut = Math.max(at, this.lastReliableOut);
    setTimeout(() => sendNow(copy), at - performance.now());
  }

  receive(reliable: boolean, data: ArrayBuffer, deliver: (d: ArrayBuffer) => void): void {
    if (!this.active) return deliver(data);
    if (!reliable && Math.random() * 100 < this.s.lossPct) {
      this.dropped++;
      return;
    }
    let at = performance.now() + this.oneWay();
    if (reliable) at = this.lastReliableIn = Math.max(at, this.lastReliableIn);
    setTimeout(() => deliver(data), at - performance.now());
  }
}
