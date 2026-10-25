# Architecture

## Overview

```
                    ┌──────────────────────── Cloudflare ────────────────────────┐
                    │                                                             │
 browser ──HTTPS──► │  Worker (API + static assets)                               │
                    │    /api/rooms, /join, /quickplay ──RPC──► RoomDO (1/room)    │
                    │    /api/turn ──checks token──► RoomDO, then mints TURN creds │
                    │    /api/rooms/:code/ws ──WebSocket (signaling)──► RoomDO     │
                    │                                   RoomDO ──► Matchmaker DO   │
                    │  Realtime TURN (relay, only when a direct path fails)        │
                    └─────────────────────────────────────────────────────────────┘

 Gameplay (never touches the Worker):

         player 2 ──┐
         player 3 ──┼── WebRTC DataChannels (direct UDP, or TURN relay) ──► HOST browser
         player 4 ──┘                                                       (authoritative
                                                                             simulation)
```

| Component | Responsibility | Not responsible for |
|---|---|---|
| **Worker** (`worker/src/index.ts`) | HTTP API, input validation, origin checks, rate limits, routing to Durable Objects, TURN credential minting, serving the built client | Any game state |
| **RoomDO** (`worker/src/room.ts`, rules in `roomState.ts`) | Membership (ids 1–8, unique), names/colors (sanitized, deduplicated), ready flags, settings, phase (`lobby`/`playing`), `matchId`, owner/host selection, expiring reconnect tokens, WebRTC signaling relay (star topology enforced), room expiry via alarms, public-room auto-start | Simulation, hit detection, scores |
| **Matchmaker DO** (`worker/src/matchmaker.ts`) | List of public rooms with free seats for *Play Online* | — |
| **Host browser** (`client/src/core/host.ts`) | Authoritative 60 Hz simulation: movement, firing, ammo, damage, kills, respawns, timer, results; per-player snapshots | — |
| **Client browser** (`client/src/core/client.ts`) | Input sampling, prediction + reconciliation of the local player, interpolation of others, cosmetic effects | Deciding anything authoritative |

Cloudflare Workers, Durable Objects and TURN are **not** game servers here: the Durable Object only coordinates the room, and TURN only relays encrypted packets when peers can't reach each other directly.

## Lifecycle of a match

