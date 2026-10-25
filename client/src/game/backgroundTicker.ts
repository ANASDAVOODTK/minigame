// Keeps the host's authoritative simulation + networking alive while its tab is
// hidden (requestAnimationFrame stops in background tabs). Mobile browsers may
// still suspend a backgrounded page entirely; the room then ends the match
// gracefully after the host grace period.

export class BackgroundTicker {
  private worker: Worker | null = null;

  constructor(private tick: () => void) {
    document.addEventListener('visibilitychange', this.onVisibility);
    this.onVisibility();
  }

  private onVisibility = (): void => {
    if (document.hidden) this.start();
    else this.stop();
  };

  private start(): void {
    if (this.worker) return;
    try {
      this.worker = new Worker(new URL('./tickWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = () => this.tick();
    } catch {
      this.worker = null;
    }
  }

  private stop(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  dispose(): void {
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.stop();
  }
}
