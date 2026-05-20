// Matter.js wrapper. The world contains:
//   - track walls (static compound from inner + outer offset polylines)
//   - one rigid-body car per driver (rectangle, dynamic)
//   - hazards: mines (static sensors), oil slicks (static sensors), spike strips
//
// We run a fixed 60 Hz step. The host owns the authoritative engine; clients
// each maintain a separate local engine for visual prediction of their own car.
//
// Cars are arcade-style: forward thrust along the body's facing direction, hard
// lateral friction (so the car doesn't drift forever), input-driven steering
// applied as angular velocity scaled by current forward speed. No suspension.

import Matter from 'matter-js';
import { computeStats } from './upgrades.js';

export const FIXED_DT = 1 / 60;
export const CAR_WIDTH = 32;
export const CAR_LENGTH = 56;
export const PICKUP_R = 22;
export const MINE_R = 18;
export const OIL_R = 60;

// ---------- World ----------

export function createWorld() {
  const engine = Matter.Engine.create({
    gravity: { x: 0, y: 0, scale: 0 },
    enableSleeping: false,
  });
  engine.constraintIterations = 4;
  engine.positionIterations = 8;
  engine.velocityIterations = 8;
  return engine;
}

export function buildTrackBodies(world, track) {
  const bodies = [];
  // Inner wall as a closed loop of small segments. Each segment is a thin
  // rectangle rotated to match the edge.
  const wallThickness = 14;
  const addWallLoop = (loop) => {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const seg = Matter.Bodies.rectangle(mx, my, len + 2, wallThickness, {
        isStatic: true,
        angle,
        // Frictionless walls — cars slide along them instead of catching.
        friction: 0,
        frictionStatic: 0,
        restitution: 0.05,
        label: 'wall',
        slop: 0.02,
      });
      bodies.push(seg);
    }
  };
  addWallLoop(track.inner);
  addWallLoop(track.outer);
  Matter.Composite.add(world, bodies);
  return bodies;
}

// ---------- Cars ----------

export function createCarBody(x, y, angle, ownerId, stats) {
  const body = Matter.Bodies.rectangle(x, y, CAR_WIDTH, CAR_LENGTH, {
    angle,
    density: 0.002,
    frictionAir: 0,
    // Frictionless contacts so the car glides along walls (we still get the
    // collision response — just no sticky friction killing forward motion).
    friction: 0,
    frictionStatic: 0,
    restitution: 0.05,
    label: 'car',
    chamfer: { radius: 6 },
  });
  body.ownerId = ownerId;
  body.stats = stats;
  body.input = { up: 0, down: 0, left: 0, right: 0, brake: 0, useItem: 0 };
  body.boost = 0;        // seconds remaining on nitro
  body.oiled = 0;        // seconds of reduced grip after an oil slick
  body.armor = stats.armor;
  body.health = stats.armor;
  body.alive = true;
  body.respawnIn = 0;
  // Our per-second velocity decomposition. We translate between this and
  // Matter's per-step velocity at the start/end of each stepCar call.
  body._fwdSpeed = 0;
  body._latSpeed = 0;
  return body;
}

export function refreshCarStats(carBody, upgrades) {
  const stats = computeStats(upgrades);
  carBody.stats = stats;
  carBody.armor = stats.armor;
  carBody.health = stats.armor;
}

// Drift-oriented arcade car model. Key ideas borrowed from top-down racers:
//
//  * Slip angle (lateral velocity as a fraction of total speed) drives a
//    "drift" coefficient 0..1. The further the car is from pointing where
//    it's moving, the more committed the drift is.
//  * Grip is a *function* of drift, not a constant: high grip when slip is
//    low (car snaps back to straight), much lower grip when slip is high
//    (drifts maintain themselves — positive-feedback "sticky" drift).
//  * Steering authority scales UP during a drift so counter-steering feels
//    powerful — you can fishtail and recover.
//  * Power oversteer: full throttle near top speed eats a bit of grip, so
//    flooring it through a corner kicks the rear out.
//  * Handbrake (Space) collapses grip — instant break-into-drift.
//  * Throttle pushes along the car's facing direction (NOT the velocity
//    direction), so while drifting the engine carries you sideways. This is
//    what makes drift in arcade racers feel right.
//
// Matter.js handles wall collisions on top of all of this. setVelocity uses
// per-step units; our stats are per-second, so we convert at the boundary.

