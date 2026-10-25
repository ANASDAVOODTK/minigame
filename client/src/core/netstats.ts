// Packet loss and bandwidth measurement.

import { seqDiff } from './seq';

/** Tracks which u16 sequence numbers arrived; loss = missing / expected over a window. */
export class LossTracker {
  private bits = new Uint8Array(256);
  private highest = -1;
  private span = 0;

  reset(): void {
    this.highest = -1;
    this.span = 0;
  }

  onSeq(seq: number): void {
    if (this.highest < 0) {
      this.bits.fill(0);
      this.highest = seq;
      this.bits[seq & 255] = 1;
      this.span = 1;
      return;
    }
    const d = seqDiff(seq, this.highest);
    if (d > 0) {
      if (d >= 256) {
        this.bits.fill(0);
      } else {
        for (let k = 1; k < d; k++) this.bits[(this.highest + k) & 255] = 0;
      }
      this.bits[seq & 255] = 1;
      this.highest = seq;
      this.span = Math.min(256, this.span + d);
    } else if (d > -256 && -d < this.span) {
      this.bits[seq & 255] = 1; // late (reordered) arrival
    }
  }

  /** Loss ratio 0..1 over the last `window` sequence numbers. */
  loss(window = 100): number {
    const n = Math.min(this.span, window);
    if (n < 10) return 0;
    let got = 0;
    for (let i = 0; i < n; i++) got += this.bits[(this.highest - i) & 255];
    return 1 - got / n;
  }
}

/** Bytes per second, averaged over ~1 s buckets. */
export class RateMeter {
  private acc = 0;
  private windowStart = -1;
  bytesPerSec = 0;
  total = 0;

  add(bytes: number, nowMs: number): void {
    this.acc += bytes;
    this.total += bytes;
    this.tick(nowMs);
  }

  tick(nowMs: number): void {
    if (this.windowStart < 0) this.windowStart = nowMs;
    const el = nowMs - this.windowStart;
    if (el >= 1000) {
      this.bytesPerSec = (this.acc * 1000) / el;
      this.acc = 0;
      this.windowStart = nowMs;
    }
  }

  kbps(): number {
    return (this.bytesPerSec * 8) / 1000;
  }
}

/** Rough per-packet overhead of a DataChannel message on the wire (IP+UDP+DTLS+SCTP). */
export const WIRE_OVERHEAD_BYTES = 60;
