# Jetpack Brawl

A mobile-first, online-only 2–8 player 2D jetpack shooter that runs in any modern browser — no install, no sign-up. Inspired by the *gameplay mechanics* of classic mobile jetpack shooters; all names, art, sounds and maps are original (art and sound are generated procedurally at runtime, so the game downloads **zero image or audio files**).

- **Frontend:** TypeScript, Phaser 3 (WebGL/Canvas), Vite, PWA
- **Backend:** Cloudflare Workers + Durable Objects (rooms, signaling, matchmaking), Cloudflare Realtime TURN (relay fallback)
- **Gameplay networking:** WebRTC DataChannels, peer-to-peer star around a **host-authoritative** browser

> "Jetpack Brawl" is a placeholder title — rename freely (`client/index.html`, `client/public/manifest.webmanifest`, `client/src/ui/screens.ts`).

## Status: stage 1 (first working implementation)

| Area | Status |
|---|---|
| Online rooms: Play Online (matchmaking), Create (code, 2/4/6/8 players, map, duration), Join (code / invite link), lobby with ready + host badge + copy/share | ✅ |
| Cloudflare Worker API, Durable Object rooms + signaling, temporary TURN credentials, rate limiting, reconnect tokens, room expiry | ✅ |
| WebRTC star topology, unreliable + reliable DataChannels, ICE restart, link recovery, TURN-only mode | ✅ |
| Netcode: 60 Hz fixed sim, client prediction + reconciliation, adaptive interpolation, capped extrapolation, lag-compensated hitscan, binary delta snapshots, quantization, adaptive rates, bufferedAmount control | ✅ |
| Movement, jetpack + fuel, gravity, tile collision, one-way platforms, aiming, shooting (pistol), ammo + reload, health, death, respawn + spawn protection, kills, kill feed, timer, scoreboard, results screen | ✅ |
| Mobile touch controls (2 floating sticks + FIRE/JET/RELOAD, multitouch), desktop WASD + mouse, fullscreen/landscape, rotate prompt, wake lock | ✅ |
| 3 original maps (Desert Battlefield, Jungle Arena, Underground Base) | ✅ |
| Network indicator (ping, loss, quality, reconnecting), debug panel (kbps payload + wire, snapshot Hz, interp delay, corrections, route) | ✅ |
| Host leaves mid-match → match ends gracefully, new host chosen (no host migration) | ✅ |
| Weapon roster: rifle, shotgun, sniper, rocket launcher (configured in `client/src/core/weapons.ts`), grenades, weapon/health pickups | ⏭ stage 2 |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/NETWORKING.md](docs/NETWORKING.md) and [docs/TESTING.md](docs/TESTING.md).

## Quick start (local)

Requirements: Node.js 20+ (tested with 24), npm 10+, Google Chrome (for the automated browser tests).

```bash
npm install
npm run dev          # wrangler dev (Worker + Durable Objects, :8787) + Vite (:5173)
```

Open <http://localhost:5173> in two browser windows (or a normal + a private window — each tab is its own player). Create a room in one, join with the code in the other, press **Ready**, then **Start match**.

`npm run dev` copies `worker/.dev.vars.example` to `worker/.dev.vars` on first run. Without TURN keys the game uses STUN only, which works on the same machine/LAN and for most home networks.

### Testing on your phone during development

- Same Wi-Fi: Vite listens on all interfaces (`npm run dev` prints a Network URL such as `http://192.168.1.20:5173`). WebRTC works over plain HTTP on a LAN, but fullscreen/clipboard/service worker need HTTPS, so for a realistic test deploy to Cloudflare (below) or use a tunnel: `npx cloudflared tunnel --url http://localhost:5173`.
- Debug overlay: add `?debug=1` to the URL (or enable it in Settings).

### Useful scripts

| Command | What it does |
|---|---|
| `npm run dev` | Local stack: Worker + Durable Objects + Vite with `/api` proxy |
| `npm run typecheck` | `tsc` for shared, worker and client |
| `npm test` | Unit + simulated-network tests (Vitest, headless, ~2 s) |
| `npm run test:netsim` | Netcode under simulated latency/jitter/loss, prints a bandwidth/accuracy table |
| `npm run e2e -- --players 4 --lag 200 --loss 5` | Real multi-browser match over real WebRTC (needs `npm run dev` running) |
| `npm run build` | Production client build → `client/dist` |
| `npm run deploy` | Build + `wrangler deploy` (Worker serves the client as static assets) |

## Deploying to Cloudflare

