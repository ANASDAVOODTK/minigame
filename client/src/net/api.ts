// HTTP API client for the Cloudflare Worker.

import type {
  ApiErrorBody,
  CreateRoomRequest,
  HealthResponse,
  JoinRoomRequest,
  JoinRoomResponse,
  QuickPlayRequest,
  TurnResponse,
} from '@minimi/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network', 'Network error. Check your connection.');
  } finally {
    clearTimeout(timer);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const e = (data ?? {}) as Partial<ApiErrorBody>;
    throw new ApiError(res.status, e.error ?? 'http_' + res.status, e.message ?? `Request failed (${res.status}).`);
  }
  return data as T;
}

/** Retries transient failures (network / 5xx) with backoff. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) throw e;
      await new Promise((r) => setTimeout(r, 400 * 2 ** i));
    }
  }
  throw last;
}

export const api = {
  health: () => request<HealthResponse>('GET', '/api/health'),
  createRoom: (req: CreateRoomRequest) => request<JoinRoomResponse>('POST', '/api/rooms', req),
  quickPlay: (req: QuickPlayRequest) => request<JoinRoomResponse>('POST', '/api/quickplay', req),
  joinRoom: (code: string, req: JoinRoomRequest) => request<JoinRoomResponse>('POST', `/api/rooms/${code}/join`, req),
  rejoin: (code: string, token: string) =>
    withRetry(() => request<JoinRoomResponse>('POST', `/api/rooms/${code}/join`, { name: '', color: 0, token, rejoin: true })),
  turn: (code: string, token: string) => withRetry(() => request<TurnResponse>('POST', '/api/turn', { code, token })),
};

export function signalingUrl(code: string, token: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/rooms/${code}/ws?token=${encodeURIComponent(token)}`;
}
