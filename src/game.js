// Host-authoritative race room. Owns the match state, Matter physics world,
// ECS bag, race lifecycle. Drives a fixed 60 Hz simulation and emits state
// snapshots + events on each step (state at 20 Hz, events as they happen).
//
// All actions are funneled through handleAction(fromId, action) — including the
// host's own actions (so the host plays through the same code path as clients
// do). Net layer translates inbound messages into handleAction calls.

import Matter from 'matter-js';
import {
  createWorld, createCarBody, refreshCarStats,
  stepCar, clampToTrack, dealDamage, respawnCar, carSnapshot, applyCarSnapshot,
  buildWallBodies,
  FIXED_DT, CAR_LENGTH, PICKUP_R, MINE_R, OIL_R,
} from './physics.js';
import { generateTrack, gridSpawnPositions } from './track.js';
import { ITEMS, rollPickupKind } from './items.js';
import { UPGRADES, computeStats } from './upgrades.js';
import { mulberry32, hashStr } from './rng.js';
import { scheduleAfter } from './clock.js';
import {
  makeECS, makeCarEntity, makePickupEntity, makeHazardEntity,
  eachCar, eachPickup, eachHazard,
  getRigidBody, getDriver, getLapData, getPickupData, getHazardData,
} from './ecs.js';

const TOTAL_LAPS = 3;
const MATCH_GOAL = 10;
const RACE_TIME_AFTER_FIRST_FINISH = 25_000; // ms before late finishers DNF
const COUNTDOWN_MS = 3500;
const SHOP_MAX_MS  = 25_000;
const PICKUP_RESPAWN_MS = 6_000;
const MINE_TTL_S = 30;
const OIL_TTL_S  = 18;
const STATE_HZ = 20;

function shortId(id) {
  return (id || '').toString().slice(0, 8);
}

export class GameRoom {
  constructor({ onState, onEvent }) {
    this.onState = onState;
    this.onEvent = onEvent;

    // Persistent match state
    this.hostId = null;
    this.players = [];                  // [{ id, name }]
    this.matchPoints = {};              // id -> int
    this.scrap = {};                    // id -> int (currency)
    this.upgrades = {};                 // id -> { engine, tires, armor, fuel }
    this.inventories = {};              // id -> { itemId: count }
    this.shopReady = {};                // id -> bool

    // Per-race state
    this.phase = 'lobby';
    this.raceNumber = 0;
    this.totalLaps = TOTAL_LAPS;
    this.track = null;
    this.engine = null;
    this.cars = new Map();              // id -> Matter body  (fast lookup; mirrored as ECS entities)
    this.carEntities = new Map();       // id -> ECS Entity
    this.pickupEntities = new Map();    // slotIndex -> ECS Entity
    this.hazardEntities = new Map();    // hazardId -> ECS Entity
    this.hazardSeq = 0;
    // The ECS world is the canonical logical entity registry. Matter still
    // owns physics state, so ECS queries dereference into the bound Matter
    // body to read x/y/angle.
    this.ecs = makeECS();
    this.countdownEndsTs = 0;
    this.shopEndsTs = 0;
    this.raceWinnerId = null;
    this.firstFinishTs = 0;

    // Step accounting (fixed timestep accumulator)
    this._accum = 0;
    this._lastStateBroadcastTs = 0;
    this._stateIntervalMs = 1000 / STATE_HZ;
    this._lastBroadcastTrackSeed = null;   // include track payload in state only when changed
  }

  setHostId(id) { this.hostId = id; }

  addPlayer(id, name) {
    if (this.players.find(p => p.id === id)) return;
    this.players.push({ id, name: name || 'Driver' });
    this.matchPoints[id] = this.matchPoints[id] || 0;
    this.scrap[id]       = this.scrap[id]       || 0;
    this.upgrades[id]    = this.upgrades[id]    || { engine: 0, tires: 0, armor: 0, fuel: 0 };
    this.inventories[id] = this.inventories[id] || {};
    // Spawn a car for late joiners so they don't sit out the current race.
    // We don't have an existing entity for them yet, so the spawn always runs.
    if ((this.phase === 'countdown' || this.phase === 'racing') && this.engine && this.track) {
      this._spawnCarForPlayer(id, name);
      // Force the next snapshot to include the full track so the new client
      // can render it before they see their car.
      this._lastBroadcastTrackSeed = null;
    }
    console.log(`[room] addPlayer id=${shortId(id)} phase=${this.phase} totalPlayers=${this.players.length} hasCar=${this.cars.has(id)}`);
    this.emitState();
    this.emitEvent({ type: 'log', text: `${name} joined.` });
  }

