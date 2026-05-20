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
        friction: 0.8,
        restitution: 0.2,
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
    friction: 0.05,
    // Low restitution so walls don't kick the car back hard — instead it
    // slides along the wall and we spawn sparks.
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

// Apply input to a car body for one fixed step.
//
// Critical unit-conversion: Matter.Body's velocity is in pixels-per-STEP (one
// 16.66ms physics step). Our stats.maxSpeed / stats.accel are in pixels-per-
// SECOND for ease of tuning. We pull body.velocity in, scale to per-sec at
// the top, do all the math in per-sec, then scale back to per-step before
// calling setVelocity. Wall-collision response in Matter modifies the
// per-step velocity, which the next stepCar call picks up cleanly because we
// always re-read at the top.
export function stepCar(body, dt) {
  if (!body.alive) {
    body.respawnIn = Math.max(0, body.respawnIn - dt);
    return;
  }
  const { stats, input } = body;
  const a = body.angle;
  const fx = Math.cos(a);
  const fy = Math.sin(a);
  const nx = -fy;       // body-left normal
  const ny =  fx;

  // Convert Matter's per-step velocity into per-second axis-aligned speeds.
  const vxSec = body.velocity.x / dt;
  const vySec = body.velocity.y / dt;
  let fwdSpeed = vxSec * fx + vySec * fy;
  let latSpeed = vxSec * nx + vySec * ny;

  const oiledMul = body.oiled > 0 ? 0.4 : 1.0;
  const boostMul = body.boost > 0 ? stats.nitroBoost : 1.0;
  const maxSpeed = stats.maxSpeed * boostMul;

  // ---- Throttle / brake / reverse.
  if (input.up && !input.down) {
    fwdSpeed += stats.accel * oiledMul * dt;
    if (fwdSpeed > maxSpeed) fwdSpeed = maxSpeed;
  } else if (input.down && !input.up) {
    fwdSpeed -= stats.brake * 0.6 * oiledMul * dt;
    if (fwdSpeed < -stats.reverse) fwdSpeed = -stats.reverse;
  } else {
    // Engine braking when off-throttle.
    fwdSpeed *= Math.pow(0.985, dt * 60);
  }
  if (input.brake) {
    fwdSpeed *= Math.pow(0.88, dt * 60);
  }

  // ---- Lateral grip.
  let grip = stats.grip;
  if (input.brake) grip *= 0.35;
  if (body.oiled > 0) grip *= 0.4;
  const latDecay = Math.min(1, grip * dt * 12);
  latSpeed *= (1 - latDecay);

  // Convert back to per-step before handing to Matter.
  Matter.Body.setVelocity(body, {
    x: (fwdSpeed * fx + latSpeed * nx) * dt,
    y: (fwdSpeed * fy + latSpeed * ny) * dt,
  });

  // Steering. Authority scales with √speed so cars don't spin in place.
  const speedNorm = Math.min(1, Math.abs(fwdSpeed) / stats.maxSpeed);
  const steerAuthority = 0.25 + 0.75 * Math.sqrt(speedNorm);
  let steer = (input.left ? -1 : 0) + (input.right ? 1 : 0);
  if (fwdSpeed < -10) steer *= -1;
  Matter.Body.setAngularVelocity(body, steer * stats.turnSpeed * steerAuthority * oiledMul * dt);

  // Cache for snapshots/UI.
  body._fwdSpeed = fwdSpeed;
  body._latSpeed = latSpeed;

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
