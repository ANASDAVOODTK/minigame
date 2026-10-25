// In-game HUD as a DOM overlay. Updated ~10x/s and only touches the DOM when a
// value actually changes.

import { PLAYER_COLORS } from '@minimi/shared';
import type { ResultRow } from '../core/protocol';
import type { HudInfo, NetInfo, ScoreRow } from '../core/view';
import { WEAPONS } from '../core/weapons';
import { clear, h, setText } from './dom';

export interface HudDeps {
  myId: number;
  isHost: boolean;
  info(id: number): { name: string; color: number } | null;
  scores(out: ScoreRow[]): number;
  /** Extra transport details for the debug panel (route, wire kbps). */
  linkDebug(): string;
  showDebug: boolean;
  botLabel: string;
  onScoreboardKey(): boolean;
  onFullscreen(): void;
  onLeave(): void;
}

const QUALITY_TEXT = { good: 'Good', fair: 'Fair', poor: 'Poor', bad: 'Bad' } as const;

export class Hud {
  readonly root: HTMLElement;
  private hpFill: HTMLElement;
  private hpText: HTMLElement;
  private fuelFill: HTMLElement;
  private timer: HTMLElement;
  private kd: HTMLElement;
  private netDot: HTMLElement;
  private netText: HTMLElement;
  private feed: HTMLElement;
  private ammo: HTMLElement;
  private weaponName: HTMLElement;
  private reloadFill: HTMLElement;
  private center: HTMLElement;
  private hit: HTMLElement;
  private vignette: HTMLElement;
  private debug: HTMLElement;
  private board: HTMLElement;
  private boardTable: HTMLElement;
  private results: HTMLElement;
  private boardOpen = false;
  private scoreRows: ScoreRow[] = [];
  private last = { hp: -1, fuel: -1, time: '', kd: '', net: '', q: '', ammo: '', reload: -1, center: '' };

  constructor(
    container: HTMLElement,
    private deps: HudDeps,
  ) {
    for (let i = 0; i < 9; i++) this.scoreRows.push({ id: 0, kills: 0, deaths: 0, pingMs: 0, connected: true });
    clear(container);
    this.hpFill = h('div', { class: 'bar-fill hp-fill' });
    this.hpText = h('span', { class: 'bar-text' });
    this.fuelFill = h('div', { class: 'bar-fill fuel-fill' });
    this.timer = h('span', { class: 'timer' });
    this.kd = h('span', { class: 'kd' });
    this.netDot = h('span', { class: 'net-dot' });
    this.netText = h('span', { class: 'net-text' });
    this.feed = h('div', { class: 'feed' });
    this.ammo = h('span', { class: 'ammo' });
    this.weaponName = h('span', { class: 'wname' });
    this.reloadFill = h('div', { class: 'reload-fill' });
    this.center = h('div', { class: 'center-msg' });
    this.hit = h('div', { class: 'hitmarker' });
    this.vignette = h('div', { class: 'vignette' });
    this.debug = h('pre', { class: 'debug' });
    this.boardTable = h('div');
    this.board = h(
      'div',
      { class: 'board hidden' },
      this.boardTable,
      h('button', { class: 'btn danger small', text: 'Leave match', on: { click: () => deps.onLeave() } }),
    );
    this.results = h('div', { class: 'results hidden' });

    this.root = h(
      'div',
      { class: 'hud-root' },
      h('div', { class: 'hud-tl' }, h('div', { class: 'bar hp' }, this.hpFill, this.hpText), h('div', { class: 'bar fuel' }, this.fuelFill)),
      h(
        'div',
        { class: 'hud-tc', on: { click: () => this.toggleBoard() } },
        this.timer,
        this.kd,
      ),
      h(
        'div',
        { class: 'hud-tr' },
        h('div', { class: 'net' }, this.netDot, this.netText),
        h(
          'div',
          { class: 'hud-buttons' },
          h('button', { class: 'hud-btn', text: '⛶', attrs: { 'aria-label': 'Fullscreen' }, on: { click: () => deps.onFullscreen() } }),
          h('button', { class: 'hud-btn', text: '☰', attrs: { 'aria-label': 'Scoreboard' }, on: { click: () => this.toggleBoard() } }),
        ),
        this.feed,
      ),
      h('div', { class: 'hud-ammo' }, this.weaponName, this.ammo, h('div', { class: 'reload' }, this.reloadFill)),
      this.center,
      this.hit,
      this.vignette,
      deps.showDebug ? this.debug : null,
      deps.botLabel ? h('div', { class: 'botlabel', text: deps.botLabel }) : null,
      this.board,
      this.results,
    );
    container.appendChild(this.root);
  }