function smoothstep01(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function stepCar(body, dt) {
  if (!body.alive) {
    body.respawnIn = Math.max(0, body.respawnIn - dt);
    return;
  }
  const { stats, input } = body;
  const a = body.angle;
  const fx = Math.cos(a);
  const fy = Math.sin(a);
  const nx = -fy;
  const ny =  fx;

  const vxSec = body.velocity.x / dt;
  const vySec = body.velocity.y / dt;
  const totalSpeed = Math.hypot(vxSec, vySec);
  let fwdSpeed = vxSec * fx + vySec * fy;
  let latSpeed = vxSec * nx + vySec * ny;

  const oiledMul = body.oiled > 0 ? 0.45 : 1.0;
  const boostMul = body.boost > 0 ? stats.nitroBoost : 1.0;
  const maxSpeed = stats.maxSpeed * boostMul;

  // Slip-angle ratio: 0 = perfectly aligned, 1 = pure sideways slide. Below
  // ~0.15 the car snaps straight; above ~0.55 it's a committed drift.
  const slipFrac = totalSpeed > 30 ? Math.abs(latSpeed) / totalSpeed : 0;
  const drift = smoothstep01(0.15, 0.55, slipFrac);

  // Throttle / brake — applied along facing.
  if (input.up && !input.down) {
    fwdSpeed += stats.accel * oiledMul * dt;
    if (fwdSpeed > maxSpeed) fwdSpeed = maxSpeed;
  } else if (input.down && !input.up) {
    fwdSpeed -= stats.brake * 0.55 * oiledMul * dt;
    if (fwdSpeed < -stats.reverse) fwdSpeed = -stats.reverse;
  } else {
    fwdSpeed *= Math.pow(0.99, dt * 60);     // gentler off-throttle decay
  }

  // ---- Grip (lateral friction) — the heart of the drift feel.
  // Base grip is reduced as drift builds (positive feedback), and crushed
  // by handbrake / oil. Power-oversteer near top speed.
  let grip = stats.grip * (1.0 - drift * 0.65);
  if (input.brake) grip *= 0.18;
  if (body.oiled > 0) grip *= 0.35;
  if (input.up && fwdSpeed > 0.75 * maxSpeed) grip *= 0.78;

  // Lateral velocity decay — exponential per-step, scaled to dt.
  const latDecay = Math.min(1, grip * dt * 14);
  latSpeed *= (1 - latDecay);

  // Hand back to Matter (per-step units).
  Matter.Body.setVelocity(body, {
    x: (fwdSpeed * fx + latSpeed * nx) * dt,
    y: (fwdSpeed * fy + latSpeed * ny) * dt,
  });

  // ---- Steering. Authority scales with √speed and gets a meaningful boost
  // while drifting so counter-steer feels responsive (fishtail recovery).
  const speedNorm = Math.min(1, totalSpeed / stats.maxSpeed);
  const baseAuthority = 0.30 + 0.70 * Math.sqrt(speedNorm);
  const driftBonus = 1.0 + drift * 0.55;
  let steer = (input.left ? -1 : 0) + (input.right ? 1 : 0);
  if (fwdSpeed < -10) steer *= -1;
  const angVel = steer * stats.turnSpeed * baseAuthority * driftBonus * oiledMul;
  Matter.Body.setAngularVelocity(body, angVel * dt);

  body._fwdSpeed = fwdSpeed;
  body._latSpeed = latSpeed;
  body._drift = drift;

  if (body.boost > 0) body.boost = Math.max(0, body.boost - dt);
  if (body.oiled > 0) body.oiled = Math.max(0, body.oiled - dt);
}

// ---------- Damage / explode ----------

export function dealDamage(body, amount) {
  if (!body.alive) return false;
  body.health -= amount;
  if (body.health <= 0) {
    body.alive = false;
    body.respawnIn = 2.5;
    return true;
  }
  return false;
}

export function respawnCar(body, x, y, angle) {
  Matter.Body.setPosition(body, { x, y });
  Matter.Body.setAngle(body, angle);
  Matter.Body.setVelocity(body, { x: 0, y: 0 });
  Matter.Body.setAngularVelocity(body, 0);
  body.alive = true;
  body.health = body.stats.armor;
  body.armor = body.stats.armor;
  body.boost = 0;
  body.oiled = 0;
}

// ---------- Snapshot helpers ----------
//
// Snapshots carry velocity in per-SECOND units (sane engineering units that
// clients can integrate with normal dt). The host's Matter body stores
// velocity in per-STEP units, so we scale at this boundary.

export function carSnapshot(body) {
  const stepRate = 1 / FIXED_DT;   // 60 if FIXED_DT = 1/60
  return {
    id: body.ownerId,
    x: body.position.x,
    y: body.position.y,
    a: body.angle,
    vx: body.velocity.x * stepRate,
    vy: body.velocity.y * stepRate,
    w: body.angularVelocity * stepRate,
    boost: body.boost,
    oiled: body.oiled,
    health: body.health,
    armor: body.armor,
    alive: body.alive,
    respawnIn: body.respawnIn,
  };
}

export function applyCarSnapshot(body, snap) {
  const stepRate = 1 / FIXED_DT;
  Matter.Body.setPosition(body, { x: snap.x, y: snap.y });
  Matter.Body.setAngle(body, snap.a);
  Matter.Body.setVelocity(body, { x: snap.vx / stepRate, y: snap.vy / stepRate });
  Matter.Body.setAngularVelocity(body, snap.w / stepRate);
  body.boost = snap.boost;
  body.oiled = snap.oiled;
  body.health = snap.health;
  body.armor = snap.armor;
  body.alive = snap.alive;
  body.respawnIn = snap.respawnIn;
}
