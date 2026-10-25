# Testing

Three layers, from fastest to most realistic:

1. **Unit + simulated-network tests** (`npm test`, ~2 s, no browser): physics determinism, protocol/delta codec, maps, sanitizing, room rules, reconnection, lag compensation, and the full host/client netcode over a deterministic network simulator.
2. **Real multi-browser E2E** (`npm run e2e`): N Chrome instances play a real match over real WebRTC, signaling through the real Worker/Durable Objects (`wrangler dev` or a deployed URL), with optional artificial latency/jitter/loss/bandwidth caps.
3. **Manual device testing** (Android Chrome, iPhone Safari, TURN-only), checklist below.

## 1. Unit and network-simulation tests

```bash
npm test               # everything
npm run test:netsim    # just the netcode matrix (prints a table)
```

`tests/netsim/harness.ts` runs the real `HostMatch` + `ClientMatch` over simulated links (seeded RNG): one-way delay = RTT/2 + uniform jitter, independent loss on the unreliable channel, retransmission delay on the reliable channel. Scripted players move, jet, aim at each other and shoot. Each scenario asserts:

- the predicted local state equals the host's exactly after inputs stop (convergence);
- ≥ 8 snapshots/s delivered, payload bandwidth within budget;
- mispredictions: 0 without loss, ≤ 3 at 2–5 % loss, ≤ 10 at 10 % loss;
- remote players rendered < 2 px (average) from their true position at the render time;
- measured loss tracks the configured loss; hits/kills happen with 4+ players.

Latest results (20 s per scenario, payload only):

| Scenario | Down kbit/s | Up kbit/s | Snapshots/s | Interp delay | Corrections | Render error avg / max |
|---|---|---|---|---|---|---|
| LAN, 2p | 6.2 | 7.1 | 20.9 | 74 ms | 0 | 0.2 / 8 px |
| 100 ms, 2p | 6.5 | 11.4 | 20.9 | 80 ms | 0 | 0.3 px avg |
| 200 ms, 2p | 6.6 | 14.8 | 20.9 | 90 ms | 0 | 0.4 px avg |
| 300 ms, 2p | 5.5 | 10.8 | 16.4 (adapted) | 122 ms | 0 | 0.4 / 32 px |
| 100 ms + 2 % loss | 6.1 | 11.7 | 19.9 | 83 ms | 0 | 0.4 px avg |
| 150 ms + 5 % loss | 4.9 | 14.0 | 16.4 (adapted) | 183 ms | 0 | 0.5 px avg |
| 200 ms + 10 % loss | 4.4 | 12.2 | 14.3 (adapted) | 206 ms | 0 | 0.7 / 19 px |
| 8p, 120 ms + 2 % loss | 13–14 | 11–13 | 19–21 | 87–146 ms | 0 | 0.3 / 35 px |

## 2. Real browser E2E (WebRTC)

Start the local stack in one terminal, run the test in another:

```bash
npm run dev
npm run e2e -- --players 2 --seconds 20                          # two-player match
npm run e2e -- --players 4 --lag 200 --jitter 30 --loss 5         # 4 players, bad mobile network
npm run e2e -- --players 8 --lag 120 --jitter 20 --loss 2         # 8 players
npm run e2e -- --players 2 --lag 100                              # 100 ms   (also try 200, 300)
npm run e2e -- --players 2 --loss 2                               # 2 % loss (also try 5, 10)
npm run e2e -- --players 2 --bw 48 --lag 150 --loss 3             # low bandwidth (48 kbit/s upload cap)
npm run e2e -- --players 3 --scenario hostleave                   # host closes its tab mid-match
npm run e2e -- --players 2 --scenario reload                      # a player reloads mid-match
npm run e2e -- --players 2 --scenario full                        # full 3-min match, results, rematch
npm run e2e -- --players 2 --relay                                # TURN-only (needs TURN configured)
npm run e2e -- --url https://your-app.workers.dev --players 4     # against a deployment
```

Options: `--seconds`, `--map 0|1|2`, `--shots` (screenshots to `tests/e2e/shot-*.png`), `--headed`, `--channel chrome|msedge`. A JSON report is written to `tests/e2e/report-*.json`. `node tests/e2e/screens.mjs` captures the menus and touch controls on emulated phones.

Each browser's player is driven by the **TEST BOT** input (`?bot=1`, always labelled in the HUD); everything else is the production path. Network conditions (`?lag=&jitter=&loss=&bw=`) are applied inside the non-host browsers on their link to the host (`client/src/net/conditioner.ts`); browser DevTools throttling does not affect WebRTC.

The runner reports per player: FPS, RTT, loss, jitter, snapshot rate, interpolation delay, payload and wire kbit/s, route (direct/relay), mispredictions, visible players, kills/deaths. Note that FPS in headless Chrome is not representative (software rendering, no vsync) — measure FPS on real devices with `?debug=1`.

Latest results on one machine (Chrome, localhost):

| Run | Result |
|---|---|
| 2 players | PASS — both see 2 players, 0 corrections, ~20 kbit/s wire each way |
| 4 players, +200 ms, 30 ms jitter, 5 % loss | PASS — RTT ≈ 235 ms, snapshots adapted to 15–19 Hz, interp 130–170 ms, 0 corrections |
| 8 players, +120 ms, 2 % loss | PASS — all see 8 players, 0 corrections, clients ~26/28 kbit/s, host ~195/182 kbit/s |
| 48 kbit/s cap, +150 ms, 3 % loss | PASS — playable, 0 corrections |
| Host closes tab mid-match | PASS — clients back in lobby after 6.4 s with a new host |
| Player reloads mid-match | PASS — same seat (player id) back in the match in ~1 s, 0 corrections |
| Full 3-min match + rematch | PASS — timer ran out, identical results on every screen (8/5 vs 5/8), back to lobby, rematch started |

## 3. Manual testing checklist

Deploy first (`npm run deploy`) so phones get HTTPS, then open the URL with `?debug=1` for the stats panel.

**Two-player basics** (any two devices): create room → share invite → join → ready → start. Move, jet, aim, shoot, reload, die, respawn; check the kill feed, scoreboard (tap timer), results screen and rematch.

**Android Chrome:** landscape fullscreen starts when pressing Ready/Start; both thumbs at once (move + aim/fire); "Add to Home screen" opens fullscreen; check FPS ≥ 30 on a low-end phone (Settings → Graphics: Auto drops to Low automatically below ~45 FPS).

**iPhone Safari:** rotate prompt in portrait; touch sticks and buttons with multitouch; no page scrolling/zooming during play; Share → Add to Home Screen for fullscreen; audio starts after the first tap. Note: iOS suspends background tabs — if the host switches apps, the match ends for everyone.

**Host disconnect:** close the host's tab mid-match → others see "reconnecting", then are returned to the lobby within ~3–15 s with a new host. Turn the host's Wi-Fi off and on quickly (< 15 s) → the match continues.

**TURN-only:** Settings → Network testing → *Force TURN relay* (or `?relay=1`) on one device; the lobby must show `relay · N ms`. Requires `TURN_KEY_ID`/`TURN_KEY_API_TOKEN` (check `/api/health` → `turnConfigured: true`).

**Slow networks:** Settings → Network testing lets you add latency/jitter/loss/upload caps on one device; or test on a real congested 3G connection. The HUD indicator should show Fair/Poor with real numbers and never claim *Good* while packets are being lost.

**Measure:** the debug panel shows FPS, payload and on-the-wire bandwidth per link, RTT, loss, jitter, snapshot rate, interpolation delay, prediction corrections and the route.
