// Visual quality: 'auto' starts high and permanently drops to low if the device
// can't hold ~45 FPS. Gameplay never depends on it (simulation is fixed 60 Hz).

import type { QualitySetting } from '../config';

export class Quality {
  level: 'high' | 'low';
  fps = 60;
  private slowMs = 0;

  constructor(private setting: QualitySetting) {
    const lowEnd = (navigator.hardwareConcurrency ?? 4) <= 2 || ((navigator as { deviceMemory?: number }).deviceMemory ?? 4) <= 1;
    this.level = setting === 'low' || (setting === 'auto' && lowEnd) ? 'low' : 'high';
  }

  get maxParticles(): number {
    return this.level === 'high' ? 96 : 28;
  }

  frame(dtMs: number): void {
    if (dtMs <= 0 || dtMs > 250) return;
    this.fps += (1000 / dtMs - this.fps) * 0.05;
    if (this.setting !== 'auto' || this.level === 'low') return;
    this.slowMs = this.fps < 45 ? this.slowMs + dtMs : Math.max(0, this.slowMs - dtMs * 0.5);
    if (this.slowMs > 3000) this.level = 'low';
  }
}
