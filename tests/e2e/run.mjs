// Real multi-browser end-to-end test: N Chrome instances play a match against
// each other over real WebRTC DataChannels, signaling through the real Worker
// + Durable Object (wrangler dev or a deployed URL). Each browser's player is
// driven by the clearly-labelled TEST BOT input (?bot=1); everything else -
// rooms, signaling, ICE, netcode, rendering - is the production code path.
//
//   npm run dev                       # in another terminal
//   npm run e2e -- --players 2 --seconds 20
//   npm run e2e -- --players 4 --lag 200 --jitter 30 --loss 5
//   npm run e2e -- --players 2 --relay      # TURN-only (needs TURN configured)
//   npm run e2e -- --players 3 --scenario hostleave
//   npm run e2e -- --players 2 --scenario reload
//   npm run e2e -- --url https://your-app.workers.dev --players 2
//
// Options: --url --players --seconds --lag --jitter --loss --bw --relay --map
//          --scenario basic|hostleave|reload|full --headed --channel chrome|msedge --shots

import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const BASE = String(opt('url', 'http://127.0.0.1:5173')).replace(/\/$/, '');
const PLAYERS = Number(opt('players', 2));
const SECONDS = Number(opt('seconds', 20));
const LAG = Number(opt('lag', 0));
const JITTER = Number(opt('jitter', 0));
const LOSS = Number(opt('loss', 0));
const BW = Number(opt('bw', 0));
const RELAY = opt('relay', false) !== false;
const MAP = Number(opt('map', 0));
const SCENARIO = String(opt('scenario', 'basic'));
const HEADED = opt('headed', false) !== false;
const CHANNEL = String(opt('channel', 'chrome'));
const SHOTS = opt('shots', false) !== false;

const log = (...a) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(page, fn, arg, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) {
    try {
      if (await page.evaluate(fn, arg)) return;
    } catch {
      /* page navigating */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(250);
  }
}

function playerUrl(i, hash = '') {
  const q = new URLSearchParams({ bot: '1', autoready: '1', name: `Bot${i}`, sound: '0', debug: '1', quality: PLAYERS > 4 ? 'low' : 'auto' });
  // Network conditions apply to the non-host browsers (each adds the full RTT to its link to the host).
  if (i > 0) {
    if (LAG) q.set('lag', String(LAG));
    if (JITTER) q.set('jitter', String(JITTER));
    if (LOSS) q.set('loss', String(LOSS));
    if (BW) q.set('bw', String(BW));
  }
  if (RELAY) q.set('relay', '1');
  return `${BASE}/?${q}${hash}`;
}

const state = (p) => p.evaluate(() => window.__minimi.state());
const stats = (p) => p.evaluate(() => window.__minimi.stats());

