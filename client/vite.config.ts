import { defineConfig } from 'vite';

// In development the Vite dev server proxies /api (HTTP + WebSocket signaling)
// to `wrangler dev` on :8787, so the browser sees a single origin just like production.
export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', ws: true },
    },
  },
  preview: { port: 4173 },
  build: {
    target: 'es2020',
    sourcemap: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        // Phaser is the biggest dependency; keep it in its own long-cached chunk
        // that is fetched lazily (menus render before it arrives).
        manualChunks: { phaser: ['phaser'] },
      },
    },
  },
});