  // Sample the surface type at a world-space (x, y) point. Uses the track's
  // metaMap; out-of-range returns 'pavement' as a safe default.
  _surfaceAtWorld(x, y) {
    const t = this.track;
    if (!t || !t.metaMap) return 'pavement';
    const half = (t.gridSize * t.cellSize) / 2;
    const gx = Math.floor((x + half) / t.cellSize);
    const gy = Math.floor((y + half) / t.cellSize);
    if (gx < 0 || gx >= t.gridSize || gy < 0 || gy >= t.gridSize) return 'pavement';
    const biome = t.metaMap[gy][gx];
    if (biome === 'road') {
      // Use the matching road tile's surface type if available.
      const placement = (t.tilePlacements || []).find(p => p.gx === gx && p.gy === gy);
      return placement?.roadType || 'pavement';
    }
    if (biome === 'forest') return 'forest';
    if (biome === 'land')   return 'land';
    return 'pavement';
  }

  // Spawn a single car at the back of the current grid. Used by beginRace and
  // by addPlayer for late joiners.
  _spawnCarForPlayer(playerId, playerName) {
    if (this.cars.has(playerId)) return;     // already has one
    const slots = gridSpawnPositions(this.track, this.players.length);
    const idx = this.players.findIndex(p => p.id === playerId);
    const slot = slots[idx] || slots[slots.length - 1];
    if (!slot) {
      console.warn('[room] _spawnCarForPlayer no slot', { playerId, idx, slots: slots.length });
      return;
    }
    const stats = computeStats(this.upgrades[playerId] || {});
    const body = createCarBody(slot.x, slot.y, slot.angle, playerId, stats);
    Matter.Composite.add(this.engine.world, body);
    this.cars.set(playerId, body);
    const ent = makeCarEntity({ body, driverId: playerId, driverName: playerName });
    this.ecs.addEntity(ent);
    this.carEntities.set(playerId, ent);
    console.log(`[room] spawn id=${shortId(playerId)} idx=${idx} pos=(${Math.round(slot.x)},${Math.round(slot.y)}) totalCars=${this.cars.size}`);
  }

  removePlayer(id) {
    this.players = this.players.filter(p => p.id !== id);
    const car = this.cars.get(id);
    if (car && this.engine) Matter.Composite.remove(this.engine.world, car);
    this.cars.delete(id);
    const ent = this.carEntities.get(id);
    if (ent) {
      this.ecs.removeEntity(ent);
      this.carEntities.delete(id);
    }
    this.emitState();
    this.emitEvent({ type: 'log', text: 'A driver disconnected.' });
  }

  // ------------ Match flow ------------
  startMatch(byId) {
    if (byId !== this.hostId) return;
    if (this.phase !== 'lobby') return;
    // Reset match points but keep nothing else (fresh match).
    for (const p of this.players) {
      this.matchPoints[p.id] = 0;
      this.scrap[p.id] = 0;
      this.upgrades[p.id] = { engine: 0, tires: 0, armor: 0, fuel: 0 };
      this.inventories[p.id] = {};
    }
    this.raceNumber = 0;
    this.beginRace();
  }

