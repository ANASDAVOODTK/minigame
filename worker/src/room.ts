// One Durable Object instance per room code. Responsibilities:
//  - room membership, settings, ready state, match metadata (phase / matchId)
//  - host selection (the owner's browser runs the authoritative game simulation)
//  - reconnect tokens (expiring) and room expiry
//  - relaying WebRTC signaling (SDP / ICE) between the host and each player
//  - public rooms: report to the matchmaker, auto-start
// It is NOT a game server: no gameplay traffic ever reaches it.

import { DurableObject } from 'cloudflare:workers';
import {
  parseClientMessage,
  type RoomInfo,
  type RoomNotice,
  type RoomSettings,
  type ServerMessage,
} from '@minimi/shared';
import type { Env } from './env';
import { Room, newRoom, type RoomData } from './roomState';

interface SocketAttachment {
  id: number;
}

export type RoomRpcResult =
  | { ok: true; playerId: number; token: string; room: RoomInfo }
  | { ok: false; status: number; error: string; message: string };

// Signaling rate limit per player: bursts of ICE candidates are normal, floods are not.
const BUCKET_CAPACITY = 80;
const BUCKET_REFILL_PER_SEC = 25;
const MAX_DROPS_BEFORE_CLOSE = 400;
const WS_OPEN = 1;

