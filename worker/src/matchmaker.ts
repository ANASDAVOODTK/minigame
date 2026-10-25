// Single global Durable Object listing public ("Play Online") rooms with free
// seats. Rooms report their own state here; entries that stop reporting expire.

import { DurableObject } from 'cloudflare:workers';
import type { RoomPhase } from '@minimi/shared';
import type { Env } from './env';

export interface PublicRoomState {
  count: number;
  max: number;
  connected: number;
  phase: RoomPhase;
}

interface Entry extends PublicRoomState {
  updatedAt: number;
}

const STALE_MS = 3 * 60_000;

export class Matchmaker extends DurableObject<Env> {
  private rooms = new Map<string, Entry>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<Record<string, Entry>>('rooms');
      if (saved) for (const [k, v] of Object.entries(saved)) this.rooms.set(k, v);
    });
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put('rooms', Object.fromEntries(this.rooms));
  }

  async upsert(code: string, s: PublicRoomState): Promise<void> {
    this.rooms.set(code, { ...s, updatedAt: Date.now() });
    await this.persist();
  }

  async remove(code: string): Promise<void> {
    if (this.rooms.delete(code)) await this.persist();
  }

  /** Best public room to join: has a free seat and live players; lobbies first, then the fullest. */
  async find(exclude: string[] = []): Promise<string | null> {
    const now = Date.now();
    let pruned = false;
    let best: [string, Entry] | null = null;
    for (const [code, e] of this.rooms) {
      if (now - e.updatedAt > STALE_MS) {
        this.rooms.delete(code);
        pruned = true;
        continue;
      }
      // A room nobody is connected to is dead, unless it was just created (its
      // creator's WebSocket may still be opening).
      const dead = e.connected === 0 && now - e.updatedAt > 10_000;
      if (e.count >= e.max || dead || exclude.includes(code)) continue;
      if (!best) {
        best = [code, e];
        continue;
      }
      const b = best[1];
      const lobbyFirst = Number(e.phase === 'lobby') - Number(b.phase === 'lobby');
      if (lobbyFirst > 0 || (lobbyFirst === 0 && e.count > b.count)) best = [code, e];
    }
    if (pruned) await this.persist();
    return best ? best[0] : null;
  }
}
