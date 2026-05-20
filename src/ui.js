import { scheduleAfter } from './clock.js';
import { ITEMS } from './items.js';
import { UPGRADES } from './upgrades.js';
import { colorForPlayer, colorHexForPlayer } from './colors.js';

const $ = (id) => document.getElementById(id);

const els = {
  lobby: () => $('lobby'),
  waiting: () => $('waiting'),
  gameUi: () => $('game-ui'),
  endScreen: () => $('end-screen'),
  shopModal: () => $('shop-modal'),
  shopBalance: () => $('shop-balance'),
  shopGrid: () => $('shop-grid'),
  shopClose: () => $('shop-close'),
  shopWaiting: () => $('shop-waiting'),
  matchScores: () => $('match-scores'),
  nameInput: () => $('name-input'),
  joinCode: () => $('join-code'),
  hostBtn: () => $('host-btn'),
  joinBtn: () => $('join-btn'),
  lobbyStatus: () => $('lobby-status'),
  roomCode: () => $('room-code'),
  shareCopy: () => $('share-copy'),
  playerList: () => $('player-list'),
  startBtn: () => $('start-btn'),
  hostControls: () => $('host-controls'),
  waitingTag: () => $('waiting-tag'),
  scoreboard: () => $('scoreboard'),
  raceBanner: () => $('race-banner'),
  lapCounter: () => $('lap-counter'),
  speedText: () => $('speed-text'),
  inventory: () => $('inventory'),
  log: () => $('log'),
  logPanel: () => $('log-panel'),
  logToggle: () => $('log-toggle'),
  logPreview: () => $('log-preview'),
  endTitle: () => $('end-title'),
  finalScores: () => $('final-scores'),
  playAgainBtn: () => $('play-again-btn'),
};

export function show(which) {
  for (const k of ['lobby', 'waiting', 'gameUi', 'endScreen']) {
    els[k]().classList.add('hidden');
  }
  els[which]().classList.remove('hidden');
}

export function setLobbyStatus(text) {
  els.lobbyStatus().textContent = text || '';
}

export function readNameInput() {
  return (els.nameInput().value || '').trim().slice(0, 16);
}

export function readJoinCode() {
  return (els.joinCode().value || '').trim();
}

export function bindLobby({ onHost, onJoin }) {
  els.hostBtn().addEventListener('click', onHost);
  els.joinBtn().addEventListener('click', onJoin);
  els.nameInput().addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const url = new URL(window.location.href);
      if (url.searchParams.get('room')) els.joinBtn().click();
      else els.hostBtn().click();
    }
  });
  els.joinCode().addEventListener('keydown', e => {
    if (e.key === 'Enter') els.joinBtn().click();
  });

  const saved = localStorage.getItem('rallyName');
  if (saved) els.nameInput().value = saved;

  const url = new URL(window.location.href);
  const room = url.searchParams.get('room');
  const hostRow = $('lobby-host');
  const joinSection = $('lobby-join');
  const divider = $('lobby-divider');
  if (room) {
    els.joinCode().value = room;
    if (hostRow) hostRow.style.display = 'none';
    if (divider) divider.style.display = 'none';
    const codeLabel = $('lobby-join-code-label');
    if (codeLabel) codeLabel.style.display = 'none';
    scheduleAfter(0, () => els.nameInput().focus());
  } else {
    if (joinSection) joinSection.style.display = 'none';
    if (divider) divider.style.display = 'none';
  }
}

export function persistName(name) {
  try { localStorage.setItem('rallyName', name); } catch {}
}

export function buildRoomUrl(roomCode) {
  const url = new URL(window.location.href);
  url.hash = '';
  url.searchParams.set('room', roomCode);
  return url.toString();
}

export function renderWaitingRoom({ players, hostId, myId, roomCode, isHost }) {
  els.roomCode().textContent = roomCode ? buildRoomUrl(roomCode) : '';
  const list = els.playerList();
  list.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    const left = document.createElement('span');
    left.textContent = p.name + (p.id === myId ? ' (you)' : '');
    const right = document.createElement('span');
    if (p.id === hostId) {
      right.className = 'badge';
      right.textContent = 'host';
    }
    li.appendChild(left);
    li.appendChild(right);
    list.appendChild(li);
  }
  els.hostControls().style.display = isHost ? 'flex' : 'none';
  els.waitingTag().textContent = isHost
    ? (players.length < 2 ? 'Solo race, or wait for friends to join.' : 'Hit start when everyone is in.')
    : 'Waiting for host to start the race.';
  els.startBtn().disabled = players.length < 1;
}

