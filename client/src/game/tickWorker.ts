// Dedicated-worker timer: unlike main-thread timers and requestAnimationFrame,
// it keeps firing ~60 times per second while the tab is in the background.
const scope = self as unknown as { postMessage(m: unknown): void };
setInterval(() => scope.postMessage(0), 16);
