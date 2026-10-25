// Fullscreen / orientation / screen wake lock helpers (all best-effort).

export async function enterFullscreenLandscape(): Promise<void> {
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
  try {
    if (!document.fullscreenElement) {
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
      else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
    }
  } catch {
    /* not allowed (iPhone Safari): installing as a PWA gives fullscreen there */
  }
  try {
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    await o.lock?.('landscape');
  } catch {
    /* unsupported */
  }
}

export function isFullscreen(): boolean {
  return !!document.fullscreenElement;
}

export async function exitFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
  } catch {
    /* ignore */
  }
}

let wakeLock: { release(): Promise<void> } | null = null;

export async function keepScreenOn(on: boolean): Promise<void> {
  const nav = navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } };
  try {
    if (on && !wakeLock && nav.wakeLock) wakeLock = await nav.wakeLock.request('screen');
    if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}

export const isTouchDevice = (): boolean => matchMedia('(pointer: coarse)').matches;