  beginRace() {
    this.raceNumber += 1;
    this.phase = 'countdown';
    const seed = hashStr(`${this.hostId || 'host'}-${this.raceNumber}`);
    this.track = generateTrack(seed);

    // Spin up a fresh Matter world for this race.
    if (this.engine) {
      Matter.Engine.clear(this.engine);
      this.engine = null;
    }
    this.engine = createWorld();
    // Walls authored INTO the tile system become Matter static bodies so
    // cars genuinely collide with them.
    if (this.track.wallSegments?.length) {
      buildWallBodies(this.engine.world, this.track.wallSegments);
    }

    // Wipe ECS world and rebuild from current players + track.
    for (const e of [...this.carEntities.values()])    this.ecs.removeEntity(e);
    for (const e of [...this.pickupEntities.values()]) this.ecs.removeEntity(e);
    for (const e of [...this.hazardEntities.values()]) this.ecs.removeEntity(e);
    this.carEntities.clear();
    this.pickupEntities.clear();
    this.hazardEntities.clear();
    this.cars.clear();

    this.players.forEach((p) => this._spawnCarForPlayer(p.id, p.name));
    console.log(`[room] beginRace players=${this.players.length} cars=${this.cars.size} entities=${this.carEntities.size}`);

    // Pickups
    const rng = mulberry32(seed ^ 0xCAFEBABE);
    this.track.pickupSlots.forEach((slot, i) => {
      const kind = rollPickupKind(rng);
      const ent = makePickupEntity({ slotIndex: i, kind, x: slot.x, y: slot.y });
      this.ecs.addEntity(ent);
      this.pickupEntities.set(i, ent);
    });
    this.raceWinnerId = null;
    this.firstFinishTs = 0;
    this.countdownEndsTs = Date.now() + COUNTDOWN_MS;
    // Force this snapshot to include the full track so every client can build
    // it before cars start moving.
    this._lastBroadcastTrackSeed = null;
    this.emitState();
    this.emitEvent({ type: 'race_start', raceNumber: this.raceNumber, seed });
  }

  endRace() {
    this.phase = 'finished';
    // Finalize finish order — finished cars sorted by finishedAtMs, then unfinished cars sorted by (lap desc, next checkpoint desc).
    const lapDataFor = (pid) => getLapData(this.carEntities.get(pid));
    const ordered = this.players.slice().sort((a, b) => {
      const la = lapDataFor(a.id);
      const lb = lapDataFor(b.id);
      const afin = la?.finishedAtMs || 0;
      const bfin = lb?.finishedAtMs || 0;
      if (afin && bfin) return afin - bfin;
      if (afin) return -1;
      if (bfin) return 1;
      const ap = (la?.lap || 0) * 100 + (la?.nextCheckpoint || 0);
      const bp = (lb?.lap || 0) * 100 + (lb?.nextCheckpoint || 0);
      return bp - ap;
    });

    // Award match points: 2/1 for 3+ players, 1/0 for 2 players
    const playerCount = this.players.length;
    if (ordered[0]) {
      this.matchPoints[ordered[0].id] = (this.matchPoints[ordered[0].id] || 0) + (playerCount >= 3 ? 2 : 1);
    }
    if (playerCount >= 3 && ordered[1]) {
      this.matchPoints[ordered[1].id] = (this.matchPoints[ordered[1].id] || 0) + 1;
    }
    // Scrap award by position
    ordered.forEach((p, i) => {
      const bonus = Math.max(0, 20 - i * 4);
      this.scrap[p.id] = (this.scrap[p.id] || 0) + bonus;
    });

    this.emitEvent({ type: 'race_over', orderIds: ordered.map(p => p.id) });
    this.emitState();

    // Check match end
    const winner = this.players.find(p => (this.matchPoints[p.id] || 0) >= MATCH_GOAL);
    if (winner) {
      scheduleAfter(2500, () => this.endMatch());
    } else {
      scheduleAfter(2500, () => this.enterShop());
    }
  }

  enterShop() {
    this.phase = 'shop';
    this.shopReady = {};
    this.shopEndsTs = Date.now() + SHOP_MAX_MS;
    this.emitState();
  }

  endMatch() {
    this.phase = 'match_over';
    this.emitEvent({ type: 'match_over' });
    this.emitState();
  }

  rematch() {
    // Hard reset back to lobby — keep players, drop everything else.
    this.phase = 'lobby';
    for (const p of this.players) {
      this.matchPoints[p.id] = 0;
      this.scrap[p.id] = 0;
      this.upgrades[p.id] = { engine: 0, tires: 0, armor: 0, fuel: 0 };
      this.inventories[p.id] = {};
    }
    this.cars.clear();
    for (const e of [...this.carEntities.values()])    this.ecs.removeEntity(e);
    for (const e of [...this.pickupEntities.values()]) this.ecs.removeEntity(e);
    for (const e of [...this.hazardEntities.values()]) this.ecs.removeEntity(e);
    this.carEntities.clear();
    this.pickupEntities.clear();
    this.hazardEntities.clear();
    if (this.engine) { Matter.Engine.clear(this.engine); this.engine = null; }
    this.track = null;
    this.raceNumber = 0;
    this.emitState();
  }

