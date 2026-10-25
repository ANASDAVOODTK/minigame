// Worker entry: HTTP API + static assets. Gameplay traffic never touches the Worker;
// it flows peer-to-peer over WebRTC (direct, or via Cloudflare TURN relay).
//
//   GET  /api/health                 health check
//   POST /api/rooms                  create a room           -> { code, playerId, token, room }
//   POST /api/rooms/:code/join       join / rejoin a room    -> { code, playerId, token, room }
//   GET  /api/rooms/:code/ws?token=  signaling WebSocket (Durable Object)
//   POST /api/quickplay              join (or open) a public room  -> { code, playerId, token, room }
//   POST /api/turn                   short-lived ICE servers for a room member

import {
  MAPS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  normalizeRoomCode,
  validateSettings,
  type HealthResponse,
  type JoinRoomResponse,
} from '@minimi/shared';
import type { Env, RateLimiter } from './env';
import { apiError, clientIp, json, originAllowed, readJson } from './http';
import { Matchmaker } from './matchmaker';
import { RoomDO, type RoomRpcResult } from './room';
import { generateIceServers, turnConfigured } from './turn';

export { Matchmaker, RoomDO };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      return await route(req, env, url);
    } catch (err) {
      console.error('api error', err);
      return apiError(500, 'internal', 'Unexpected server error.');
    }
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;

  if (path === '/api/health' && req.method === 'GET') {
    const body: HealthResponse = { ok: true, time: Date.now(), turnConfigured: turnConfigured(env) };
    return json(body);
  }

  if (!originAllowed(req, url, env.ALLOWED_ORIGINS)) {
    return apiError(403, 'forbidden_origin', 'Requests from this origin are not allowed.');
  }
  const ip = clientIp(req);

  if (path === '/api/rooms') {
    if (req.method !== 'POST') return apiError(405, 'method_not_allowed', 'Use POST.');
    if (!(await allowed(env.CREATE_LIMITER, `create:${ip}`, 10))) return tooMany();
    return createRoom(req, env);
  }

  if (path === '/api/quickplay') {
    if (req.method !== 'POST') return apiError(405, 'method_not_allowed', 'Use POST.');
    if (!(await allowed(env.CREATE_LIMITER, `quick:${ip}`, 20))) return tooMany();
    return quickPlay(req, env);
  }

  if (path === '/api/turn') {
    if (req.method !== 'POST') return apiError(405, 'method_not_allowed', 'Use POST.');
    if (!(await allowed(env.API_LIMITER, `api:${ip}`, 120))) return tooMany();
    return issueTurn(req, env);
  }

  const m = /^\/api\/rooms\/([^/]+)\/(join|ws)$/.exec(path);
  if (m) {
    const code = normalizeRoomCode(m[1]);
    if (!code) return apiError(400, 'bad_code', 'Invalid room code.');
    if (!(await allowed(env.API_LIMITER, `api:${ip}`, 120))) return tooMany();
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    if (m[2] === 'ws') {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return apiError(426, 'upgrade_required', 'Expected a WebSocket upgrade.');
      }
      return stub.fetch(req);
    }
    if (req.method !== 'POST') return apiError(405, 'method_not_allowed', 'Use POST.');
    const body = await readJson(req);
    if (!body) return apiError(400, 'bad_request', 'Invalid JSON body.');
    const res = (await stub.join(body.name, body.color, body.token, body.rejoin === true)) as RoomRpcResult;
    return roomResult(code, res, 200);
  }

  return apiError(404, 'not_found', 'Unknown endpoint.');
}

async function createRoom(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  if (!body) return apiError(400, 'bad_request', 'Invalid JSON body.');
  const settings = validateSettings(body);
  if (!settings) return apiError(400, 'bad_settings', 'Invalid room settings.');
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomCode();
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    const res = (await stub.create(code, settings, body.name, body.color)) as RoomRpcResult;
    if (res.ok || res.error !== 'exists') return roomResult(code, res, 201);
  }
  return apiError(503, 'busy', 'Could not allocate a room code. Please retry.');
}

/** Play Online: fill an existing public room, or open a new one. */
async function quickPlay(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  if (!body) return apiError(400, 'bad_request', 'Invalid JSON body.');
  const mm = env.MATCHMAKER.get(env.MATCHMAKER.idFromName('global'));
  const tried: string[] = [];
  for (let i = 0; i < 3; i++) {
    const code = await mm.find(tried);
    if (!code) break;
    tried.push(code);
    const res = (await env.ROOMS.get(env.ROOMS.idFromName(code)).join(body.name, body.color, undefined, false, true)) as RoomRpcResult;
    if (res.ok) return roomResult(code, res, 200);
    if (res.error === 'room_not_found') await mm.remove(code);
  }
  const settings = { maxPlayers: 8, mapId: MAPS[Math.floor(Math.random() * MAPS.length)].id, durationSec: 300 };
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomCode();
    const res = (await env.ROOMS.get(env.ROOMS.idFromName(code)).create(code, settings, body.name, body.color, true)) as RoomRpcResult;
    if (res.ok || res.error !== 'exists') return roomResult(code, res, 201);
  }
  return apiError(503, 'busy', 'Could not open a match. Please retry.');
}

async function issueTurn(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const code = normalizeRoomCode(body?.code);
  if (!body || !code || typeof body.token !== 'string') return apiError(400, 'bad_request', 'Missing room code or token.');
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
  const playerId = await stub.validateToken(body.token);
  if (!playerId) return apiError(401, 'unauthorized', 'Not a member of this room.');
  return json(await generateIceServers(env));
}

function roomResult(code: string, res: RoomRpcResult, okStatus: number): Response {
  if (!res.ok) return apiError(res.status, res.error, res.message);
  const body: JoinRoomResponse = { code, playerId: res.playerId, token: res.token, room: res.room };
  return json(body, okStatus);
}

function randomCode(): string {
  const n = ROOM_CODE_ALPHABET.length;
  const limit = 256 - (256 % n); // rejection sampling: no modulo bias
  let out = '';
  const buf = new Uint8Array(16);
  while (out.length < ROOM_CODE_LENGTH) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < ROOM_CODE_LENGTH; i++) {
      if (buf[i] < limit) out += ROOM_CODE_ALPHABET[buf[i] % n];
    }
  }
  return out;
}

function tooMany(): Response {
  return apiError(429, 'rate_limited', 'Too many requests. Please slow down.', { 'retry-after': '30' });
}

// Fallback limiter (per isolate, best effort) when the Rate Limiting binding is unavailable.
const memoryWindows = new Map<string, { count: number; reset: number }>();

async function allowed(limiter: RateLimiter | undefined, key: string, perMinute: number): Promise<boolean> {
  if (limiter) {
    try {
      return (await limiter.limit({ key })).success;
    } catch {
      /* fall back to in-memory */
    }
  }
  const now = Date.now();
  let w = memoryWindows.get(key);
  if (!w || w.reset <= now) {
    if (memoryWindows.size > 10_000) memoryWindows.clear();
    w = { count: 0, reset: now + 60_000 };
    memoryWindows.set(key, w);
  }
  w.count++;
  return w.count <= perMinute;
}
