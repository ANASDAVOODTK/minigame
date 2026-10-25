// Estimates the host's clock from snapshot arrival times and measures jitter.
//
// sample = hostTickTime - localArrivalTime. The largest sample in a sliding
// window corresponds to the least-delayed packet, so `offset` (window max)
// maps local time to "host time as seen through the fastest path". How much
// later than that other packets arrive (lateness) is the jitter that the
// interpolation delay must absorb.

import { TICK_MS } from './config';

const WINDOW = 64;

export class TimeSync {
  private samples = new Float64Array(WINDOW);
  private sorted = new Float64Array(WINDOW);
  private n = 0;
  private idx = 0;
  private target = 0;
  /** hostTimeMs ~= localMs + offset */
  offset = 0;
  hasSample = false;
  /** 95th percentile of packet lateness over the window (ms). */
  lateP95 = 0;
  /** Mean lateness (ms) - reported as "jitter". */
  lateMean = 0;

  reset(): void {
    this.n = 0;
    this.idx = 0;
    this.hasSample = false;
  }

  addSample(hostTick: number, localMs: number): void {
    const s = hostTick * TICK_MS - localMs;
    this.samples[this.idx] = s;
    this.idx = (this.idx + 1) % WINDOW;
    if (this.n < WINDOW) this.n++;

    let max = -Infinity;
    for (let i = 0; i < this.n; i++) if (this.samples[i] > max) max = this.samples[i];
    this.target = max;
    if (!this.hasSample || Math.abs(max - this.offset) > 400) {
      this.offset = max;
      this.hasSample = true;
    }

    // Lateness distribution (insertion sort into a preallocated array: no allocation).
    let sum = 0;
    for (let i = 0; i < this.n; i++) {
      const late = max - this.samples[i];
      sum += late;
      let j = i - 1;
      while (j >= 0 && this.sorted[j] > late) {
        this.sorted[j + 1] = this.sorted[j];
        j--;
      }
      this.sorted[j + 1] = late;
    }
    this.lateMean = sum / this.n;
    this.lateP95 = this.sorted[Math.floor((this.n - 1) * 0.95)];
  }

  /** Slews the offset toward the window max (at most 5% time warp) to avoid visible jumps. */
  update(dtMs: number): void {
    if (!this.hasSample) return;
    const d = this.target - this.offset;
    const maxStep = dtMs * 0.05;
    this.offset += d > maxStep ? maxStep : d < -maxStep ? -maxStep : d;
  }

  hostTimeMs(localMs: number): number {
    return localMs + this.offset;
  }
}
