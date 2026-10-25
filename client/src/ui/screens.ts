// Menu screens: home, create, join, settings, lobby. Plain DOM, mobile-first.

import {
  MAPS,
  MATCH_DURATION_OPTIONS,
  MAX_PLAYER_OPTIONS,
  NICKNAME_MAX_LEN,
  PLAYER_COLORS,
  normalizeRoomCode,
  sanitizeNickname,
  type RoomInfo,
  type RoomSettings,
} from '@minimi/shared';
import type { Settings } from '../config';
import type { RoomSession } from '../net/session';
import { clear, copyText, h, toast } from './dom';
import { swatch } from './hud';

export interface MenuApp {
  settings: Settings;
  session: RoomSession | null;
  serverStatus: string;
  saveSettings(): void;
  show(screen: 'home' | 'create' | 'join' | 'settings'): void;
  createRoom(s: RoomSettings): Promise<void>;
  joinRoom(code: string): Promise<void>;
  quickPlay(): Promise<void>;
  leaveRoom(): void;
  setReady(ready: boolean): void;
  startMatch(): void;
  changeRoomSettings(s: Partial<RoomSettings>): void;
  prefillCode: string;
}

function screen(title: string | null, ...body: (Node | null)[]): HTMLElement {
  return h('div', { class: 'screen' }, title ? h('h1', { class: 'screen-title', text: title }) : null, ...body);
}

function segmented<T extends string | number>(
  options: readonly T[],
  value: T,
  label: (v: T) => string,
  onPick: (v: T) => void,
  disabled = false,
): HTMLElement {
  const wrap = h('div', { class: 'seg', attrs: { role: 'radiogroup' } });
  for (const o of options) {
    const b = h('button', {
      class: `seg-btn${o === value ? ' on' : ''}`,
      text: label(o),
      attrs: { type: 'button', role: 'radio', 'aria-checked': String(o === value) },
      on: {
        click: () => {
          if (disabled) return;
          wrap.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('on'));
          b.classList.add('on');
          onPick(o);
        },
      },
    });
    if (disabled) b.setAttribute('disabled', '');
    wrap.appendChild(b);
  }
  return wrap;
}

function identityEditor(app: MenuApp): HTMLElement {
  const input = h('input', {
    class: 'input',
    attrs: { maxlength: String(NICKNAME_MAX_LEN), placeholder: 'Your nickname', autocomplete: 'off', enterkeyhint: 'done', 'aria-label': 'Nickname' },
  });
  input.value = app.settings.name;
  input.addEventListener('change', () => {
    app.settings.name = sanitizeNickname(input.value);
    input.value = app.settings.name;
    app.saveSettings();
  });
  const colors = h('div', { class: 'colors', attrs: { role: 'radiogroup', 'aria-label': 'Soldier color' } });
  PLAYER_COLORS.forEach((c, i) => {
    const b = h('button', {
      class: `color${i === app.settings.color ? ' on' : ''}`,
      attrs: { type: 'button', 'aria-label': `Color ${i + 1}` },
      style: { background: c },
      on: {
        click: () => {
          app.settings.color = i;
          app.saveSettings();
          colors.querySelectorAll('.color').forEach((x) => x.classList.remove('on'));
          b.classList.add('on');
        },
      },
    });
    colors.appendChild(b);
  });
  return h('div', { class: 'identity' }, input, colors);
}

function busy(btn: HTMLButtonElement, fn: () => Promise<void>): void {
  if (btn.disabled) return;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = '…';
  fn().finally(() => {
    btn.disabled = false;
    btn.textContent = label;
  });
}

export function renderHome(root: HTMLElement, app: MenuApp): void {
  clear(root);
  const play = h('button', { class: 'btn primary big', text: 'Play Online' });
  play.addEventListener('click', () => busy(play, () => app.quickPlay()));
  root.appendChild(
    screen(
      null,
      h('div', { class: 'logo' }, h('span', { class: 'logo-a', text: 'JETPACK' }), h('span', { class: 'logo-b', text: 'BRAWL' })),
      h('p', { class: 'tagline', text: 'Online 2–8 player jetpack shooter · no install · no signup' }),
      identityEditor(app),
      h(
        'div',
        { class: 'menu' },
        play,
        h('button', { class: 'btn', text: 'Create Room', on: { click: () => app.show('create') } }),
        h('button', { class: 'btn', text: 'Join Room', on: { click: () => app.show('join') } }),
        h('button', { class: 'btn ghost', text: 'Settings', on: { click: () => app.show('settings') } }),
      ),
      h('p', { class: 'status', text: app.serverStatus }),
    ),
  );
}

