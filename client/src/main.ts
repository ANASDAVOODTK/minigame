// App controller: menus <-> room session <-> match.

import type { JoinRoomResponse, RoomInfo, RoomNotice, RoomSettings } from '@minimi/shared';
import './styles.css';
import { applyUrlOverrides, loadSettings, loadStoredSession, saveSettings, storeSession, type DebugFlags, type Settings } from './config';
import { ClientMatch } from './core/client';
import { HostMatch } from './core/host';
import type { InputState } from './core/input';
import type { PeerTransport } from './core/transport';
import { makeHudInfo, makeNetInfo, type MatchView, type ScoreRow } from './core/view';
import { BackgroundTicker } from './game/backgroundTicker';
import type { SceneContext } from './game/GameScene';
import { Quality } from './game/quality';
import { Sfx } from './game/sfx';
import { BotControls } from './input/bot';
import { PlayerControls, type Controls } from './input/controls';
import { ApiError, api } from './net/api';
import { RoomSession } from './net/session';
import { toast } from './ui/dom';
import { Hud } from './ui/hud';
import { enterFullscreenLandscape, exitFullscreen, isFullscreen, keepScreenOn } from './ui/platform';
import { renderCreate, renderHome, renderJoin, renderLobby, renderSettings, type MenuApp } from './ui/screens';

const IDLE: InputState = { buttons: 0, moveX: 0, aim: 0 };
const CLOSED: PeerTransport = { sendU: () => false, sendR: () => false, bufferedU: () => 0, isOpen: () => false };

type Screen = 'home' | 'create' | 'join' | 'settings' | 'lobby' | 'game';

class App implements MenuApp {
  settings: Settings;
  flags: DebugFlags;
  session: RoomSession | null = null;
  serverStatus = '';
  prefillCode = '';

  private screen: Screen = 'home';
  private ui = document.getElementById('ui')!;
  private gameEl = document.getElementById('game')!;
  private touchEl = document.getElementById('touch')!;
  private hudEl = document.getElementById('hud')!;
  private backdrop = document.getElementById('backdrop')!;

