# Networking

Goal: responsive controls and smooth motion on unstable 3G/4G with tiny bandwidth. The game cannot remove latency; it hides it (prediction, interpolation) and keeps it fair (lag compensation).

## Timing model

- The simulation runs at a **fixed 60 Hz** (`TICK_RATE`), independent of rendering FPS. Rendering interpolates between ticks.
- Each player input (`InputCmd`: buttons, stick X −127..127, aim 0..65535) represents exactly one tick of that player's movement and carries a 16-bit sequence number.
- Player state is snapped to the wire's quantization grid after every tick (positions 1/8 px, velocities 1/16 px/s, integer fuel/ammo/timers), so a replicated state replays bit-for-bit like the original. Result: with no packet loss beyond the redundancy window, **mispredictions are zero** (verified in every test scenario).

## Client → host: inputs (unreliable channel)

- Sent at **30 Hz** (20 Hz when loss > 8 % or RTT > 300 ms).
- Every packet carries **all inputs the host hasn't acknowledged yet** (up to 16 = 267 ms), so a lost packet is repaired by the next one. Repeated stick/aim values are run-length compressed to 1 byte per input.
- Each packet also carries the latest snapshot sequence received (delta baseline ack) and the host tick the client is currently rendering others at (lag compensation).
- Typical size: 12–65 bytes.

The host queues inputs per player and consumes **one per tick** (two or three when a backlog builds), with a real-time budget so a client can never move faster than 60 inputs/s. If inputs older than the redundancy window were lost, the gap is filled by repeating the last known input; the client then reconciles.

## Host → client: snapshots (unreliable channel)

- Per-peer adaptive rate: **20 Hz**, dropping to 15 Hz (loss > 4 %, jitter > 70 ms or RTT > 250 ms) and 10 Hz (loss > 10 %, RTT > 400 ms or a congested channel), using the stats each client reports every 2 s.
- **Delta compression** against the last snapshot the client acknowledged: per player only the changed field groups (position, velocity, aim, state, score, own-only fields) are sent. A player standing still costs 0 bytes; an idle world costs ~15 bytes (header + empty sections). If the baseline is too old, a full snapshot is sent.
- The recipient's own player additionally gets fuel/ammo/reload/cooldown (needed for reconciliation); other players don't.
- **Never queue stale state:** if the DataChannel `bufferedAmount` exceeds 8 KB the snapshot is skipped (and counted, lowering the rate). Clients also skip input sends when congested.
- Cosmetic shot events (tracer origin/end) ride inside snapshots; a lost event only loses a tracer. Hits, damage and kills are decided by the host and are never derived from these.
- Typical size: 35–85 bytes for 2–8 players.

## Reliable channel (ordered)

`HELLO` (protocol version + input sequence), `WELCOME` (your id, map, timer ticks), `KILL` (kill feed), `HIT` (hit marker to the shooter), `END` (results), `STATS` (client → host quality report), `REJECT`. These are rare, small and on a separate SCTP stream, so a retransmission never delays movement data.

## Prediction and reconciliation (local player)

`client/src/core/predictor.ts`: every input is applied locally at once and stored with the predicted state. Each snapshot says "this is your state after I processed input #N". If the stored prediction for #N matches exactly, nothing happens. Otherwise the client rewinds to the host state and replays inputs N+1..latest; the visible jump is absorbed by an offset that decays over ~90 ms (corrections larger than 96 px, e.g. respawns, snap instantly). Shots are predicted too (instant muzzle flash and tracer, using the same deterministic spread hash as the host), but only the host decides hits.

## Interpolation and adaptive delay (other players)

`client/src/core/timesync.ts`, `interpolation.ts`: remote players are drawn slightly in the past, between two received snapshots.

- **Clock:** `sample = hostTick·16.67 ms − arrivalTime`. The maximum over a 64-sample window is the least-delayed packet; it maps local time to host time without needing synchronized clocks. The offset slews at most 5 % to avoid visible time warps.
- **Adaptive delay:** `delay = snapshot interval + p95(packet lateness) + 10 ms (+ one interval when loss > 3 %)`, clamped to 50–350 ms; it grows fast and shrinks slowly. Typical values: 60–90 ms on good links, 130–200 ms at 200 ms RTT with loss.
- **Extrapolation:** when the next snapshot is late, positions continue along the last velocity for at most 150 ms, then hold.
- Respawns (spawn counter change) are never interpolated across.
- Remote shot tracers are released when render time reaches the snapshot that carried them, so they line up with the shooter's sprite.

