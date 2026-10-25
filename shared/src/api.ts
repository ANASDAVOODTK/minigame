// HTTP API request/response shapes (Worker <-> browser).

import type { RoomInfo, RoomSettings } from './signaling';

export interface CreateRoomRequest extends RoomSettings {
  name: string;
  color: number;
}

export interface JoinRoomRequest {
  name: string;
  color: number;
  /** Present when rejoining with a previously issued reconnect token. */
  token?: string;
  /** Only rejoin with the token; never create a new member. */
  rejoin?: boolean;
}

export interface JoinRoomResponse {
  code: string;
  playerId: number;
  /** Secret reconnect token. Keep it in sessionStorage only. */
  token: string;
  room: RoomInfo;
}

export interface QuickPlayRequest {
  name: string;
  color: number;
}

export interface TurnRequest {
  code: string;
  token: string;
}

/** Mirrors the browser's RTCIceServer without depending on DOM typings. */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface TurnResponse {
  iceServers: IceServer[];
  /** Seconds the credentials stay valid. */
  ttl: number;
  /** False when TURN is not configured (STUN only) - relay fallback unavailable. */
  turn: boolean;
}

export interface ApiErrorBody {
  error: string;
  message: string;
}

export interface HealthResponse {
  ok: true;
  time: number;
  turnConfigured: boolean;
}
