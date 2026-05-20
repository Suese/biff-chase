// Bootstrap. Wires the lobby/net flow, render scene, input, audio, and the
// host's GameRoom together. The host runs the authoritative GameRoom and sends
// state snapshots over PeerJS at ~20 Hz; clients render received state and
// predict their own car locally for responsiveness.

import { GameRoom } from './game.js';
import { HostNet, ClientNet } from './net.js';
import { RallyScene } from './render.js';
import { Audio } from './audio.js';
import { createInputTracker } from './input.js';
import { scheduleAfter, tickClock } from './clock.js';
import * as ui from './ui.js';

// ---- Module state ----
let mode = null;           // 'host' | 'client'
let host = null;
let client = null;
let room = null;           // GameRoom (host only)
let myId = null;
let myName = 'Driver';
let lastState = null;
let prevPhase = null;
let inputTracker = null;
let lastSentInput = null;

// Predicted-car smoothing: we don't run a full second Matter world client-side;
// instead we interpolate received snapshots and apply input-driven extrapolation
// to our own car to mask latency.
const interpCars = new Map();   // id -> { x, y, a, vx, vy, w, lastUpdateMs }

const scene = new RallyScene(document.getElementById('canvas-root'));
const sfx = new Audio();

// Resume audio on first interaction (browser policy)
const wake = () => sfx.resume();
window.addEventListener('pointerdown', wake);
window.addEventListener('keydown', wake);

document.getElementById('mute-btn').addEventListener('click', () => {
  sfx.muted = !sfx.muted;
  sfx.setMuted(sfx.muted);
  document.getElementById('mute-btn').textContent = sfx.muted ? '🔇' : '🔊';
  try { localStorage.setItem('rallyMuted', sfx.muted ? '1' : '0'); } catch {}
});
if (localStorage.getItem('rallyMuted') === '1') {
  sfx.muted = true;
  sfx.setMuted(true);
  document.getElementById('mute-btn').textContent = '🔇';
}

// Wire the lobby IMMEDIATELY — never block these handlers on the renderer
// initialising. (PixiJS init can be slow on first WebGPU detection, and if it
// rejects/hangs we still want the lobby to be interactive.)
ui.bindLobby({
  onHost: () => startHost(),
  onJoin: () => startClient(),
});

ui.bindWaiting({
  onStart: () => {
    if (mode === 'host') room.handleAction(myId, { name: 'start' });
  },
});

ui.bindEnd({
  onPlayAgain: () => sendAction({ name: 'rematch' }),
});

ui.bindShop({
  onPurchase: (upgradeId) => sendAction({ name: 'buy_upgrade', upgradeId }),
  onReady: () => sendAction({ name: 'shop_ready' }),
});

// Initialise the renderer in the background. Surface any failure into the
// lobby status so it never disappears silently.
let _sceneReady = false;
const _sceneReadyPromise = scene.init().then(() => {
  _sceneReady = true;
  scene.onTick(() => tickClock());
}).catch(err => {
  console.error('Renderer init failed', err);
  ui.setLobbyStatus('Renderer failed to start: ' + (err?.message || err));
});

async function startHost() {
  myName = ui.readNameInput();
  if (!myName) { ui.setLobbyStatus('Enter your name first.'); return; }
  ui.persistName(myName);
  ui.setLobbyStatus('Connecting to peer network...');
  // Make sure the renderer is up before we actually enter a race — the lobby
  // itself is fine without it.
  await _sceneReadyPromise;
  host = new HostNet();
  try {
    myId = await host.start();
  } catch (err) {
    ui.setLobbyStatus('Could not connect: ' + (err?.message || err));
    return;
  }
  room = new GameRoom({
    onState: (state) => {
      host.broadcast({ type: 'state', state });
      applyState(state);
    },
    onEvent: (event) => {
      host.broadcast({ type: 'event', event });
      applyEvent(event);
    },
  });
  room.setHostId(myId);
  room.addPlayer(myId, myName);

  host.on('disconnect', (peerId) => { room.removePlayer(peerId); });
  host.on('action', (fromId, msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type !== 'action') return;
    const action = msg.action;
    if (!action) return;
    if (action.name === 'join') {
      room.addPlayer(fromId, action.value);
      host.sendTo(fromId, { type: 'state', state: room.snapshot({ includeTrack: true }) });
    } else {
      room.handleAction(fromId, action);
    }
  });

  // Host's tick — drives the room's physics + state broadcasts.
  scene.onTick((dt) => { if (room) room.tick(dt); });

  mode = 'host';
  enterWaitingRoom(myId);
  ui.log(`Hosting as ${myName}.`);
}

function extractRoomCode(input) {
  const s = (input || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    const r = u.searchParams.get('room');
    if (r) return r;
  } catch {}
  return s;
}