function flashButton(btn, msg, ms = 1500) {
  const original = btn.textContent;
  btn.textContent = msg;
  scheduleAfter(ms, () => { btn.textContent = original; });
}

export function bindWaiting({ onStart }) {
  els.shareCopy().addEventListener('click', () => {
    const link = (els.roomCode().textContent || '').trim();
    if (!link) return;
    navigator.clipboard?.writeText(link).catch(() => {});
    flashButton(els.shareCopy(), '✅ Copied!');
  });
  els.startBtn().addEventListener('click', onStart);
}

export function bindEnd({ onPlayAgain }) {
  els.playAgainBtn().addEventListener('click', onPlayAgain);
}

// Log
let logEntries = 0;
export function log(text, kind = '') {
  const logEl = els.log();
  const panel = els.logPanel();
  if (panel) panel.style.display = 'block';
  const e = document.createElement('div');
  e.className = 'entry' + (kind ? ' ' + kind : '');
  e.textContent = text;
  logEl.appendChild(e);
  logEl.scrollTop = logEl.scrollHeight;
  logEntries++;
  while (logEntries > 60 && logEl.firstChild) {
    logEl.removeChild(logEl.firstChild);
    logEntries--;
  }
  const preview = els.logPreview();
  if (preview) {
    preview.textContent = text;
    preview.className = kind || '';
  }
}

{
  const toggle = els.logToggle();
  if (toggle) {
    toggle.addEventListener('click', () => {
      const panel = els.logPanel();
      if (!panel) return;
      panel.classList.toggle('minimized');
    });
  }
}

// In-race HUD
export function renderScoreboard(state, myId) {
  const sb = els.scoreboard();
  sb.innerHTML = '<h3>Match — First to 10</h3>';
  const sorted = (state.players || []).slice().sort((a, b) =>
    (state.matchPoints?.[b.id] || 0) - (state.matchPoints?.[a.id] || 0)
  );
  for (const p of sorted) {
    const row = document.createElement('div');
    row.className = 'score-row';
    const name = document.createElement('span');
    name.textContent = p.name + (p.id === myId ? ' (you)' : '');
    name.style.color = colorForPlayer(state, p.id);
    name.style.fontWeight = '700';
    const pts = document.createElement('span');
    pts.className = 'pts';
    pts.textContent = state.matchPoints?.[p.id] ?? 0;
    row.appendChild(name);
    row.appendChild(pts);
    sb.appendChild(row);
  }
}

export function renderRaceBanner(state) {
  const banner = els.raceBanner();
  const phase = state.phase;
  if (phase === 'countdown') {
    const remaining = Math.max(0, Math.ceil((state.countdownEndsTs - Date.now()) / 1000));
    banner.textContent = remaining > 0 ? `${remaining}` : 'GO!';
    banner.style.color = remaining > 0 ? '#ffce3d' : '#7cf3a0';
  } else if (phase === 'racing') {
    banner.textContent = `Race ${state.raceNumber}`;
    banner.style.color = '#fff';
  } else if (phase === 'finished') {
    const winner = state.players.find(p => p.id === state.raceWinnerId);
    banner.textContent = winner ? `${winner.name} wins!` : 'Race over';
    banner.style.color = '#ffce3d';
  } else if (phase === 'shop') {
    banner.textContent = 'Garage';
    banner.style.color = '#fff';
  } else {
    banner.textContent = '';
  }
}

export function renderLapCounter(state, myId) {
  const me = (state.cars || []).find(c => c.id === myId);
  if (!me || !state.totalLaps) {
    els.lapCounter().textContent = '';
    return;
  }
  const lap = Math.min(me.lap + 1, state.totalLaps);
  els.lapCounter().textContent = `Lap ${lap} / ${state.totalLaps}`;
}

export function renderSpeed(speed) {
  els.speedText().textContent = Math.max(0, Math.round(speed));
}