1. **Log in:** `npx wrangler login`
2. **(Recommended) Create a TURN key** — Cloudflare dashboard → *Realtime* → *TURN Server* → *Create*. You get a **Key ID** and an **API token**.
   ```bash
   cd worker
   npx wrangler secret put TURN_KEY_API_TOKEN     # paste the API token (never commit it)
   ```
   Put the Key ID (not secret) in `worker/wrangler.jsonc` → `vars.TURN_KEY_ID`, or also store it as a secret: `npx wrangler secret put TURN_KEY_ID`.
3. **Deploy:** `npm run deploy` (from the repo root). Wrangler creates the `RoomDO` and `Matchmaker` Durable Object classes (SQLite-backed, works on the free plan) and the two rate limiters on first deploy.
4. Open the printed `https://minimi.<your-subdomain>.workers.dev`. Check `GET /api/health` → `"turnConfigured": true`.
5. Optional: add a custom domain in the dashboard (Workers → your worker → Settings → Domains & Routes).

### Environment variables and secrets

| Name | Where | Secret? | Purpose |
|---|---|---|---|
| `TURN_KEY_ID` | `wrangler.jsonc` vars or secret | no | Cloudflare Realtime TURN key id |
| `TURN_KEY_API_TOKEN` | `wrangler secret put` / `.dev.vars` | **yes** | Used only by the Worker to mint short-lived (4 h) TURN credentials for room members |
| `ALLOWED_ORIGINS` | `wrangler.jsonc` vars / `.dev.vars` | no | Extra origins allowed to call the API (same-origin is always allowed). `*` only for local dev |

The long-term TURN token never reaches the browser: `POST /api/turn` checks the caller's room token with the room's Durable Object first, then returns temporary credentials.

## Project structure

```
shared/                 Types + validation shared by Worker and browser
  src/constants.ts        room/player limits, maps list, timings
  src/signaling.ts        signaling message types + strict parser (used by the DO)
  src/sanitize.ts         nickname/chat sanitizing, settings validation
  src/api.ts              HTTP API types
worker/                 Cloudflare Worker (API + static assets) and Durable Objects
  src/index.ts            routes: /api/health, /api/rooms, /api/rooms/:code/{join,ws}, /api/quickplay, /api/turn
  src/room.ts             RoomDO: membership, signaling relay, host selection, tokens, alarms
  src/roomState.ts        pure room rules (unit tested)
  src/matchmaker.ts       Matchmaker DO: open public rooms for "Play Online"
  src/turn.ts             Cloudflare Realtime TURN credential minting
  wrangler.jsonc          bindings, migrations, rate limits, assets
client/                 Browser game (Vite)
  src/core/               DOM-free game + netcode (runs in Node tests too)
    physics.ts              player movement, jetpack, collision, ray casts
    weapons.ts              weapon table (damage, rate, range, ammo, recoil, spread)
    maps.ts                 the 3 ASCII maps + parser
    protocol.ts, snapshot.ts, bytes.ts   binary wire format, delta codec
    host.ts                 authoritative simulation (runs in the host's browser)
    client.ts               prediction/reconciliation/interpolation for non-host players
    predictor.ts, interpolation.ts, timesync.ts, netstats.ts
  src/net/                WebRTC + signaling (api, signaling WS, PeerLink, session, conditioner)
  src/game/               Phaser scene, procedural textures, sfx, quality, background ticker
  src/input/              keyboard/mouse + touch controls, test bot
  src/ui/                 menus, lobby, HUD
tests/                  Vitest unit/netsim tests + Playwright multi-browser E2E (tests/e2e)
docs/                   Architecture, networking protocol, testing guide
```

## Controls

| | Desktop | Touch |
|---|---|---|
| Move | A / D (or ←/→) | Left stick |
| Jetpack | W / Space | Left stick up, or **JET** |
| Drop through platform | S | Left stick down |
| Aim | Mouse | Right stick |
| Fire | Left click | Right stick pushed to the edge, or **FIRE** |
| Reload | R | **R** |
| Grenade / switch weapon | G / Q,E (stage 2) | (stage 2) |
| Scoreboard | Tab | tap the timer or ☰ |

## Known limitations (stage 1)

- The host's browser is the game server: if it closes, the match ends for everyone (after ~3–15 s) and a new host is picked for the next match. Host migration is **not** implemented.
- Host advantage and trust: the host has 0 ms latency and could modify its own client. Fine for friends' rooms; see the dedicated-server proposal in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for public competitive play.
- iPhone Safari cannot enter element fullscreen; "Add to Home Screen" (PWA) gives a fullscreen experience. Mobile browsers suspend background tabs: a host that switches apps ends the match.
- Only the pistol is enabled; the other weapons, grenades and pickups come in stage 2.