async function startClient() {
  const code = extractRoomCode(ui.readJoinCode());
  if (!code) { ui.setLobbyStatus('Enter a room link or code first.'); return; }
  myName = ui.readNameInput();
  if (!myName) { ui.setLobbyStatus('Enter your name first.'); return; }
  ui.persistName(myName);
  ui.setLobbyStatus('Connecting...');
  await _sceneReadyPromise;

  client = new ClientNet();
  try {
    myId = await client.start();
  } catch (err) {
    ui.setLobbyStatus('Could not initialize peer: ' + (err?.message || err));
    return;
  }
  client.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'state') applyState(msg.state);
    else if (msg.type === 'event') applyEvent(msg.event);
  });
  client.on('close', () => ui.log('Disconnected from host.', 'bust'));
  client.on('error', (err) => ui.log('Network error: ' + (err?.message || err), 'bust'));

  try { await client.connect(code); }
  catch (err) {
    ui.setLobbyStatus('Connection failed: ' + (err?.message || err));
    return;
  }
  client.send({ type: 'action', action: { name: 'join', value: myName } });
  mode = 'client';
  enterWaitingRoom(code);
  ui.log(`Joined ${code}.`);
}

function enterWaitingRoom(roomCode) {
  ui.show('waiting');
  ui.renderWaitingRoom({
    players: [{ id: myId, name: myName }],
    hostId: mode === 'host' ? myId : null,
    myId,
    roomCode,
    isHost: mode === 'host',
  });
}

// ---- Input wiring ----
inputTracker = createInputTracker(
  (state) => {
    // De-dupe before sending
    const key = `${state.up}${state.down}${state.left}${state.right}${state.brake}`;
    if (key === lastSentInput) return;
    lastSentInput = key;
    sendAction({ name: 'input', ...state });
  },
  () => {
    sendAction({ name: 'use_item' });
  }
);

function sendAction(action) {
  if (mode === 'host') {
    if (room) room.handleAction(myId, action);
  } else if (mode === 'client') {
    client?.send({ type: 'action', action });
  }
}

// ---- State + event handlers ----
function applyState(state) {
  const phaseChanged = state.phase !== prevPhase;
  prevPhase = state.phase;
  lastState = state;

  // Rebuild the scene if the track changed. State sometimes carries only the
  // seed (bandwidth optimisation) — in that case the receiver should already
  // have the full track from an earlier snapshot.
  if (state.track && state.track.bounds && (!scene._currentTrack || scene._currentTrack.seed !== state.track.seed)) {
    scene.buildBackground(state.track.bounds);
    scene.buildTrack(state.track);
  } else if (state.track && !state.track.bounds && scene._currentTrack && scene._currentTrack.seed !== state.track.seed) {
    // We have a new seed but no payload — client missed the bootstrap snapshot.
    // The next periodic snapshot from the host won't include it either, so
    // request a refresh by sending a no-op join.
    if (mode === 'client' && client) {
      client.send({ type: 'action', action: { name: 'join', value: myName } });
    }
  }

  // Phase-driven HUD switching
  if (state.phase === 'lobby') {
    ui.show('waiting');
    ui.setShopVisible(false);
    ui.renderWaitingRoom({
      players: state.players,
      hostId: state.hostId,
      myId,
      roomCode: state.hostId,
      isHost: state.hostId === myId,
    });
    sfx.stopEngine();
  } else if (state.phase === 'match_over') {
    ui.show('endScreen');
    ui.setShopVisible(false);
    ui.renderEnd(state, myId);
    sfx.stopEngine();
  } else if (state.phase === 'shop') {
    ui.show('gameUi');                  // keep canvas visible
    ui.setShopVisible(true);
    ui.renderShop(state, myId);
    sfx.stopEngine();
  } else {
    ui.show('gameUi');
    ui.setShopVisible(false);
    ui.renderScoreboard(state, myId);
    ui.renderRaceBanner(state);
    ui.renderLapCounter(state, myId);
    ui.renderInventory(state, myId);
    if (phaseChanged && (state.phase === 'racing' || state.phase === 'countdown')) {
      sfx.startEngine();
    }
  }

  // Bring interp targets up to date
  if (state.cars) {
    const present = new Set();
    for (const c of state.cars) {
      present.add(c.id);
      const t = interpCars.get(c.id) || { x: c.x, y: c.y, a: c.a, vx: 0, vy: 0, w: 0 };
      // For OUR car: keep our predicted position when very close — otherwise snap.
      if (c.id === myId && Math.hypot(t.x - c.x, t.y - c.y) < 24) {
        // Soft pull
        t.x += (c.x - t.x) * 0.25;
        t.y += (c.y - t.y) * 0.25;
        t.a += angleDelta(t.a, c.a) * 0.3;
      } else {
        t.x = c.x; t.y = c.y; t.a = c.a;
      }
      t.vx = c.vx; t.vy = c.vy; t.w = c.w;
      t.boost = c.boost;
      t.alive = c.alive;
      t.lastUpdateMs = performance.now();
      interpCars.set(c.id, t);
    }
    for (const id of [...interpCars.keys()]) {
      if (!present.has(id)) interpCars.delete(id);
    }
  }
}