## Lag compensation

The host keeps 64 ticks (~1 s) of position history per player. A shot from input #N is resolved against targets **rewound to the tick the shooter was rendering** (sent with the input), clamped to at most 24 ticks (400 ms) in the past. Shooting where you see an enemy hits — verified by `tests/lagcomp.test.ts`, where the target has already moved more than a body height away on the host when the shot arrives. The host's own shots use its own render delay (5 ticks).

## Network quality indicator

Shown in the HUD: **RTT** (application-level ping every second), **loss** (missing snapshot sequence numbers over the last 100), **jitter** (mean snapshot lateness) → *Good / Fair / Poor / Bad*. It turns into **Reconnecting…** when the link is down, the host stopped sending for 2.5 s, or the client is re-handshaking — a merely "connected" WebRTC state is never reported as good. The host shows the worst peer. `?debug=1` adds payload and on-the-wire kbit/s (from `RTCPeerConnection.getStats`), snapshot rate, interpolation delay, corrections and the route (direct/relay).

## Wire format reference

All multi-byte values are little-endian. First byte = message type.

```
INPUT    (1, u)  u8 type | u8 flags(bit0 hasAck) | [u16 ackSnap] | u32 renderTick | u16 newestSeq | u8 count
                 then count entries newest→oldest: u8 buttons(bit7 = same axes as previous) [i8 moveX, u16 aim]
PING     (2, u)  u8 | u32 clientTimeMs
PONG     (3, u)  u8 | u32 echoedTime | u32 hostTick
SNAPSHOT (4, u)  u8 | u16 seq | u8 flags(bit0 hasBase, bit1 hasAck) | [u16 baseSeq] | u32 tick | [u16 ackInput]
                 u8 removedCount, ids… | u8 entityCount, { u8 id | u8 groupMask | groups… }
                 groups: POS u16 x,u16 y (1/8 px) · VEL i16 vx,i16 vy (1/16 px/s) · AIM u16 · STATE u8 hp,flags,spawn,weapon
                         SCORE u8 kills,deaths · OWN u16 fuel,u8 ammo,reload,cooldown
                 u8 eventCount, { u8 kind=1 | u8 shooter | u8 weapon | u16 ox,oy,ex,ey | u8 flags }
HELLO   (10, r)  u8 | u8 version | u16 inputSeq
WELCOME (11, r)  u8 | u8 version | u8 yourId | u8 mapId | u32 hostTick | u32 startTick | u32 endTick | u8 snapshotHz | u16 matchId
KILL    (12, r)  u8 | u8 killer | u8 victim | u8 weapon | u8 flags(headshot)
HIT     (13, r)  u8 | u8 victim | u8 damage | u8 flags(headshot, kill)
END     (14, r)  u8 | u16 matchId | u8 n | n × { u8 id, u8 kills, u8 deaths }
STATS   (15, r)  u8 | u16 rttMs | u16 lossPermille | u16 jitterMs | u8 fps | u16 corrections
REJECT  (16, r)  u8 | u8 reason
```

Player flags: `ALIVE 1, GROUND 2, JET 4, PROTECTED 8, DISCONNECTED 16, RELOADING 32`.

## Measured bandwidth

Payload (application bytes) per player, from `npm run test:netsim` and the browser E2E runs; "wire" includes DTLS/SCTP/UDP/IP overhead as reported by `getStats`.

| Scenario | Client down | Client up | Client wire (up/down) | Host wire (up/down) |
|---|---|---|---|---|
| 2 players, LAN | 6 kbit/s | 6–7 kbit/s | ~20 / ~21 kbit/s | ~20 / ~22 kbit/s |
| 4 players, 200 ms RTT, 5 % loss | 7–9 kbit/s | 14–15 kbit/s | ~27 / ~20 kbit/s | ~63 / ~83 kbit/s |
| 8 players, 120 ms RTT, 2 % loss | 13–15 kbit/s | 11–13 kbit/s | ~26 / ~28 kbit/s | ~195 / ~182 kbit/s |

Per-packet overhead dominates small packets, which is why input/snapshot rates (not just sizes) are adapted under bad conditions.