  private match: HostMatch | ClientMatch | null = null;
  private matchId = -1;
  private controls: Controls | null = null;
  private hud: Hud | null = null;
  private quality: Quality | null = null;
  private sfx: Sfx;
  private bg: BackgroundTicker | null = null;
  private endWatch: ReturnType<typeof setInterval> | null = null;
  private resultsShown = false;
  private lobbyTimer: ReturnType<typeof setInterval> | null = null;
  private endGraceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.settings = loadSettings();
    this.flags = applyUrlOverrides(this.settings);
    this.sfx = new Sfx(this.settings.sound);
    const m = /#\/join\/([A-Za-z0-9]{5})/.exec(location.hash) ?? /[?&]room=([A-Za-z0-9]{5})/.exec(location.search);
    if (m) this.prefillCode = m[1].toUpperCase();
    this.exposeDebugHooks();
    window.addEventListener('hashchange', () => {
      const mm = /#\/join\/([A-Za-z0-9]{5})/.exec(location.hash);
      if (mm && !this.session) {
        this.prefillCode = mm[1].toUpperCase();
        this.show('join');
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.match) void keepScreenOn(true);
    });
  }

  async start(): Promise<void> {
    const stored = loadStoredSession();
    if (stored) {
      // Page reload while in a room: take the seat back.
      try {
        const res = await api.rejoin(stored.code, stored.token);
        this.enterRoom(res);
        return;
      } catch {
        storeSession(null);
      }
    }
    this.show(this.prefillCode ? 'join' : 'home');
    void this.checkServer();
  }

  private async checkServer(): Promise<void> {
    const t0 = performance.now();
    try {
      const hres = await api.health();
      this.serverStatus = `Server online · ${Math.round(performance.now() - t0)} ms${hres.turnConfigured ? '' : ' · relay off'}`;
    } catch {
      this.serverStatus = 'Server unreachable — check your connection';
    }
    if (this.screen === 'home') this.show('home');
  }

  saveSettings(): void {
    saveSettings(this.settings);
    this.sfx.enabled = this.settings.sound;
  }

  show(screen: 'home' | 'create' | 'join' | 'settings'): void {
    this.screen = screen;
    if (screen === 'home') renderHome(this.ui, this);
    else if (screen === 'create') renderCreate(this.ui, this);
    else if (screen === 'join') renderJoin(this.ui, this);
    else renderSettings(this.ui, this);
  }

  private ensureName(): void {
    if (!this.settings.name) {
      this.settings.name = `Soldier${Math.floor(100 + Math.random() * 900)}`;
      this.saveSettings();
    }
  }

  async createRoom(s: RoomSettings): Promise<void> {
    this.ensureName();
    try {
      const res = await api.createRoom({ ...s, name: this.settings.name, color: this.settings.color });
      this.enterRoom(res);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not create the room.');
    }
  }

  async joinRoom(code: string): Promise<void> {
    this.ensureName();
    try {
      const res = await api.joinRoom(code, { name: this.settings.name, color: this.settings.color });
      this.enterRoom(res);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not join the room.');
    }
  }

  async quickPlay(): Promise<void> {
    this.ensureName();
    try {
      const res = await api.quickPlay({ name: this.settings.name, color: this.settings.color });
      this.enterRoom(res);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not find a match.');
    }
  }

  private enterRoom(res: JoinRoomResponse): void {
    this.session?.dispose();
    storeSession({ code: res.code, playerId: res.playerId, token: res.token });
    history.replaceState(null, '', `${location.pathname}${location.search}#/room/${res.code}`);
    const session = new RoomSession(res.code, res.playerId, res.token, this.settings, {
      room: (room, notice) => this.onRoom(room, notice),
      error: (_code, message) => toast(message),
      fatal: (message) => {
        toast(message, 5000);
        this.goHome();
      },
      linkOpen: (id, link) => {
        const m = this.match;
        if (m instanceof HostMatch) m.attachPeer(id, link);
        else if (m instanceof ClientMatch && id === this.session?.room?.hostId) {
          m.setTransport(link);
          m.linkDown = false;
        }
        if (this.screen === 'lobby') this.renderLobby();
      },
      linkClose: (id, link) => {
        const m = this.match;
        if (m instanceof HostMatch) m.detachPeer(id, link);
        else if (m instanceof ClientMatch && id === this.session?.room?.hostId) m.linkDown = true;
        if (this.screen === 'lobby') this.renderLobby();
      },
      message: (id, data) => {
        const m = this.match;
        if (m instanceof HostMatch) m.onMessage(id, data);
        else if (m instanceof ClientMatch && id === this.session?.room?.hostId) m.onMessage(data);
      },
      status: () => {
        if (this.screen === 'lobby') this.renderLobby();
      },
    });
    this.session = session;
    session.room = res.room;
    session.start();
    this.screen = 'lobby';
    this.lobbySig = '';
    this.renderLobby();
    if (this.lobbyTimer) clearInterval(this.lobbyTimer);
    this.lobbyTimer = setInterval(() => this.screen === 'lobby' && this.renderLobby(), 1000);
    void import('./game/launch'); // prefetch the game engine while in the lobby
    if (res.room.phase === 'playing') void this.enterMatch(res.room);
  }

  private lobbySig = '';

  private renderLobby(): void {
    const s = this.session;
    const room = s?.room;
    // Rebuild only when something visible changed (keeps clicks reliable).
    const links = s ? [...s.links.values()].map((l) => `${l.remoteId}:${l.state}:${l.route}:${Math.round(l.iceRttMs / 10)}`).join(',') : '';
    const countdown = room?.public ? Math.ceil((room.autoStartInMs - (performance.now() - (s?.roomAt ?? 0))) / 1000) : 0;
    const sig = `${this.screen}|${JSON.stringify(room)}|${links}|${s?.signalingState}|${s?.turnAvailable}|${countdown}`;
    if (sig !== this.lobbySig) {
      this.lobbySig = sig;
      renderLobby(this.ui, this);
    }
    if (this.flags.autoReady && s && room && room.phase === 'lobby' && !s.isHost) {
      const me = room.members.find((m) => m.id === s.myId);
      if (me && !me.ready) s.setReady(true);
    }
  }

  private onRoom(room: RoomInfo, notice?: RoomNotice): void {
    const s = this.session!;
    if (notice === 'host_left') toast(s.isHost ? 'The host left — match ended. You are now the host.' : 'The host left — match ended.', 5000);
    else if (notice === 'owner_changed' && s.isHost) toast('You are now the room host.');

    const m = this.match;
    if (m instanceof HostMatch) {
      for (let id = 1; id <= 8; id++) if (id !== s.myId && m.hasPlayer(id) && !room.members.some((x) => x.id === id)) m.removePlayer(id);
    }

    if (room.phase === 'playing') {
      if (!m && !this.resultsShown) void this.enterMatch(room);
    } else if (m && m.phase !== 'ended') {
      if (notice === 'match_ended' && m instanceof ClientMatch) {
        // The host's END usually arrives via WebRTC at the same time; give it a moment.
        if (!this.endGraceTimer) this.endGraceTimer = setTimeout(() => this.match && this.match.phase !== 'ended' && this.exitMatch(), 3000);
      } else {
        this.exitMatch();
      }
    }
    if (this.screen === 'lobby') this.renderLobby();
  }

  setReady(ready: boolean): void {
    this.session?.setReady(ready);
    if (ready) void enterFullscreenLandscape(); // user gesture: good moment for fullscreen
  }

  startMatch(): void {
    this.session?.send({ t: 'start' });
    void enterFullscreenLandscape();
  }

  changeRoomSettings(s: Partial<RoomSettings>): void {
    this.session?.send({ t: 'settings', settings: s });
  }

  private async enterMatch(room: RoomInfo): Promise<void> {
    const s = this.session;
    if (!s || this.match) return;
    const now = performance.now();
    let match: HostMatch | ClientMatch;
    if (s.isHost) {
      const host = new HostMatch({
        matchId: room.matchId,
        mapId: room.settings.mapId,
        durationSec: room.settings.durationSec,
        hostId: s.myId,
        nowMs: now,
        onEnded: () => s.send({ t: 'end', matchId: room.matchId }),
      });
      for (const [id, link] of s.links) if (link.state === 'open') host.attachPeer(id, link);
      this.bg = new BackgroundTicker(() => host.update(performance.now(), IDLE));
      match = host;
    } else {
      const client = new ClientMatch({ myId: s.myId, transport: s.hostLink() ?? CLOSED, nowMs: now, clock: () => performance.now() });
      client.linkDown = !s.hostLink();
      match = client;
    }
    this.match = match;
    this.matchId = room.matchId;
    this.resultsShown = false;
    this.screen = 'game';
    document.body.classList.add('in-game');

    this.controls = this.flags.bot ? new BotControls() : new PlayerControls(this.gameEl, this.touchEl);
    this.quality = new Quality(this.settings.quality);
    const info = (id: number) => {
      const mem = this.session?.room?.members.find((x) => x.id === id);
      return mem ? { name: mem.name, color: mem.color } : null;
    };
    const controls = this.controls;
    this.hud = new Hud(this.hudEl, {
      myId: s.myId,
      isHost: s.isHost,
      info,
      scores: (out: ScoreRow[]) => match.scores(out),
      linkDebug: () => this.linkDebug(),
      showDebug: this.settings.showDebug,
      botLabel: controls.label,
      onScoreboardKey: () => controls instanceof PlayerControls && controls.scoreboardHeld(),
      onFullscreen: () => void (isFullscreen() ? exitFullscreen() : enterFullscreenLandscape()),
      onLeave: () => this.leaveRoom(),
    });
    void keepScreenOn(true);

    const ctx: SceneContext = { match, info, controls, hud: this.hud, sfx: this.sfx, quality: this.quality, backdrop: this.backdrop };
    const { startMatchScene } = await import('./game/launch');
    if (this.match !== match) return; // left while loading
    startMatchScene(this.gameEl, ctx);

    this.endWatch = setInterval(() => {
      if (this.match === match && match.phase === 'ended' && !this.resultsShown) {
        this.resultsShown = true;
        this.controls?.setEnabled(false);
        if (match.results) this.hud?.showResults(match.results, () => this.exitMatch());
        else this.exitMatch();
      }
    }, 250);
  }

  private exitMatch(): void {
    if (this.endWatch) clearInterval(this.endWatch);
    if (this.endGraceTimer) clearTimeout(this.endGraceTimer);
    this.endWatch = null;
    this.endGraceTimer = null;
    const m = this.match;
    if (m instanceof HostMatch && m.phase !== 'ended') m.abort();
    this.match = null;
    this.bg?.dispose();
    this.bg = null;
    this.controls?.dispose();
    this.controls = null;
    this.hud?.dispose();
    this.hud = null;
    this.sfx.mute();
    void import('./game/launch').then((g) => g.stopMatchScene());
    document.body.classList.remove('in-game');
    void keepScreenOn(false);
    this.resultsShown = false;
    if (this.session) {
      this.screen = 'lobby';
      this.lobbySig = '';
      this.renderLobby();
      // A new match may already be running (results were open): join it.
      if (this.session.room?.phase === 'playing' && this.session.room.matchId !== this.matchId) void this.enterMatch(this.session.room);
    }
  }

  leaveRoom(): void {
    this.session?.leave();
    this.goHome();
  }

  private goHome(): void {
    if (this.match) this.exitMatch();
    this.session?.dispose();
    this.session = null;
    storeSession(null);
    if (this.lobbyTimer) clearInterval(this.lobbyTimer);
    this.lobbyTimer = null;
    history.replaceState(null, '', location.pathname + location.search);
    void exitFullscreen();
    this.show('home');
  }

  private linkDebug(): string {
    const s = this.session;
    if (!s) return '';
    const lines: string[] = [];
    for (const [id, l] of s.links) {
      lines.push(`#${id} ${l.state} ${l.route} ice ${Math.round(l.iceRttMs)} ms wire ↑${l.wireUpKbps.toFixed(1)} ↓${l.wireDownKbps.toFixed(1)} kbps`);
    }
    if (s.conditioner.active) lines.push(`netsim lag ${s.conditioner.s.lagMs} jitter ${s.conditioner.s.jitterMs} loss ${s.conditioner.s.lossPct}% dropped ${s.conditioner.dropped}`);
    return lines.join('\n');
  }

  /** Read-only hooks for automated browser tests (tests/e2e). */
  private exposeDebugHooks(): void {
    const hud = makeHudInfo();
    const net = makeNetInfo();
    (window as unknown as { __minimi: unknown }).__minimi = {
      state: () => ({
        screen: this.screen,
        code: this.session?.code ?? null,
        myId: this.session?.myId ?? 0,
        isHost: this.session?.isHost ?? false,
        room: this.session?.room ?? null,
        matchPhase: this.match?.phase ?? null,
        results: this.match?.results ?? null,
      }),
      stats: () => {
        const m: MatchView | null = this.match;
        if (m) {
          m.hud(hud);
          m.net(net);
        }
        const links = this.session ? [...this.session.links.entries()].map(([id, l]) => ({ id, state: l.state, route: l.route, iceRttMs: l.iceRttMs, wireUpKbps: l.wireUpKbps, wireDownKbps: l.wireDownKbps })) : [];
        const players = m ? m.collectPlayers(Array.from({ length: 9 }, () => ({ id: 0, x: 0, y: 0, vx: 0, vy: 0, aim: 0, flags: 0, hp: 0, weapon: 0, spawn: 0, local: false }))) : 0;
        return { fps: this.quality?.fps ?? 0, quality: this.quality?.level ?? null, hud: { ...hud }, net: { ...net }, links, visiblePlayers: players };
      },
    };
  }
}

void new App().start();

// PWA: cache the app shell for instant repeat loads (production builds only).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