export class RoomDO extends DurableObject<Env> {
  private data: RoomData | null = null;
  private buckets = new Map<number, { tokens: number; last: number; drops: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.data = (await ctx.storage.get<RoomData>('room')) ?? null;
    });
    // Keep-alive pings are answered without waking the object from hibernation.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // ---------------------------------------------------------------- RPC (called by the Worker)

  async create(code: string, settings: RoomSettings, name: unknown, color: unknown, isPublic = false): Promise<RoomRpcResult> {
    if (this.data) return { ok: false, status: 409, error: 'exists', message: 'Room code collision.' };
    const now = Date.now();
    this.data = newRoom(code, settings, now, isPublic);
    const room = new Room(this.data);
    const res = room.join(name, color, undefined, now);
    if (!res.ok) {
      this.data = null;
      return res;
    }
    await this.commit(room, undefined, false);
    return { ok: true, playerId: res.member.id, token: res.member.token, room: room.info(now) };
  }

  async join(name: unknown, color: unknown, token: unknown, rejoinOnly = false, publicOnly = false): Promise<RoomRpcResult> {
    if (!this.data) return { ok: false, status: 404, error: 'room_not_found', message: 'Room not found. Check the code.' };
    if (publicOnly && !this.data.public) return { ok: false, status: 404, error: 'room_not_found', message: 'Room not found.' };
    const now = Date.now();
    const room = new Room(this.data);
    const res = room.join(name, color, typeof token === 'string' ? token : undefined, now, rejoinOnly === true);
    if (!res.ok) return res;
    await this.commit(room, undefined, !res.rejoined);
    return { ok: true, playerId: res.member.id, token: res.member.token, room: room.info(now) };
  }

  /** Returns the player id owning the token, or 0. Used before issuing TURN credentials. */
  async validateToken(token: unknown): Promise<number> {
    if (!this.data || typeof token !== 'string') return 0;
    return new Room(this.data).byToken(token, Date.now())?.id ?? 0;
  }

  // ---------------------------------------------------------------- WebSocket signaling

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    if (!this.data) return new Response('Room not found', { status: 404 });
    const now = Date.now();
    const room = new Room(this.data);
    const token = new URL(request.url).searchParams.get('token') ?? '';
    const member = room.byToken(token, now);
    if (!member) return new Response('Invalid or expired token', { status: 401 });

    // One live socket per player: a newer tab/reconnect replaces the old one.
    for (const old of this.ctx.getWebSockets(`p${member.id}`)) {
      try {
        old.close(4000, 'replaced');
      } catch {
        /* already closed */
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [`p${member.id}`]);
    server.serializeAttachment({ id: member.id } satisfies SocketAttachment);

    room.connect(member.id, now);
    room.updateAutoStart(now);
    server.send(JSON.stringify({ t: 'welcome', you: member.id, room: room.info(now) } satisfies ServerMessage));
    await this.commit(room, undefined, true, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    if (!att) return ws.close(4001, 'unauthenticated');
    if (!this.data) return ws.close(4004, 'room_closed');
    if (typeof message !== 'string') return;
    if (!this.takeToken(att.id)) {
      if (this.buckets.get(att.id)!.drops > MAX_DROPS_BEFORE_CLOSE) ws.close(4008, 'rate_limited');
      return;
    }
    const msg = parseClientMessage(message);
    if (!msg) return this.sendError(ws, 'bad_message', 'Malformed message.');

    const room = new Room(this.data);
    const me = room.member(att.id);
    if (!me) return ws.close(4003, 'not_a_member');
    const now = Date.now();

    switch (msg.t) {
      case 'signal': {
        // Star topology: every peer connection involves the host.
        if (msg.to === att.id) return;
        if (att.id !== this.data.hostId && msg.to !== this.data.hostId) return;
        if (!room.member(msg.to)) return;
        this.sendTo(msg.to, { t: 'signal', from: att.id, data: msg.data });
        return;
      }
      case 'ready':
        if (room.setReady(att.id, msg.ready)) await this.commit(room);
        return;
      case 'settings': {
        const err = room.updateSettings(att.id, msg.settings);
        if (err) return this.sendError(ws, err, 'Settings could not be changed.');
        await this.commit(room);
        return;
      }
      case 'start': {
        const err = room.start(att.id);
        if (err) return this.sendError(ws, err, startErrorText(err));
        await this.commit(room);
        return;
      }
      case 'end':
        if (room.end(att.id, msg.matchId)) await this.commit(room, 'match_ended');
        return;
      case 'host_lost':
        if (room.reportHostLost(att.id, now)) {
          await this.save();
          await this.scheduleAlarm(room, now);
        }
        return;
      case 'leave': {
        const notice = room.leave(att.id, now);
        this.buckets.delete(att.id);
        await this.commit(room, notice);
        try {
          ws.close(1000, 'left');
        } catch {
          /* ignore */
        }
        return;
      }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    await this.onSocketGone(ws);
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {
      /* already closed */
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.onSocketGone(ws);
  }

  override async alarm(): Promise<void> {
    if (!this.data) return;
    const now = Date.now();
    const room = new Room(this.data);
    const res = room.tick(now);
    if (res.destroy) {
      await this.destroy();
      return;
    }
    if (res.changed) await this.commit(room, res.notice);
    else {
      await this.save(); // token expiry refresh
      await this.scheduleAlarm(room, now);
      await this.reportPublic(room);
    }
  }

  // ---------------------------------------------------------------- helpers

  private async destroy(): Promise<void> {
    const code = this.data?.code;
    const wasPublic = this.data?.public;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4004, 'room_closed');
      } catch {
        /* ignore */
      }
    }
    this.data = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    if (wasPublic && code) await this.matchmaker().remove(code).catch(() => {});
  }

  private async onSocketGone(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    if (!att || !this.data) return;
    const stillOpen = this.ctx
      .getWebSockets(`p${att.id}`)
      .some((s) => s !== ws && s.readyState === WS_OPEN);
    if (stillOpen) return;
    const room = new Room(this.data);
    if (!room.member(att.id)) return; // left explicitly
    room.disconnect(att.id, Date.now());
    await this.commit(room);
  }

  /** Persist, broadcast the new room state, reschedule housekeeping, update the matchmaker. */
  private async commit(room: Room, notice?: RoomNotice, broadcast = true, except?: WebSocket): Promise<void> {
    const now = Date.now();
    room.updateAutoStart(now);
    await this.save();
    if (broadcast) this.broadcast({ t: 'room', room: room.info(now), notice }, except);
    await this.scheduleAlarm(room, now);
    await this.reportPublic(room);
  }

  private matchmaker() {
    return this.env.MATCHMAKER.get(this.env.MATCHMAKER.idFromName('global'));
  }

  private async reportPublic(room: Room): Promise<void> {
    if (!room.d.public) return;
    try {
      await this.matchmaker().upsert(room.d.code, {
        count: room.d.members.length,
        max: room.d.settings.maxPlayers,
        connected: room.connectedCount(),
        phase: room.d.phase,
      });
    } catch (err) {
      console.error('matchmaker report failed', err);
    }
  }

  private async save(): Promise<void> {
    if (this.data) await this.ctx.storage.put('room', this.data);
  }

  private async scheduleAlarm(room: Room, now: number): Promise<void> {
    const want = room.nextAlarmAt(now);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > want || current < now) await this.ctx.storage.setAlarm(want);
  }

  private broadcast(msg: ServerMessage, except?: WebSocket): void {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(s);
      } catch {
        /* socket closing */
      }
    }
  }

  private sendTo(id: number, msg: ServerMessage): void {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets(`p${id}`)) {
      try {
        ws.send(s);
      } catch {
        /* socket closing */
      }
    }
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    try {
      ws.send(JSON.stringify({ t: 'error', code, message } satisfies ServerMessage));
    } catch {
      /* ignore */
    }
  }

  private takeToken(id: number): boolean {
    const now = Date.now();
    let b = this.buckets.get(id);
    if (!b) {
      b = { tokens: BUCKET_CAPACITY, last: now, drops: 0 };
      this.buckets.set(id, b);
    }
    b.tokens = Math.min(BUCKET_CAPACITY, b.tokens + ((now - b.last) / 1000) * BUCKET_REFILL_PER_SEC);
    b.last = now;
    if (b.tokens < 1) {
      b.drops++;
      return false;
    }
    b.tokens -= 1;
    return true;
  }
}

function startErrorText(code: string): string {
  switch (code) {
    case 'not_owner':
      return 'Only the room owner can start the match.';
    case 'need_two_players':
      return 'At least 2 connected players are needed.';
    case 'not_all_ready':
      return 'Waiting for every player to be ready.';
    case 'match_running':
      return 'A match is already running.';
    default:
      return 'Cannot start the match.';
  }
}