async function main() {
  log(`players=${PLAYERS} seconds=${SECONDS} lag=${LAG} jitter=${JITTER} loss=${LOSS}% bw=${BW} relay=${RELAY} scenario=${SCENARIO} url=${BASE}`);
  const browser = await chromium.launch({
    channel: CHANNEL,
    headless: !HEADED,
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
  });
  const viewport = PLAYERS > 4 ? { width: 640, height: 360 } : { width: 960, height: 540 };
  const pages = [];
  for (let i = 0; i < PLAYERS; i++) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => log(`page ${i} error:`, e.message));
    page.on('console', (m) => m.type() === 'error' && log(`page ${i} console:`, m.text()));
    pages.push(page);
  }

  // Host creates the room through the UI.
  const host = pages[0];
  await host.goto(playerUrl(0));
  await host.getByRole('button', { name: 'Create Room' }).click();
  if (MAP) await host.getByRole('radio', { name: ['Desert Battlefield', 'Jungle Arena', 'Underground Base'][MAP] }).click();
  await host.getByRole('radio', { name: '3 min' }).click();
  await host.getByRole('radio', { name: String(PLAYERS <= 2 ? 2 : PLAYERS <= 4 ? 4 : PLAYERS <= 6 ? 6 : 8), exact: true }).click();
  await host.getByRole('button', { name: 'Create Room' }).click();
  await waitFor(host, () => !!window.__minimi.state().code, null, 15000, 'room code');
  const code = (await state(host)).code;
  log(`room ${code} created`);

  // Everyone else joins via invite link.
  await Promise.all(
    pages.slice(1).map(async (p, k) => {
      await p.goto(playerUrl(k + 1, `#/join/${code}`));
      await p.getByRole('button', { name: 'Join' }).click();
    }),
  );
  await waitFor(
    host,
    (n) => {
      const r = window.__minimi.state().room;
      return r && r.members.length === n && r.members.every((m) => m.connected && (m.id === r.hostId || m.ready));
    },
    PLAYERS,
    30000,
    'all players connected + ready',
  );
  // WebRTC links up before starting (shown in the lobby).
  await waitFor(host, (n) => window.__minimi.stats().links.filter((l) => l.state === 'open').length === n - 1, PLAYERS, 30000, 'all WebRTC links open');
  const links = (await stats(host)).links;
  log(`links: ${links.map((l) => `#${l.id} ${l.route}`).join(', ')}`);

  await host.getByRole('button', { name: 'Start match' }).click();
  for (const p of pages) await waitFor(p, () => window.__minimi.state().matchPhase === 'live', null, 30000, 'match live');
  log('match live on all browsers');

  const samples = pages.map(() => []);
  const sample = async () => {
    for (let i = 0; i < pages.length; i++) {
      try {
        if (pages[i].isClosed()) continue;
        samples[i].push(await stats(pages[i]));
      } catch {
        /* reloading */
      }
    }
  };

  const result = { scenario: SCENARIO, ok: true, notes: [] };
  if (SCENARIO === 'full') {
    // Play a whole 3-minute match: timer -> results on every screen -> lobby -> second match.
    log('waiting for the match timer to run out (~3 min)…');
    for (const p of pages) await waitFor(p, () => window.__minimi.state().matchPhase === 'ended', null, 240000, 'match end');
    const finals = await Promise.all(pages.map((p) => state(p)));
    const same = finals.every((f) => JSON.stringify(f.results) === JSON.stringify(finals[0].results));
    log(`results on every screen (identical: ${same}):`, JSON.stringify(finals[0].results));
    if (!same || !finals[0].results?.length) result.ok = false;
    for (const p of pages) await p.getByRole('button', { name: 'Back to lobby' }).click();
    await waitFor(host, (n) => {
      const st = window.__minimi.state();
      return st.screen === 'lobby' && st.room.phase === 'lobby' && st.room.members.filter((m) => m.ready).length === n - 1;
    }, PLAYERS, 30000, 'everyone back in the lobby and ready');
    await host.getByRole('button', { name: 'Start match' }).click();
    for (const p of pages) await waitFor(p, () => window.__minimi.state().matchPhase === 'live', null, 30000, 'second match live');
    const st = await state(host);
    log(`second match live (matchId ${st.room.matchId})`);
    result.notes.push(`full: results ${JSON.stringify(finals[0].results)}; rematch started (matchId ${st.room.matchId})`);
  }
  const t0 = Date.now();
  let scenarioDone = false;
  while (Date.now() - t0 < SECONDS * 1000) {
    await sleep(2000);
    await sample();
    const el = (Date.now() - t0) / 1000;
    if (!scenarioDone && el > SECONDS / 2) {
      scenarioDone = true;
      if (SCENARIO === 'reload' && PLAYERS > 1) {
        log('reloading player 1 mid-match (rejoin with reconnect token)');
        await pages[1].reload();
        await waitFor(pages[1], () => window.__minimi?.state().matchPhase === 'live', null, 30000, 'player 1 back in the match');
        const st = await state(pages[1]);
        log(`player 1 rejoined as id ${st.myId} in room ${st.code}`);
        result.notes.push(`reload: rejoined id ${st.myId}`);
      }
      if (SCENARIO === 'hostleave') {
        log('closing the host browser mid-match');
        await host.close();
        const p = pages[1];
        const tLeave = Date.now();
        await waitFor(p, () => window.__minimi.state().screen === 'lobby', null, 40000, 'clients back in lobby after host left');
        const st = await state(p);
        log(`host left -> clients returned to lobby after ${((Date.now() - tLeave) / 1000).toFixed(1)} s; new host id ${st.room.hostId}`);
        result.notes.push(`hostleave: lobby after ${((Date.now() - tLeave) / 1000).toFixed(1)}s, new host ${st.room.hostId}`);
        if (st.room.hostId === 1) result.ok = false;
        break;
      }
    }
  }

  if (SHOTS) {
    for (let i = 0; i < pages.length; i++) {
      if (!pages[i].isClosed()) await pages[i].screenshot({ path: `tests/e2e/shot-${i}.png` });
    }
    log('screenshots saved to tests/e2e/shot-*.png');
  }

  // Summaries.
  const rows = [];
  for (let i = 0; i < pages.length; i++) {
    const s = samples[i].filter((x) => x.net && x.hud);
    if (!s.length) continue;
    const last = s[s.length - 1];
    const avg = (f) => s.reduce((a, x) => a + f(x), 0) / s.length;
    const wire = (dir) => avg((x) => x.links.reduce((a, l) => a + (dir === 'up' ? l.wireUpKbps : l.wireDownKbps), 0));
    rows.push({
      player: i === 0 ? 'host' : `p${i}`,
      fps: +avg((x) => x.fps).toFixed(0),
      rttMs: +avg((x) => x.net.rttMs).toFixed(0),
      lossPct: +avg((x) => x.net.lossPct).toFixed(1),
      jitterMs: +avg((x) => x.net.jitterMs).toFixed(0),
      snapHz: +avg((x) => x.net.snapshotHz).toFixed(1),
      interpMs: +avg((x) => x.net.interpDelayMs).toFixed(0),
      upKbps: +avg((x) => x.net.upKbps).toFixed(1),
      downKbps: +avg((x) => x.net.downKbps).toFixed(1),
      wireUpKbps: +wire('up').toFixed(1),
      wireDownKbps: +wire('down').toFixed(1),
      route: last.links.map((l) => l.route).join(',') || '-',
      corrections: last.net.corrections,
      seesPlayers: last.visiblePlayers,
      kills: last.hud.kills,
      deaths: last.hud.deaths,
    });
  }
  console.table(rows);
  if (SCENARIO === 'basic' || SCENARIO === 'reload') {
    for (const r of rows) {
      if (r.seesPlayers !== PLAYERS) {
        result.ok = false;
        result.notes.push(`${r.player} sees ${r.seesPlayers}/${PLAYERS} players`);
      }
    }
  }
  const report = { when: new Date().toISOString(), config: { BASE, PLAYERS, SECONDS, LAG, JITTER, LOSS, BW, RELAY, MAP, SCENARIO }, rows, ...result };
  const file = `tests/e2e/report-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(report, null, 2));
  log(`${result.ok ? 'PASS' : 'FAIL'} ${result.notes.join('; ')}  (report: ${file})`);
  await browser.close();
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