export function renderCreate(root: HTMLElement, app: MenuApp): void {
  clear(root);
  const s: RoomSettings = { maxPlayers: 4, mapId: 0, durationSec: 300 };
  const create = h('button', { class: 'btn primary', text: 'Create Room' });
  create.addEventListener('click', () => busy(create, () => app.createRoom(s)));
  root.appendChild(
    screen(
      'Create Room',
      identityEditor(app),
      h('label', { class: 'field-label', text: 'Max players' }),
      segmented(MAX_PLAYER_OPTIONS, s.maxPlayers as (typeof MAX_PLAYER_OPTIONS)[number], (v) => String(v), (v) => (s.maxPlayers = v)),
      h('label', { class: 'field-label', text: 'Map' }),
      segmented(
        MAPS.map((m) => m.id),
        s.mapId as 0,
        (v) => MAPS[v].name,
        (v) => (s.mapId = v),
      ),
      h('label', { class: 'field-label', text: 'Match duration' }),
      segmented(MATCH_DURATION_OPTIONS, s.durationSec as (typeof MATCH_DURATION_OPTIONS)[number], (v) => `${v / 60} min`, (v) => (s.durationSec = v)),
      h('div', { class: 'menu row' }, h('button', { class: 'btn ghost', text: 'Back', on: { click: () => app.show('home') } }), create),
    ),
  );
}

export function renderJoin(root: HTMLElement, app: MenuApp): void {
  clear(root);
  const code = h('input', {
    class: 'input code',
    attrs: { maxlength: '5', placeholder: 'CODE', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', enterkeyhint: 'go', 'aria-label': 'Room code' },
  });
  code.value = app.prefillCode;
  code.addEventListener('input', () => (code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '')));
  const join = h('button', { class: 'btn primary', text: 'Join' });
  const go = () => {
    const c = normalizeRoomCode(code.value);
    if (!c) {
      toast('Enter the 5-character room code.');
      return;
    }
    busy(join, () => app.joinRoom(c));
  };
  join.addEventListener('click', go);
  code.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
  });
  root.appendChild(
    screen(
      'Join Room',
      identityEditor(app),
      h('label', { class: 'field-label', text: 'Room code' }),
      code,
      h('div', { class: 'menu row' }, h('button', { class: 'btn ghost', text: 'Back', on: { click: () => app.show('home') } }), join),
    ),
  );
  if (!code.value) setTimeout(() => code.focus(), 50);
}

export function renderSettings(root: HTMLElement, app: MenuApp): void {
  clear(root);
  const s = app.settings;
  const toggle = (label: string, get: () => boolean, set: (v: boolean) => void) => {
    const cb = h('input', { attrs: { type: 'checkbox' } });
    cb.checked = get();
    cb.addEventListener('change', () => {
      set(cb.checked);
      app.saveSettings();
    });
    return h('label', { class: 'toggle' }, cb, h('span', { text: label }));
  };
  const numField = (label: string, get: () => number, set: (v: number) => void, max: number) => {
    const inp = h('input', { class: 'input small', attrs: { type: 'number', min: '0', max: String(max), inputmode: 'numeric' } });
    inp.value = String(get());
    inp.addEventListener('change', () => {
      const v = Math.max(0, Math.min(max, Math.round(Number(inp.value) || 0)));
      inp.value = String(v);
      set(v);
      app.saveSettings();
    });
    return h('label', { class: 'num' }, h('span', { text: label }), inp);
  };
  root.appendChild(
    screen(
      'Settings',
      h('label', { class: 'field-label', text: 'Graphics quality' }),
      segmented(['auto', 'low', 'high'] as const, s.quality, (v) => v[0].toUpperCase() + v.slice(1), (v) => {
        s.quality = v;
        app.saveSettings();
      }),
      toggle('Sound effects', () => s.sound, (v) => (s.sound = v)),
      toggle('Show network debug panel', () => s.showDebug, (v) => (s.showDebug = v)),
      h('details', { class: 'advanced' },
        h('summary', { text: 'Network testing (advanced)' }),
        h('p', { class: 'hint', text: 'Simulates a bad connection on this device only. Applies to rooms you join after saving.' }),
        toggle('Force TURN relay (test relay path)', () => s.relayOnly, (v) => (s.relayOnly = v)),
        numField('Added latency (ms RTT)', () => s.sim.lagMs, (v) => (s.sim.lagMs = v), 1000),
        numField('Jitter (ms)', () => s.sim.jitterMs, (v) => (s.sim.jitterMs = v), 500),
        numField('Packet loss (%)', () => s.sim.lossPct, (v) => (s.sim.lossPct = v), 50),
        numField('Upload cap (kbit/s, 0 = off)', () => s.sim.bwKbps, (v) => (s.sim.bwKbps = v), 100000),
      ),
      h('div', { class: 'menu row' }, h('button', { class: 'btn primary', text: 'Done', on: { click: () => app.show('home') } })),
    ),
  );
}