  // ------------ Actions ------------
  handleAction(fromId, action) {
    if (!action) return;
    switch (action.name) {
      case 'join':
        this.addPlayer(fromId, action.value || 'Driver');
        break;
      case 'start':
        this.startMatch(fromId);
        break;
      case 'input': {
        // Direct input write — clients send roughly per physics frame.
        const body = this.cars.get(fromId);
        if (body) {
          body.input = {
            up: !!action.up, down: !!action.down,
            left: !!action.left, right: !!action.right,
            brake: !!action.brake, useItem: !!action.useItem,
          };
        }
        break;
      }
      case 'use_item': {
        this.useItem(fromId);
        break;
      }
      case 'buy_upgrade': {
        if (this.phase !== 'shop') return;
        const u = UPGRADES[action.upgradeId];
        if (!u) return;
        const lvl = (this.upgrades[fromId]?.[action.upgradeId] || 0);
        if (lvl >= u.maxLevel) return;
        const cost = u.costAt(lvl);
        if ((this.scrap[fromId] || 0) < cost) return;
        this.scrap[fromId] -= cost;
        this.upgrades[fromId] = { ...(this.upgrades[fromId] || {}) };
        this.upgrades[fromId][action.upgradeId] = lvl + 1;
        this.emitState();
        break;
      }
      case 'shop_ready': {
        if (this.phase !== 'shop') return;
        this.shopReady[fromId] = true;
        const allReady = this.players.every(p => this.shopReady[p.id]);
        if (allReady) scheduleAfter(400, () => this.beginRace());
        this.emitState();
        break;
      }
      case 'rematch': {
        if (fromId !== this.hostId) return;
        this.rematch();
        break;
      }
    }
  }

  useItem(playerId) {
    const inv = this.inventories[playerId] || {};
    const car = this.cars.get(playerId);
    if (!car || this.phase !== 'racing' || !car.alive) return;
    // Pick first available item from a priority order — nitro, repair, then drops.
    const order = ['nitro', 'repair', 'mine', 'oil', 'spikes'];
    let useId = null;
    for (const id of order) {
      if ((inv[id] || 0) > 0) { useId = id; break; }
    }
    if (!useId) return;
    inv[useId] -= 1;
    if (inv[useId] <= 0) delete inv[useId];

    const item = ITEMS[useId];
    if (useId === 'nitro') {
      const dur = (item.duration || 2) * (computeStats(this.upgrades[playerId] || {}).nitroMul);
      car.boost = Math.max(car.boost, dur);
    } else if (useId === 'repair') {
      car.health = car.armor;
    } else if (useId === 'mine' || useId === 'oil' || useId === 'spikes') {
      // Drop ~1 car-length behind the rear bumper.
      const a = car.angle;
      const fx = Math.cos(a), fy = Math.sin(a);
      const id = ++this.hazardSeq;
      const x = car.position.x - fx * (CAR_LENGTH * 1.2);
      const y = car.position.y - fy * (CAR_LENGTH * 1.2);
      const ttl = useId === 'oil' ? OIL_TTL_S : MINE_TTL_S;
      const ent = makeHazardEntity({ id, kind: useId, ownerId: playerId, x, y, ttl });
      this.ecs.addEntity(ent);
      this.hazardEntities.set(id, ent);
      this.emitEvent({ type: 'hazard_drop', hazard: { id, kind: useId, ownerId: playerId, x, y, ttl } });
    }
    this.emitEvent({ type: 'item_used', playerId, itemId: useId });
    this.emitState();
  }

