// Signaling WebSocket to the room Durable Object, with automatic reconnection
// (exponential backoff + jitter) and keep-alive to detect half-open sockets on
// flaky mobile networks.

import type { ClientMessage, ServerMessage } from '@minimi/shared';

export type SignalingState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SignalingHandlers {
  onMessage(msg: ServerMessage): void;
  onState(state: SignalingState): void;
  /** Called after repeated failures so the session can check whether the seat still exists. */
  onRepeatedFailure(attempts: number): void;
}

const PING_EVERY_MS = 20_000;
const DEAD_AFTER_MS = 45_000;

export class SignalingClient {
  state: SignalingState = 'connecting';
  private ws: WebSocket | null = null;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeard = 0;
  private closedByUs = false;

  constructor(
    private url: () => string,
    private h: SignalingHandlers,
  ) {}

  connect(): void {
    this.closedByUs = false;
    this.open();
  }

  private open(): void {
    this.cleanupSocket();
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url());
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.lastHeard = Date.now();
      this.setState('open');
      this.pingTimer = setInterval(() => this.keepAlive(), PING_EVERY_MS);
    };
    ws.onmessage = (ev) => {
      this.lastHeard = Date.now();
      if (typeof ev.data !== 'string' || ev.data === 'pong') return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.h.onMessage(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.cleanupSocket();
      if (this.closedByUs) return;
      // 4000 = replaced by a newer connection of the same player (another tab): stop.
      if (ev.code === 4000) {
        this.setState('closed');
        return;
      }
      this.scheduleRetry();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private keepAlive(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastHeard > DEAD_AFTER_MS) {
      // Half-open socket (common after mobile network switches): force a reconnect.
      this.ws.close();
      return;
    }
    try {
      this.ws.send('ping');
    } catch {
      /* closing */
    }
  }

  private scheduleRetry(): void {
    if (this.closedByUs) return;
    this.setState('reconnecting');
    this.attempts++;
    if (this.attempts >= 3) this.h.onRepeatedFailure(this.attempts);
    const delay = Math.min(8000, 400 * 2 ** Math.min(this.attempts, 5)) * (0.75 + Math.random() * 0.5);
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  /** Reconnect immediately (e.g. the browser just came back online). */
  nudge(): void {
    if (this.state === 'reconnecting' && !this.closedByUs) {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.open();
    }
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.closedByUs = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.cleanupSocket();
    try {
      ws?.close(1000, 'bye');
    } catch {
      /* ignore */
    }
    this.setState('closed');
  }

  private cleanupSocket(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
      if (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.close();
        } catch {
          /* ignore */
        }
      }
    }
    this.ws = null;
  }

  private setState(s: SignalingState): void {
    if (this.state === s) return;
    this.state = s;
    this.h.onState(s);
  }
}