export function renderLobby(root: HTMLElement, app: MenuApp): void {
  const session = app.session;
  const room = session?.room;
  clear(root);
  if (!session || !room) {
    root.appendChild(screen('Connecting…', h('p', { class: 'hint', text: 'Joining the room…' })));
    return;
  }
  const me = room.members.find((m) => m.id === session.myId);
  const isOwner = room.ownerId === session.myId;
  const link = `${location.origin}/#/join/${room.code}`;

  const codeBox = h(
    'div',
    { class: 'room-code' },
    h('span', { class: 'code-label', text: 'ROOM' }),
    h('span', { class: 'code-value', text: room.code }),
    h('button', {
      class: 'btn small',
      text: 'Copy invite',
      on: {
        click: async () => toast((await copyText(link)) ? 'Invite link copied' : room.code),
      },
    }),
    'share' in navigator
      ? h('button', {
          class: 'btn small ghost',
          text: 'Share',
          on: { click: () => void navigator.share({ title: 'Jetpack Brawl', text: `Join my room ${room.code}`, url: link }).catch(() => {}) },
        })
      : null,
  );

  const mapName = MAPS.find((m) => m.id === room.settings.mapId)?.name ?? '?';
  const settingsBox = isOwner && room.phase === 'lobby'
    ? h(
        'div',
        { class: 'room-settings' },
        segmented(MAPS.map((m) => m.id), room.settings.mapId as 0, (v) => MAPS[v].name, (v) => app.changeRoomSettings({ mapId: v })),
        segmented(MATCH_DURATION_OPTIONS, room.settings.durationSec as 300, (v) => `${v / 60} min`, (v) => app.changeRoomSettings({ durationSec: v })),
        segmented(MAX_PLAYER_OPTIONS, room.settings.maxPlayers as 4, (v) => `${v}P`, (v) => app.changeRoomSettings({ maxPlayers: v })),
      )
    : h('p', { class: 'room-meta', text: `${mapName} · ${room.settings.durationSec / 60} min · up to ${room.settings.maxPlayers} players` });

  const list = h('ul', { class: 'members' });
  for (const m of room.members) {
    const badges: HTMLElement[] = [];
    if (m.id === room.hostId) badges.push(h('span', { class: 'badge host', text: 'HOST' }));
    if (m.id === session.myId) badges.push(h('span', { class: 'badge you', text: 'YOU' }));
    if (m.id !== room.hostId) badges.push(h('span', { class: `badge ${m.ready ? 'ready' : 'notready'}`, text: m.ready ? 'READY' : 'NOT READY' }));
    badges.push(h('span', { class: 'conn', text: connText(app, room, m.id, m.connected) }));
    list.appendChild(h('li', { class: m.connected ? '' : 'away' }, swatch(m.color), h('span', { class: 'mname', text: m.name }), ...badges));
  }

  const connected = room.members.filter((m) => m.connected);
  const allReady = connected.every((m) => m.id === room.ownerId || m.ready);
  const canStart = isOwner && room.phase === 'lobby' && connected.length >= 2 && allReady;
  const actions = h('div', { class: 'menu row' }, h('button', { class: 'btn ghost', text: 'Leave', on: { click: () => app.leaveRoom() } }));
  if (room.phase === 'playing') {
    actions.appendChild(h('p', { class: 'hint', text: 'Match in progress — joining…' }));
  } else if (isOwner) {
    const start = h('button', { class: 'btn primary', text: canStart ? 'Start match' : connected.length < 2 ? 'Waiting for players…' : 'Waiting for ready…' });
    if (!canStart) start.setAttribute('disabled', '');
    start.addEventListener('click', () => app.startMatch());
    actions.appendChild(start);
  } else {
    const ready = !!me?.ready;
    actions.appendChild(h('button', { class: `btn ${ready ? '' : 'primary'}`, text: ready ? 'Not ready' : 'Ready!', on: { click: () => app.setReady(!ready) } }));
  }

  const notes: (HTMLElement | null)[] = [];
  if (room.public) {
    const left = Math.ceil((room.autoStartInMs - (performance.now() - session.roomAt)) / 1000);
    notes.push(
      h('p', {
        class: 'hint strong',
        text: room.phase === 'lobby' && room.autoStartInMs > 0 ? `Public match · starts in ${Math.max(0, left)} s` : 'Public match · starts automatically when 2+ players are here',
      }),
    );
  }
  if (session.signalingState !== 'open') notes.push(h('p', { class: 'warn', text: 'Reconnecting to the room server…' }));
  if (!session.turnAvailable) notes.push(h('p', { class: 'hint', text: 'Relay (TURN) is not configured on this server: players behind strict firewalls may not be able to connect.' }));
  if (session.isHost) notes.push(h('p', { class: 'hint', text: 'You are hosting: the match runs on this device. Keep this tab open and in front.' }));

  root.appendChild(screen(null, codeBox, settingsBox, list, ...notes, actions));
}

function connText(app: MenuApp, room: RoomInfo, id: number, connected: boolean): string {
  const s = app.session!;
  if (!connected) return 'offline';
  if (id === s.myId) return s.isHost ? '' : linkText(s.links.get(room.hostId));
  if (s.isHost) return linkText(s.links.get(id));
  return '';
}

function linkText(l: { state: string; route: string; iceRttMs: number } | undefined): string {
  if (!l) return 'connecting…';
  if (l.state !== 'open') return l.state === 'closed' ? 'retrying…' : 'connecting…';
  return `${l.route === 'relay' ? 'relay' : 'direct'} · ${Math.round(l.iceRttMs)} ms`;
}
