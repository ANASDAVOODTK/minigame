// Reconnection: a client whose page reloads mid-match comes back with a brand-new
// ClientMatch (input sequence restarts at 0). The host must accept the new input
// stream immediately instead of discarding it as "old".

import { describe, expect, it } from 'vitest';
import { ClientMatch } from '../client/src/core/client';
import { HostMatch } from '../client/src/core/host';
import type { InputState } from '../client/src/core/input';
import { SimNet, SimPipe } from './netsim/harness';

describe('client reconnect / page reload', () => {
  it('host accepts the reloaded client input stream right away', () => {
    const net = new SimNet(3);
    const cond = { rttMs: 80, jitterMs: 10, loss: 0 };
    const host = new HostMatch({ matchId: 1, mapId: 0, durationSec: 120, hostId: 1, nowMs: 0 });
    const idle: InputState = { buttons: 0, moveX: 0, aim: 0 };

    const connect = () => {
      let c!: ClientMatch;
      const from = new SimPipe(net, cond, (b) => c.onMessage(b));
      const to = new SimPipe(net, cond, (b) => host.onMessage(2, b));
      host.attachPeer(2, from);
      c = new ClientMatch({ myId: 2, transport: to, nowMs: net.now, clock: () => net.now });
      return { c, from, to };
    };

    let t = 0;
    let link = connect();
    const run = (until: number, input: InputState) => {
      while (t < until) {
        t += 1000 / 60;
        net.runUntil(t);
        host.update(t, idle);
        link.c.update(t, input);
      }
    };

    // Play for 12 s (the input sequence reaches ~700).
    host.debugTeleport(2, 1552, 812);
    run(12_000, { buttons: 0, moveX: 64, aim: 0 });
    expect(host.debugPlayer(2)!.lastProcessed).toBeGreaterThan(600);

    // "Reload": the old link dies, a fresh client connects with seq starting at 0.
    link.from.open = link.to.open = false;
    host.detachPeer(2, link.from);
    run(13_000, idle);
    host.debugTeleport(2, 1552, 812);
    link = connect();
    run(15_000, idle); // HELLO + WELCOME + spawn sync
    const before = host.debugPlayer(2)!.x;
    run(17_000, { buttons: 0, moveX: -127, aim: 0 }); // run left for 2 s

    const after = host.debugPlayer(2)!.x;
    expect(before - after).toBeGreaterThan(150); // moved left on the host: inputs were accepted
    // Once inputs stop, the prediction converges exactly to the host state.
    run(18_000, idle);
    expect(link.c.predictor.state.x).toBe(host.debugPlayer(2)!.x);
    expect(link.c.predictor.state.y).toBe(host.debugPlayer(2)!.y);
  });
});