1. **Create / join / quick play** — `POST /api/rooms` (or `/join`, `/quickplay`) returns `{ code, playerId, token }`. The token is stored in `sessionStorage` (per tab) and is the only credential for this seat.
2. **TURN credentials** — `POST /api/turn {code, token}`: the Worker asks the room DO to validate the token, then calls Cloudflare Realtime TURN for 4-hour credentials (port-53 URLs filtered out, they're blocked in browsers).
3. **Signaling** — WebSocket `/api/rooms/:code/ws?token=…` to the room DO (hibernation API: idle rooms cost nothing; keep-alive pings are auto-answered without waking it). The DO sends `welcome` + room snapshots, and relays SDP/ICE (`{t:'signal'}`) — only between the host and another player.
4. **WebRTC** — each non-host player is the *offerer* of one `RTCPeerConnection` to the host. Two pre-negotiated DataChannels: `u` (unordered, `maxRetransmits: 0`) and `r` (reliable, ordered). ICE tries host/srflx candidates first and falls back to TURN; nothing assumes a direct path. Links are created in the lobby, so the lobby shows `direct · 23 ms` or `relay · 80 ms` per player before the match starts.
5. **Start** — the owner presses Start (all players ready, ≥ 2 connected), or a public room auto-starts. The DO flips `phase` to `playing`; the host's browser creates `HostMatch`, the others create `ClientMatch` and send `HELLO`; the host answers `WELCOME` and starts streaming snapshots.
6. **End** — when the timer expires the host broadcasts `END` (results) over the reliable channel and tells the DO `{t:'end'}`; everyone sees the results screen, then returns to the lobby for a rematch.

## Reconnection and failure handling

| Failure | Handling |
|---|---|
| Signaling WebSocket drops (mobile network switch) | Exponential backoff with jitter, keep-alive detects half-open sockets, `online` event triggers an immediate retry; after 3 failures the client checks its seat with `/join {token, rejoin:true}` and goes home only if the seat is gone. WebRTC gameplay continues meanwhile. |
| WebRTC link degrades | ICE restart after 2.5 s in `disconnected` (offerer) or on `failed`; a link that isn't open after 15 s is replaced by a new `RTCPeerConnection` (new `conn` id). The host keeps the disconnected player frozen and invulnerable for 30 s. |
| Page reload / app relaunch | Seat token in `sessionStorage` → rejoin the same player id, late-join the running match. `HELLO` carries the client's input sequence so the host resynchronises the input stream. |
| Host leaves / crashes | Clients show "reconnecting". The DO gives the host 15 s to come back; if a client also lost its WebRTC link to the (offline) host it reports `host_lost` and the grace drops to 3 s. Then the match ends for everyone (`notice: host_left`) and the next player becomes host. **No host migration**: the authoritative state lived in the host's tab. |
| Host tab in background | A Web Worker timer keeps the host simulation and snapshots running (rAF stops in background tabs). Mobile OSes may still suspend the page → handled as "host leaves". |
| Token theft / guessing | 128-bit random tokens, constant-time compare, expire 10 min after the last disconnect. Tokens are required for signaling, TURN and rejoin. |

## Security model

- **Never trust clients:** clients send *inputs only* (buttons, stick, aim). The host simulates movement (speed, collisions — no client positions are accepted), fire rate, ammunition, reloads, hits (with bounded lag compensation), damage, kills and respawns. A client cannot report damage or kills.
- **Speed-hack protection:** the host processes at most ~1 input per tick per player on average (budget refilled at real-time rate, capped), so sending inputs faster than 60 Hz gains nothing.
- **Validation:** binary packets are length-checked and bounded (malformed → dropped and counted); signaling JSON is strictly parsed (`parseClientMessage`), size-limited (16 KB) and rate-limited per player (token bucket; abusers are disconnected); SDP/ICE fields have size caps.
- **Room access:** a seat token is required for every room operation; only the owner can change settings/start; only the host can end a match; signaling only flows host↔player.
- **Rate limits:** room creation 10/min/IP, other API calls 120/min/IP (Workers Rate Limiting binding, with a per-isolate fallback).
- **Content:** nicknames are NFKC-normalised, stripped of control/zero-width/bidi characters and markup characters, length-limited, de-duplicated; the UI only ever uses `textContent`.
- **Transport:** HTTPS/WSS in production (Cloudflare), DTLS-SRTP-encrypted DataChannels, CSP and security headers via `client/public/_headers`. No secrets in client code.

**Residual risk (inherent to host-authoritative P2P):** the host runs the simulation on hardware the other players don't control. A modified host client can cheat (e.g. invulnerability) and the host always has zero latency. This is acceptable for private rooms among friends; for public competitive play use the dedicated-server architecture below.

## Scalability limits of the peer-to-peer design

- **Host upload grows linearly with players.** Measured in the 8-player browser test: each client uses ~26 kbit/s up / ~28 kbit/s down on the wire, but the host sends ~195 kbit/s and receives ~180 kbit/s for 7 peers. Fine on 4G/Wi-Fi, marginal on poor 3G — the host should be the player with the best connection (the room creator; a "transfer host" button is a possible follow-up).
- **Host device does the most work:** simulation, 7 snapshot encodes per tick, rendering. Cheap here, but a low-end phone hosting 8 players is the weakest link.
- **NAT traversal:** without TURN some players (symmetric NATs, corporate/school networks, some carrier-grade NATs) cannot connect at all. With TURN they connect via relay, adding latency and Cloudflare TURN bandwidth cost.
- **Single point of failure:** if the host disappears the match ends.
- **Room size:** the star topology and one-byte player ids cap rooms at 8, which matches the game design.
- **Coordination scales well:** each room is one Durable Object; the Worker is stateless; there is no central bottleneck except the (cheap, small) matchmaker list — which could be sharded per region if it ever became hot.

## Alternative: dedicated authoritative servers (public competitive play)

The game core in `client/src/core/` has no DOM/Phaser dependency (the tests already run `HostMatch` in Node), so the same simulation can run on servers:

```
browser ──HTTPS──► Worker: auth, matchmaking (region, skill), server allocation
browser ──WebRTC DataChannel / WebTransport (UDP) ──► Game server process (1 per match)
                                                      runs HostMatch at 60 Hz, all players remote
                                                      reports results ──► D1 (accounts, leaderboards)
Fleet: containers per region (e.g. Kubernetes + Agones, Fly.io Machines, Hetzner/OVH bare metal,
       or Cloudflare Containers where UDP is available), autoscaled by the allocator.
```

- **Transport:** WebRTC DataChannels on the server via `libdatachannel`/`node-datachannel` or `werift` (keeps today's client code unchanged), or WebTransport (HTTP/3, unreliable datagrams) where supported, with a WebSocket fallback (TCP head-of-line blocking hurts on lossy mobile links, so only as a fallback). Durable Objects alone can't do UDP, so they stay the coordination layer.
- **Fairness and anti-cheat:** nobody has host advantage; the server is trusted; server-side sanity checks, replay logs and rate statistics can be added. Lag compensation already bounds rewind (400 ms).
- **Resilience:** a player leaving never ends the match; servers can snapshot state to support migration between processes.
- **Cost:** server CPU/bandwidth per match instead of free P2P; ~20–30 kbit/s per player in both directions at 20 Hz makes this inexpensive.
- **Migration path:** keep the binary protocol, swap `PeerTransport` implementations, and let the allocator replace "host = room owner" with "host = server". Private rooms can keep using P2P.