  update(hud: HudInfo, net: NetInfo, fps: number): void {
    const L = this.last;
    const hp = Math.round(hud.hp);
    if (hp !== L.hp) {
      L.hp = hp;
      this.hpFill.style.transform = `scaleX(${hp / 100})`;
      this.hpFill.classList.toggle('low', hp <= 30);
      setText(this.hpText, String(hp));
    }
    const fuel = Math.round(hud.fuel * 100);
    if (fuel !== L.fuel) {
      L.fuel = fuel;
      this.fuelFill.style.transform = `scaleX(${fuel / 100})`;
    }
    const secs = Math.ceil(hud.timeLeftSec);
    const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    if (time !== L.time) {
      L.time = time;
      setText(this.timer, time);
      this.timer.classList.toggle('urgent', secs <= 30);
    }
    const kd = `K ${hud.kills}  ·  D ${hud.deaths}`;
    if (kd !== L.kd) setText(this.kd, (L.kd = kd));

    const w = WEAPONS[hud.weapon] ?? WEAPONS[0];
    const ammo = hud.reload > 0 ? 'RELOADING' : `${hud.ammo} / ${hud.magSize}`;
    if (ammo !== L.ammo) {
      L.ammo = ammo;
      setText(this.ammo, ammo);
      setText(this.weaponName, w.name);
      this.ammo.classList.toggle('empty', hud.ammo === 0);
    }
    const rl = Math.round(hud.reload * 100);
    if (rl !== L.reload) {
      L.reload = rl;
      this.reloadFill.style.transform = `scaleX(${rl / 100})`;
    }

    // Network indicator: measured RTT + loss + jitter, never just "WebRTC connected".
    let netText: string;
    let q: string;
    if (net.reconnecting) {
      netText = 'Reconnecting…';
      q = 'bad';
    } else if (net.role === 'host') {
      netText = net.peers ? `HOST · ${net.peers + 1}P · ${Math.round(net.rttMs)} ms · ${net.lossPct.toFixed(0)}%` : 'HOST · waiting';
      q = net.peers ? net.quality : 'good';
    } else {
      netText = `${Math.round(net.rttMs)} ms · ${net.lossPct.toFixed(net.lossPct < 10 ? 1 : 0)}% · ${QUALITY_TEXT[net.quality]}`;
      q = net.quality;
    }
    if (netText !== L.net) setText(this.netText, (L.net = netText));
    if (q !== L.q) {
      this.netDot.className = `net-dot q-${q}`;
      L.q = q;
    }

    let center = '';
    if (hud.connectingSec >= 0) {
      center = hud.connectingSec < 15 ? 'Connecting to host…' : 'Still connecting… your network may block peer-to-peer (a TURN relay is needed).';
    } else if (net.reconnecting) center = net.role === 'client' ? 'Connection to host lost — reconnecting…' : '';
    else if (!hud.alive && hud.timeLeftSec > 0) center = hud.respawnInSec > 0 ? `Respawning in ${Math.ceil(hud.respawnInSec)}…` : 'Respawning…';
    if (center !== L.center) {
      L.center = center;
      setText(this.center, center);
      this.center.classList.toggle('show', center !== '');
    }

    if (this.deps.showDebug) {
      setText(
        this.debug,
        `fps ${fps.toFixed(0)}  role ${net.role}\n` +
          `up ${net.upKbps.toFixed(1)} kbps  down ${net.downKbps.toFixed(1)} kbps (payload)\n` +
          `snap ${net.snapshotHz.toFixed(0)} Hz  interp ${net.interpDelayMs.toFixed(0)} ms\n` +
          `jitter ${net.jitterMs.toFixed(0)} ms  corrections ${net.corrections}\n` +
          this.deps.linkDebug(),
      );
    }

    const wantBoard = this.deps.onScoreboardKey();
    if (wantBoard || this.boardOpen) this.renderBoard();
    this.board.classList.toggle('hidden', !(wantBoard || this.boardOpen));
  }