function applyEvent(ev) {
  if (!ev || !ev.type) return;
  switch (ev.type) {
    case 'log': ui.log(ev.text, ev.kind || ''); break;
    case 'race_start':
      ui.log(`Race ${ev.raceNumber} — track ${ev.seed.toString(16).slice(0, 6)}`);
      break;
    case 'race_go':
      sfx.countdown(0);
      ui.log('GO!', 'win');
      break;
    case 'lap':
      if (ev.playerId === myId) sfx.beep(660, 0.16, 'sine', 0.3);
      break;
    case 'race_winner':
      if (ev.playerId === myId) ui.log('You won the race!', 'win');
      break;
    case 'pickup_taken':
      if (ev.playerId === myId) {
        sfx.pickup();
      }
      // Burst
      // (rendered later in main render loop using last known pickup pos)
      break;
    case 'mine_hit':
      sfx.mineBoom();
      scene.emitBurst(ev.x, ev.y, 24, 0xff6a3d, 320, 0.6);
      break;
    case 'spikes_hit':
      sfx.collide(0.6);
      scene.emitBurst(ev.x, ev.y, 12, 0xaab0bd, 200, 0.5);
      break;
    case 'race_over':
      sfx.beep(880, 0.4, 'sine', 0.35);
      break;
    case 'item_used':
      // Visual ping handled by the inventory update + sfx
      sfx.beep(720, 0.08, 'sine', 0.2);
      break;
    case 'respawn':
      sfx.beep(440, 0.15, 'sine', 0.2);
      break;
    case 'match_over':
      sfx.beep(1320, 0.5, 'sine', 0.5);
      break;
  }
}

function angleDelta(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// ---- Render tick: drive the scene from interpolated state ----
let countdownLastSec = -1;
scene.onTick((dt) => {
  if (!lastState) return;

  // Local input extrapolation for my own car (cheap dead-reckon)
  if (myId && interpCars.has(myId)) {
    const t = interpCars.get(myId);
    const input = inputTracker.getState();
    const accel = input.up ? 380 : (input.down ? -260 : 0);
    const turn = (input.left ? -1 : 0) + (input.right ? 1 : 0);
    if (t.alive) {
      const fx = Math.cos(t.a), fy = Math.sin(t.a);
      t.vx += fx * accel * dt;
      t.vy += fy * accel * dt;
      // gentle drag
      t.vx *= Math.pow(0.95, dt * 60);
      t.vy *= Math.pow(0.95, dt * 60);
      const speed = Math.hypot(t.vx, t.vy);
      const speedNorm = Math.min(1, speed / 320);
      t.a += turn * 3.0 * (0.3 + Math.sqrt(speedNorm) * 0.7) * dt;
      t.x += t.vx * dt;
      t.y += t.vy * dt;
    }
  }
  // For other cars: dead-reckon along their last velocity vector
  for (const [id, t] of interpCars) {
    if (id === myId) continue;
    if (t.alive) {
      t.x += t.vx * dt;
      t.y += t.vy * dt;
      t.a += t.w * dt;
    }
  }

  // Camera follows my car (or first car if I'm a spectator)
  let cam = null;
  if (interpCars.has(myId)) cam = interpCars.get(myId);
  else if (interpCars.size > 0) cam = interpCars.values().next().value;
  if (cam) scene.setCameraTarget(cam.x, cam.y);
  scene.setZoom(0.85);

  // Draw cars + pickups + hazards using interpolated state
  const dispState = lastState;
  // Replace car positions in display state with interpolated ones (preserves
  // server data like alive/boost while letting positions flow smoothly)
  const displayCars = (dispState.cars || []).map(c => {
    const t = interpCars.get(c.id);
    return t ? { ...c, x: t.x, y: t.y, a: t.a } : c;
  });
  scene.syncCars({ ...dispState, cars: displayCars }, performance.now() / 1000);
  scene.syncPickups(dispState.pickups || [], performance.now() / 1000);
  scene.syncHazards(dispState.hazards || [], performance.now() / 1000);

  // Minimap
  scene.drawMinimap({ ...dispState, cars: displayCars }, myId);

  // Speedo (my car)
  const me = displayCars.find(c => c.id === myId);
  if (me) {
    const kmh = Math.hypot(me.vx, me.vy) * 0.36; // tuned so top speed lands roughly under 200
    ui.renderSpeed(kmh);
    sfx.setEngine(kmh, me.boost > 0);
  }

  // Countdown text update — banner ticks once per second
  if (dispState.phase === 'countdown' && dispState.countdownEndsTs) {
    const sec = Math.max(0, Math.ceil((dispState.countdownEndsTs - Date.now()) / 1000));
    if (sec !== countdownLastSec) {
      countdownLastSec = sec;
      if (sec > 0) sfx.countdown(sec);
      ui.renderRaceBanner(dispState);
    }
  } else if (dispState.phase === 'racing') {
    countdownLastSec = -1;
  }

  // Periodic UI tick (banner, lap, shop countdown)
  ui.renderRaceBanner(dispState);
});