export function renderInventory(state, myId) {
  const tray = els.inventory();
  if (!state || state.phase === 'lobby') {
    tray.innerHTML = '';
    return;
  }
  const inv = state.inventories?.[myId] || {};
  const ids = Object.keys(inv).filter(id => inv[id] > 0);
  tray.innerHTML = '';
  for (const id of ids) {
    const item = ITEMS[id];
    if (!item) continue;
    const el = document.createElement('div');
    el.className = 'inv-item';
    el.title = item.desc;
    el.innerHTML = `<span class="ic">${item.icon}</span><span class="ct">×${inv[id]}</span><span class="key">${item.key || 'Q'}</span>`;
    tray.appendChild(el);
  }
}

// Shop modal
let _shopHandlers = null;
export function bindShop({ onPurchase, onReady }) {
  _shopHandlers = { onPurchase, onReady };
  els.shopClose().addEventListener('click', () => {
    onReady?.();
  });
}

export function setShopVisible(visible) {
  els.shopModal().classList.toggle('hidden', !visible);
}

export function renderShop(state, myId) {
  if (!state) return;
  const myScrap = state.scrap?.[myId] || 0;
  els.shopBalance().textContent = myScrap;

  const grid = els.shopGrid();
  grid.innerHTML = '';
  const myUpgrades = state.upgrades?.[myId] || {};
  for (const [id, u] of Object.entries(UPGRADES)) {
    const lvl = myUpgrades[id] || 0;
    const maxed = lvl >= u.maxLevel;
    const cost = u.costAt(lvl);
    const canAfford = !maxed && myScrap >= cost;
    const card = document.createElement('button');
    card.className = 'shop-card' + (maxed ? ' maxed' : (canAfford ? ' available' : ' broke'));
    card.disabled = maxed || !canAfford;
    card.innerHTML = `
      <div class="icon">${u.icon}</div>
      <div class="name">${u.name}</div>
      <div class="desc">${u.desc}</div>
      <div class="lvl">Lv ${lvl} / ${u.maxLevel}</div>
      <div class="cost">${maxed ? 'MAX' : cost + ' scrap'}</div>
    `;
    card.addEventListener('click', () => _shopHandlers?.onPurchase?.(id));
    grid.appendChild(card);
  }

  // Match scores list
  const ms = els.matchScores();
  ms.innerHTML = '';
  const sorted = (state.players || []).slice().sort((a, b) =>
    (state.matchPoints?.[b.id] || 0) - (state.matchPoints?.[a.id] || 0)
  );
  for (const p of sorted) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = p.name + (p.id === myId ? ' (you)' : '');
    name.style.color = colorForPlayer(state, p.id);
    name.style.fontWeight = '700';
    const pts = document.createElement('span');
    pts.textContent = `${state.matchPoints?.[p.id] || 0} pts`;
    li.appendChild(name);
    li.appendChild(pts);
    ms.appendChild(li);
  }

  // Ready indicator
  const ready = state.shopReady || {};
  const total = state.players?.length || 0;
  const readyCount = Object.values(ready).filter(Boolean).length;
  const meReady = !!ready[myId];
  els.shopClose().textContent = meReady ? `Waiting (${readyCount}/${total})` : 'Ready';
  els.shopClose().disabled = meReady;
  const next = (state.shopEndsTs && state.shopEndsTs > Date.now())
    ? Math.ceil((state.shopEndsTs - Date.now()) / 1000) + 's until next race'
    : '';
  els.shopWaiting().textContent = next;
}

export function renderEnd(state, myId) {
  const list = els.finalScores();
  list.innerHTML = '';
  const sorted = (state.players || []).slice().sort((a, b) =>
    (state.matchPoints?.[b.id] || 0) - (state.matchPoints?.[a.id] || 0)
  );
  const top = state.matchPoints?.[sorted[0]?.id] || 0;
  for (const p of sorted) {
    const li = document.createElement('li');
    if ((state.matchPoints?.[p.id] || 0) === top) li.className = 'winner';
    const name = document.createElement('span');
    name.textContent = p.name + (p.id === myId ? ' (you)' : '');
    name.style.color = colorForPlayer(state, p.id);
    name.style.fontWeight = '700';
    const pts = document.createElement('span');
    pts.textContent = (state.matchPoints?.[p.id] || 0) + ' pts';
    li.appendChild(name);
    li.appendChild(pts);
    list.appendChild(li);
  }
  els.endTitle().textContent = sorted[0] ? `${sorted[0].name} wins!` : 'Match over';
}