  // ------------ Fixed-step tick ------------
  tick(dt) {
    if (this.phase === 'lobby' || this.phase === 'shop' || this.phase === 'match_over' || !this.engine) {
      this.maybeBroadcastState();
      return;
    }

    // Countdown transition
    if (this.phase === 'countdown') {
      if (Date.now() >= this.countdownEndsTs) {
        this.phase = 'racing';
        this.emitEvent({ type: 'race_go' });
        this.emitState();
      } else {
        // No physics during countdown — emit state at the normal rate
        this.maybeBroadcastState();
        return;
      }
    }

    // Step in fixed slices for determinism
    this._accum += dt;
    const maxSteps = 6;
    let steps = 0;
    while (this._accum >= FIXED_DT && steps < maxSteps) {
      this._accum -= FIXED_DT;
      this.fixedStep(FIXED_DT);
      steps++;
    }
    if (steps === maxSteps) this._accum = 0;

    // Finish/finished phase transition
    if (this.phase === 'racing') {
      const anyRacing = this.players.some(p => !(getLapData(this.carEntities.get(p.id))?.finishedAtMs));
      const allDone = !anyRacing;
      const timerUp = this.firstFinishTs && Date.now() - this.firstFinishTs > RACE_TIME_AFTER_FIRST_FINISH;
      if (allDone || timerUp) {
        this.endRace();
      }
    }

    this.maybeBroadcastState();
  }

  fixedStep(dt) {
    // 1a. Update each car's `surface` from the underlying meta-cell so
    // stepCar uses the right grip / top-speed multiplier this step.
    eachCar(this.ecs, (e) => {
      const body = getRigidBody(e);
      if (body) body.surface = this._surfaceAtWorld(body.position.x, body.position.y);
    });

    // 1b. Step each car's controller (input → forces, lateral friction)
    eachCar(this.ecs, (e) => stepCar(getRigidBody(e), dt));

    // 2. Run Matter physics step
    Matter.Engine.update(this.engine, dt * 1000);

    // 2.5. CSG track containment — push cars back into the road and emit
    // grind/bump effects. Thresholds are all in m/s.
    eachCar(this.ecs, (e) => {
      const body = getRigidBody(e);
      const hit = clampToTrack(body, this.track);
      if (!hit) return;
      const now = Date.now();
      const lastGrind = body._lastGrindMs || 0;
      if (hit.speedSec > 4 && now - lastGrind > 80) {
        body._lastGrindMs = now;
        this.emitEvent({
          type: 'grind',
          playerId: body.ownerId,
          x: hit.contactX, y: hit.contactY,
          intensity: Math.min(1, hit.speedSec / 22),
        });
      }
      // Damage scales with speed; only fires on hard wall contacts.
      if (hit.speedSec > 16 && hit.overhang > 0.3) {
        const lastBump = body._lastBumpMs || 0;
        if (now - lastBump > 250) {
          body._lastBumpMs = now;
          const dmg = Math.min(30, (hit.speedSec - 10) * 0.7);
          dealDamage(body, dmg);
          this.emitEvent({
            type: 'bump',
            playerId: body.ownerId,
            x: hit.contactX, y: hit.contactY,
            intensity: Math.min(1, hit.speedSec / 26),
          });
        }
      }
    });

    // 3. Pickups
    const now = Date.now();
    eachPickup(this.ecs, (e) => {
      const p = getPickupData(e);
      if (!p) return;
      if (p.taken) {
        if (now >= p.respawnAtMs) {
          const rng = mulberry32((this.track.seed ^ p.slotIndex ^ (this.raceNumber * 7919)) >>> 0);
          rng(); rng(); rng();
          p.kind = rollPickupKind(rng);
          p.taken = false;
        }
        return;
      }
      eachCar(this.ecs, (carEnt) => {
        const car = getRigidBody(carEnt);
        if (!car?.alive || p.taken) return;
        const dx = car.position.x - p.x;
        const dy = car.position.y - p.y;
        const r = PICKUP_R + CAR_LENGTH * 0.5;     // car-front to slot centre
        if (dx * dx + dy * dy < r * r) {
          this.grantPickup(car.ownerId, p.kind);
          p.taken = true;
          p.respawnAtMs = now + PICKUP_RESPAWN_MS;
          this.emitEvent({ type: 'pickup_taken', playerId: car.ownerId, slotIndex: p.slotIndex, kind: p.kind });
        }
      });
    });

    // 4. Hazards
    const expiredHazards = [];
    eachHazard(this.ecs, (e) => {
      const h = getHazardData(e);
      if (!h) return;
      h.ttl -= dt;
      if (h.ttl <= 0) { expiredHazards.push({ e, id: h.id }); return; }
      const radius = h.kind === 'oil' ? OIL_R : MINE_R;
      let consumed = false;
      eachCar(this.ecs, (carEnt) => {
        if (consumed) return;
        const car = getRigidBody(carEnt);
        if (!car?.alive) return;
        if (car.ownerId === h.ownerId && h.ttl > (h.kind === 'oil' ? OIL_TTL_S : MINE_TTL_S) - 0.7) return;
        const dx = car.position.x - h.x;
        const dy = car.position.y - h.y;
        const r = radius + CAR_WIDTH * 0.6;
        if (dx * dx + dy * dy < r * r) {
          this.triggerHazard(car, h);
          if (h.kind !== 'oil') {
            expiredHazards.push({ e, id: h.id });
            consumed = true;
          }
        }
      });
    });
    for (const { e, id } of expiredHazards) {
      this.ecs.removeEntity(e);
      this.hazardEntities.delete(id);
      this.emitEvent({ type: 'hazard_expired', id });
    }

    // 5. Lap detection
    eachCar(this.ecs, (e) => {
      const car = getRigidBody(e);
      const ls = getLapData(e);
      const drv = getDriver(e);
      if (!car || !ls || !drv) return;
      if (ls.finishedAtMs) return;
      const cp = this.track.checkpoints[ls.nextCheckpoint];
      if (!cp) return;
      const prev = car._prevPos || { x: car.position.x, y: car.position.y };
      car._prevPos = { x: car.position.x, y: car.position.y };
      if (segmentsIntersect(prev.x, prev.y, car.position.x, car.position.y, cp.ax, cp.ay, cp.bx, cp.by)) {
        ls.nextCheckpoint = (ls.nextCheckpoint + 1) % this.track.checkpoints.length;
        if (ls.nextCheckpoint === 1) {
          ls.lap += 1;
          this.emitEvent({ type: 'lap', playerId: drv.id, lap: ls.lap });
          if (ls.lap >= this.totalLaps) {
            ls.finishedAtMs = Date.now();
            if (!this.raceWinnerId) {
              this.raceWinnerId = drv.id;
              this.firstFinishTs = Date.now();
              this.emitEvent({ type: 'race_winner', playerId: drv.id });
            } else {
              this.emitEvent({ type: 'race_finished', playerId: drv.id });
            }
          }
        } else {
          this.emitEvent({ type: 'checkpoint', playerId: drv.id, index: ls.nextCheckpoint });
        }
      }
    });
  }

