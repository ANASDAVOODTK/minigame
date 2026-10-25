// Lag compensation: a client with 200 ms RTT shoots at where it *sees* a moving
// target. On the host the target has already moved on, yet the hit must count,
// because the host rewinds the target to the shooter's render time.

import { describe, expect, it } from 'vitest';
import { ClientMatch } from '../client/src/core/client';
import { HostMatch } from '../client/src/core/host';
import { BTN, aimFromAngle, type InputState } from '../client/src/core/input';
import { NET, PLAYER_HH, PLAYER_HW, SHOULDER_Y } from '../client/src/core/config';
import { makeRenderPlayer } from '../client/src/core/view';
import { SimNet, SimPipe } from './netsim/harness';

function setup(rttMs: number) {
  const net = new SimNet(7);
  const cond = { rttMs, jitterMs: 0, loss: 0 };
  const host = new HostMatch({ matchId: 1, mapId: 0, durationSec: 120, hostId: 1, nowMs: 0 });
  let client!: ClientMatch;
  const fromHost = new SimPipe(net, cond, (b) => client.onMessage(b));
  const toHost = new SimPipe(net, cond, (b) => host.onMessage(2, b));
  host.attachPeer(2, fromHost);
  client = new ClientMatch({ myId: 2, transport: toHost, nowMs: 0, clock: () => net.now });
  return { net, host, client };
}

describe('lag compensation', () => {
  it('registers a hit on a target that has moved on the host since the shooter saw it', () => {
    const { net, host, client } = setup(200);
    const hostIn: InputState = { buttons: 0, moveX: 0, aim: 0 };
    const cliIn: InputState = { buttons: 0, moveX: 0, aim: 0 };
    const render = Array.from({ length: 9 }, makeRenderPlayer);
    let t = 0;
    const frame = () => {
      t += 1000 / 60;
      net.runUntil(t);
      host.update(t, hostIn);
      client.update(t, cliIn);
    };

    // Join, then place both players on flat ground ~190 px apart (desert map).
    while (t < 1500) frame();
    expect(client.phase).toBe('live');
    host.debugTeleport(1, 1744, 812); // target (host player)
    host.debugTeleport(2, 1552, 812); // shooter (client)
    while (t < 3000) frame();

    // Target jets straight up.
    hostIn.buttons = BTN.JET;
    while (t < 3400) frame();

    // Client aims at the target exactly where it renders it, and fires one shot.
    const n = client.collectPlayers(render);
    const me = render.slice(0, n).find((p) => p.local)!;
    const target = render.slice(0, n).find((p) => p.id === 1)!;
    expect(me).toBeTruthy();
    expect(target).toBeTruthy();
    cliIn.aim = aimFromAngle(Math.atan2(target.y - (me.y + SHOULDER_Y), target.x - me.x));
    cliIn.buttons = BTN.FIRE;
    frame();
    cliIn.buttons = 0;

    // On the host the target is already much higher than what the shooter saw...
    const hostTarget = host.debugPlayer(1)!;
    expect(target.y - hostTarget.y).toBeGreaterThan(2 * PLAYER_HH + PLAYER_HW);

    // ...but after the shot reaches the host, the hit is registered.
    while (t < 4200) frame();
    expect(host.debugPlayer(1)!.hp).toBeLessThan(100);
  });

  it('does not rewind further than the configured limit', () => {
    expect(NET.maxRewindTicks).toBeLessThanOrEqual(30);
  });
});
