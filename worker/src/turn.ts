// Short-lived TURN credentials from Cloudflare Realtime TURN.
// The long-term TURN key (TURN_KEY_API_TOKEN) never leaves the Worker.

import { TURN_TTL_SEC, type IceServer, type TurnResponse } from '@minimi/shared';

export interface TurnEnv {
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

const STUN_ONLY: IceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478'] }];

export function turnConfigured(env: TurnEnv): boolean {
  return Boolean(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN);
}

/** Port 53 is blocked by browsers; such URLs only make ICE gathering wait for a timeout. */
function dropPort53(urls: string | string[]): string[] {
  const list = Array.isArray(urls) ? urls : [urls];
  return list.filter((u) => typeof u === 'string' && !/:53(\?|$)/.test(u));
}

function normalize(raw: unknown): IceServer[] {
  // generate-ice-servers returns { iceServers: [...] }; the legacy endpoint returned { iceServers: {...} }.
  const v = (raw as { iceServers?: unknown })?.iceServers;
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  const out: IceServer[] = [];
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    if (!o.urls) continue;
    const urls = dropPort53(o.urls as string | string[]);
    if (!urls.length) continue;
    const entry: IceServer = { urls };
    if (typeof o.username === 'string') entry.username = o.username;
    if (typeof o.credential === 'string') entry.credential = o.credential;
    out.push(entry);
  }
  return out;
}

export async function generateIceServers(env: TurnEnv, ttl = TURN_TTL_SEC): Promise<TurnResponse> {
  if (!turnConfigured(env)) return { iceServers: STUN_ONLY, ttl, turn: false };
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID!)}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl }),
      },
    );
    if (!res.ok) {
      console.error('TURN credential request failed', res.status);
      return { iceServers: STUN_ONLY, ttl, turn: false };
    }
    const servers = normalize(await res.json());
    const hasTurn = servers.some((s) => s.username && s.credential);
    return { iceServers: servers.length ? servers : STUN_ONLY, ttl, turn: hasTurn };
  } catch (err) {
    console.error('TURN credential request error', err);
    return { iceServers: STUN_ONLY, ttl, turn: false };
  }
}