  private toggleBoard(): void {
    this.boardOpen = !this.boardOpen;
    if (this.boardOpen) this.renderBoard();
    this.board.classList.toggle('hidden', !this.boardOpen);
  }

  private renderBoard(): void {
    const n = this.deps.scores(this.scoreRows);
    const rows = this.scoreRows.slice(0, n).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    clear(this.boardTable);
    this.boardTable.appendChild(
      h(
        'table',
        null,
        h('tr', null, h('th', { text: 'Player' }), h('th', { text: 'K' }), h('th', { text: 'D' }), h('th', { text: 'Ping' })),
        ...rows.map((r) => {
          const info = this.deps.info(r.id);
          return h(
            'tr',
            { class: r.id === this.deps.myId ? 'me' : '' },
            h('td', null, swatch(info?.color ?? 0), info?.name ?? `P${r.id}`, r.connected ? '' : ' (away)'),
            h('td', { text: String(r.kills) }),
            h('td', { text: String(r.deaths) }),
            h('td', { text: r.id === this.deps.myId && this.deps.isHost ? 'host' : r.pingMs ? `${Math.round(r.pingMs)}` : '–' }),
          );
        }),
      ),
    );
  }

  killFeed(killer: string, victim: string, weapon: number, headshot: boolean, byMe: boolean, onMe: boolean): void {
    const self = killer === victim;
    const row = h(
      'div',
      { class: `feed-row${byMe ? ' by-me' : ''}${onMe ? ' on-me' : ''}` },
      self ? '' : h('b', { text: killer }),
      h('span', { class: 'feed-wpn', text: ` ${self ? '☠' : `[${WEAPONS[weapon]?.name ?? '?'}]`}${headshot ? ' ✶' : ''} ` }),
      h('b', { text: victim }),
    );
    this.feed.prepend(row);
    while (this.feed.childElementCount > 4) this.feed.lastElementChild?.remove();
    setTimeout(() => row.remove(), 5000);
  }

  hitMarker(kill: boolean): void {
    this.hit.classList.remove('show', 'kill');
    void this.hit.offsetWidth; // restart CSS animation
    this.hit.classList.add('show');
    if (kill) this.hit.classList.add('kill');
  }

  damage(amount: number): void {
    this.vignette.style.setProperty('--dmg', String(Math.min(1, 0.35 + amount / 60)));
    this.vignette.classList.remove('show');
    void this.vignette.offsetWidth;
    this.vignette.classList.add('show');
  }

  showResults(rows: ResultRow[], onBack: () => void): void {
    const winner = rows[0];
    const winnerName = winner ? (this.deps.info(winner.id)?.name ?? `P${winner.id}`) : '—';
    const iWon = winner?.id === this.deps.myId;
    clear(this.results);
    this.results.appendChild(
      h(
        'div',
        { class: 'results-card' },
        h('h2', { text: iWon ? 'Victory!' : 'Match over' }),
        h('p', { class: 'winner' }, 'Winner: ', h('b', { text: winnerName })),
        h(
          'table',
          null,
          h('tr', null, h('th', { text: '#' }), h('th', { text: 'Player' }), h('th', { text: 'Kills' }), h('th', { text: 'Deaths' })),
          ...rows.map((r, i) => {
            const info = this.deps.info(r.id);
            return h(
              'tr',
              { class: r.id === this.deps.myId ? 'me' : '' },
              h('td', { text: String(i + 1) }),
              h('td', null, swatch(info?.color ?? 0), info?.name ?? `P${r.id}`),
              h('td', { text: String(r.kills) }),
              h('td', { text: String(r.deaths) }),
            );
          }),
        ),
        h('button', { class: 'btn primary', text: 'Back to lobby', on: { click: onBack } }),
      ),
    );
    this.results.classList.remove('hidden');
  }

  dispose(): void {
    this.root.remove();
  }
}

export function swatch(color: number): HTMLElement {
  return h('span', { class: 'swatch', style: { background: PLAYER_COLORS[color] ?? PLAYER_COLORS[0] } });
}
