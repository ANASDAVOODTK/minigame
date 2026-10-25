// Captures UI screenshots on emulated phones (portrait menus, landscape match with
// touch controls). Requires the dev stack (npm run dev). Output: tests/e2e/ui-*.png
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({ channel: 'chrome', args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
const phone = (w, h) => ({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

// Portrait phone: home + lobby.
const a = await (await browser.newContext(phone(390, 844))).newPage();
await a.goto(`${BASE}/?name=Ana&sound=0`);
await a.waitForSelector('.logo');
await a.screenshot({ path: 'tests/e2e/ui-home.png' });
await a.getByRole('button', { name: 'Create Room' }).click();
await a.screenshot({ path: 'tests/e2e/ui-create.png' });
await a.getByRole('button', { name: 'Create Room' }).click();
await a.waitForFunction(() => window.__minimi.state().code);
const code = await a.evaluate(() => window.__minimi.state().code);

// Second player (landscape phone) joins and readies.
const b = await (await browser.newContext(phone(844, 390))).newPage();
await b.goto(`${BASE}/?name=Ben&sound=0#/join/${code}`);
await b.getByRole('button', { name: 'Join' }).click();
await b.getByRole('button', { name: 'Ready!' }).click();
await a.waitForFunction(() => window.__minimi.stats().links.some((l) => l.state === 'open'));
await a.waitForTimeout(600);
await a.screenshot({ path: 'tests/e2e/ui-lobby.png' });

await a.getByRole('button', { name: 'Start match' }).click();
await b.waitForFunction(() => window.__minimi.state().matchPhase === 'live');
await b.waitForTimeout(2500);
await b.screenshot({ path: 'tests/e2e/ui-match-touch.png' });
await a.screenshot({ path: 'tests/e2e/ui-match-portrait.png' }); // portrait phone: rotate prompt
console.log('saved tests/e2e/ui-*.png');
await browser.close();