  grantPickup(playerId, kind) {
    const item = ITEMS[kind];
    if (!item) return;
    if (item.kind === 'resource') {
      this.scrap[playerId] = (this.scrap[playerId] || 0) + 3;
    } else {
      this.inventories[playerId] = this.inventories[playerId] || {};
      this.inventories[playerId][kind] = (this.inventories[playerId][kind] || 0) + 1;
    }
  }

  triggerHazard(car, h) {
    if (h.kind === 'mine') {
      const exploded = dealDamage(car, 60);
      // Knock the car sideways — give it a velocity kick away from the blast.
      const ax = car.position.x - h.x;
      const ay = car.position.y - h.y;
      const al = Math.hypot(ax, ay) || 1;
      const kick = 8;        // m/s impulse
      Matter.Body.setVelocity(car, {
        x: car.velocity.x + (ax / al) * kick * FIXED_DT,
        y: car.velocity.y + (ay / al) * kick * FIXED_DT,
      });
      this.emitEvent({ type: 'mine_hit', playerId: car.ownerId, x: h.x, y: h.y, exploded });
      if (exploded) this.maybeRespawn(car);
    } else if (h.kind === 'spikes') {
      Matter.Body.setVelocity(car, { x: car.velocity.x * 0.3, y: car.velocity.y * 0.3 });
      const exploded = dealDamage(car, 25);
      this.emitEvent({ type: 'spikes_hit', playerId: car.ownerId, x: h.x, y: h.y, exploded });
      if (exploded) this.maybeRespawn(car);
    } else if (h.kind === 'oil') {
      car.oiled = Math.max(car.oiled, 1.5);
    }
  }

