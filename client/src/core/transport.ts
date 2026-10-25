/** What the game core needs from a network connection to one peer (a WebRTC link in the browser, a simulated pipe in tests). */
export interface PeerTransport {
  /** Unordered, unreliable channel. Returns false if the message was not queued. */
  sendU(data: Uint8Array): boolean;
  /** Reliable, ordered channel. */
  sendR(data: Uint8Array): boolean;
  /** Bytes queued on the unreliable channel but not yet sent. */
  bufferedU(): number;
  isOpen(): boolean;
}
