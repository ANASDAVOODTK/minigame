// Headless multiplayer tests: real host + client netcode over a simulated
// network with latency, jitter and packet loss. Prints a measurement table.
//   npm run test:netsim

import { describe, expect, it } from 'vitest';
import { runSimulation, summarize, type LinkConditions } from './netsim/harness';

const SCENARIOS: { name: string; players: number; cond: LinkConditions }[] = [
  { name: 'LAN', players: 2, cond: { rttMs: 4, jitterMs: 2, loss: 0 } },
  { name: '100ms', players: 2, cond: { rttMs: 100, jitterMs: 15, loss: 0 } },
  { name: '200ms', players: 2, cond: { rttMs: 200, jitterMs: 25, loss: 0 } },
  { name: '300ms', players: 2, cond: { rttMs: 300, jitterMs: 40, loss: 0 } },
  { name: '100ms 2% loss', players: 2, cond: { rttMs: 100, jitterMs: 15, loss: 0.02 } },
  { name: '150ms 5% loss', players: 2, cond: { rttMs: 150, jitterMs: 25, loss: 0.05 } },
  { name: '200ms 10% loss', players: 2, cond: { rttMs: 200, jitterMs: 30, loss: 0.1 } },
  { name: '4p 120ms 2%', players: 4, cond: { rttMs: 120, jitterMs: 20, loss: 0.02 } },
  { name: '8p 120ms 2%', players: 8, cond: { rttMs: 120, jitterMs: 20, loss: 0.02 } },
];

describe('netcode over simulated networks', () => {
  const rows: Record<string, unknown>[] = [];

  for (const sc of SCENARIOS) {
    it(`${sc.name} (${sc.players} players)`, () => {
      const r = runSimulation({ players: sc.players, cond: sc.cond, seconds: 20, seed: 42 });
      const s = summarize(r);
      for (const c of s) rows.push({ scenario: sc.name, ...c });

      // Prediction must converge to the authoritative state once inputs stop.
      expect(r.converged.every(Boolean)).toBe(true);
      for (const c of s) {
        // Every client stays connected and receives snapshots.
        expect(c.snapPerSec).toBeGreaterThan(8);
        // Bandwidth budget (payload): comfortably within slow 3G.
        expect(c.upKbps).toBeLessThan(25);
        expect(c.downKbps).toBeLessThan(12 + 6 * sc.players);
        // Deterministic shared simulation + input redundancy: mispredictions should be (near) zero.
        expect(c.corrections).toBeLessThanOrEqual(sc.cond.loss >= 0.1 ? 10 : sc.cond.loss > 0 ? 3 : 0);
        // Remote players are rendered close to where they really were.
        expect(c.interpErrAvg).toBeLessThan(2);
        // Measured loss tracks the configured loss.
        expect(Math.abs(c.measuredLossPct - sc.cond.loss * 100)).toBeLessThan(6);
      }
      // With several players fighting, hits are registered and players die.
      if (sc.players >= 4) expect(r.kills).toBeGreaterThan(0);
    });
  }

  it('prints the measurement table', () => {
    console.table(rows);
    expect(rows.length).toBeGreaterThan(0);
  });
});