  maybeRespawn(car) {
    // Respawn at the start/finish line — beginning of the current lap.
    if (!this.track) return;
    const start = this.track.checkpoints[0];
    const next  = this.track.checkpoints[1];
    if (!start || !next) return;
    const ang = Math.atan2(next.cy - start.cy, next.cx - start.cx);
    scheduleAfter(2200, () => {
      if (!this.cars.has(car.ownerId)) return;
      respawnCar(car, start.cx, start.cy, ang);
      this.emitEvent({ type: 'respawn', playerId: car.ownerId, x: start.cx, y: start.cy });
    });
  }

  // ------------ Snapshot + broadcast ------------
  snapshot({ includeTrack = false } = {}) {
    return {
      hostId: this.hostId,
      players: this.players,
      matchPoints: this.matchPoints,
      scrap: this.scrap,
      upgrades: this.upgrades,
      inventories: this.inventories,
      shopReady: this.shopReady,
      phase: this.phase,
      raceNumber: this.raceNumber,
      totalLaps: this.totalLaps,
      countdownEndsTs: this.countdownEndsTs,
      shopEndsTs: this.shopEndsTs,
      raceWinnerId: this.raceWinnerId,
      // Track is a few KB serialized; only include it when the receiver needs
      // it (first send after a new race, or a fresh joiner). For all other
      // snapshots we just send the seed so the client can confirm it's still
      // looking at the same track.
      // The renderer reconstructs its own continuous road ring from
      // centerline + widths, so we don't ship the physics-side tiles[].
      track: this.track ? (includeTrack ? {
        seed: this.track.seed,
        centerline: this.track.centerline,
        widths: this.track.widths,
        start: this.track.start,
        checkpoints: this.track.checkpoints,
        pickupSlots: this.track.pickupSlots,
        bounds: this.track.bounds,
      } : { seed: this.track.seed }) : null,
      cars: this._snapshotCars(),
      pickups: this._snapshotPickups(),
      hazards: this._snapshotHazards(),
    };
  }

  _snapshotCars() {
    const out = [];
    eachCar(this.ecs, (e) => {
      const b = getRigidBody(e);
      const drv = getDriver(e);
      const ls = getLapData(e);
      if (!b || !drv) return;
      out.push({
        id: drv.id,
        ...carSnapshot(b),
        lap: ls?.lap || 0,
        nextCheckpoint: ls?.nextCheckpoint || 0,
        finishedAtMs: ls?.finishedAtMs || 0,
      });
    });
    return out;
  }
  _snapshotPickups() {
    const out = [];
    eachPickup(this.ecs, (e) => {
      const p = getPickupData(e);
      if (!p) return;
      out.push({ slotIndex: p.slotIndex, kind: p.kind, x: p.x, y: p.y, taken: p.taken });
    });
    return out;
  }
  _snapshotHazards() {
    const out = [];
    eachHazard(this.ecs, (e) => {
      const h = getHazardData(e);
      if (!h) return;
      out.push({ id: h.id, kind: h.kind, ownerId: h.ownerId, x: h.x, y: h.y, ttl: h.ttl });
    });
    return out;
  }

  emitState() {
    const seed = this.track?.seed ?? null;
    const includeTrack = seed !== this._lastBroadcastTrackSeed;
    this._lastBroadcastTrackSeed = seed;
    this.onState?.(this.snapshot({ includeTrack }));
  }
  emitEvent(ev) {
    this.onEvent?.(ev);
  }

  maybeBroadcastState() {
    const now = performance.now();
    if (now - this._lastStateBroadcastTs >= this._stateIntervalMs) {
      this._lastStateBroadcastTs = now;
      this.emitState();
    }
  }
}

// ---- math helpers ----
function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1x = bx - ax, d1y = by - ay;
  const d2x = dx - cx, d2y = dy - cy;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return false;
  const sx = ax - cx, sy = ay - cy;
  const t = (sx * d2y - sy * d2x) / denom;
  const u = (sx * d1y - sy * d1x) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}
