import type { Matchmaker } from './matchmaker';
import type { RoomDO } from './room';

/** Workers Rate Limiting binding (approximate, per Cloudflare location). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ROOMS: DurableObjectNamespace<RoomDO>;
  MATCHMAKER: DurableObjectNamespace<Matchmaker>;
  ASSETS: Fetcher;
  CREATE_LIMITER?: RateLimiter;
  API_LIMITER?: RateLimiter;
  ALLOWED_ORIGINS?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}
