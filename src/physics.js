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
    frictionAir: 0.06,
    friction: 0.05,
    restitution: 0.25,
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
  return body;
}

export function refreshCarStats(carBody, upgrades) {
  const stats = computeStats(upgrades);
  carBody.stats = stats;
  carBody.armor = stats.armor;
  carBody.health = stats.armor;
}

// Apply input to a car body for one fixed step. Body's "facing" direction is
// the +Y axis in its local frame (Matter rotates -Y by default at angle 0, but
// we treat angle 0 = facing +X for clarity with track tangent vectors).
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

  // Forward speed (signed projection onto facing)
  const vx = body.velocity.x;
  const vy = body.velocity.y;
  const fwdSpeed = vx * fx + vy * fy;
  const latSpeed = vx * nx + vy * ny;

  // ---- Thrust / brake / reverse
  const oiledMul = body.oiled > 0 ? 0.4 : 1.0;
  const boostMul = body.boost > 0 ? stats.nitroBoost : 1.0;
  const maxSpeed = stats.maxSpeed * boostMul;

  let accel = 0;
  if (input.up && !input.down) {
    // Engine push, capped at maxSpeed forward
    if (fwdSpeed < maxSpeed) accel += stats.accel * oiledMul;
  }
  if (input.down && !input.up) {
    if (fwdSpeed > -stats.reverse) accel -= stats.brake * 0.6 * oiledMul;
  }
  if (input.brake) {
    // Hand-brake: dampen forward speed strongly and reduce lateral friction so
    // we drift.
    accel -= Math.sign(fwdSpeed) * stats.brake * 0.6;
  }
  // Apply thrust along facing
  if (accel !== 0) {
    Matter.Body.applyForce(body, body.position, { x: fx * accel * body.mass * dt, y: fy * accel * body.mass * dt });
  }

  // ---- Steering: turn rate scales with sqrt(|fwdSpeed|/maxSpeed) so we can't
  // pivot in place but we still turn well at low speed.
  const speedNorm = Math.min(1, Math.abs(fwdSpeed) / stats.maxSpeed);
  const steerAuthority = 0.25 + 0.75 * Math.sqrt(speedNorm);
  let steer = 0;
  if (input.left)  steer -= 1;
  if (input.right) steer += 1;
  // Reverse-steer inversion: when reversing the steering should still feel like
  // turning the wheel, not flipping it.
  if (fwdSpeed < -10) steer *= -1;
  const turnRate = steer * stats.turnSpeed * steerAuthority * oiledMul;
  Matter.Body.setAngularVelocity(body, turnRate * dt + body.angularVelocity * 0.6);

  // ---- Lateral friction (the magic that keeps the car from sliding sideways).
  // Drift mode (handbrake) reduces grip; oil also reduces grip.
  let grip = stats.grip;
  if (input.brake) grip *= 0.35;
  if (body.oiled > 0) grip *= 0.4;
  const killLat = Math.min(1, grip);
  // New velocity = forward component preserved + (lateral component scaled down)
  const newVx = (fwdSpeed) * fx + (latSpeed * (1 - killLat)) * nx;
  const newVy = (fwdSpeed) * fy + (latSpeed * (1 - killLat)) * ny;
  Matter.Body.setVelocity(body, { x: newVx, y: newVy });

  // ---- Drain boost / oil timers
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

export function carSnapshot(body) {
  return {
    id: body.ownerId,
    x: body.position.x,
    y: body.position.y,
    a: body.angle,
    vx: body.velocity.x,
    vy: body.velocity.y,
    w: body.angularVelocity,
    boost: body.boost,
    oiled: body.oiled,
    health: body.health,
    armor: body.armor,
    alive: body.alive,
    respawnIn: body.respawnIn,
  };
}

export function applyCarSnapshot(body, snap) {
  Matter.Body.setPosition(body, { x: snap.x, y: snap.y });
  Matter.Body.setAngle(body, snap.a);
  Matter.Body.setVelocity(body, { x: snap.vx, y: snap.vy });
  Matter.Body.setAngularVelocity(body, snap.w);
  body.boost = snap.boost;
  body.oiled = snap.oiled;
  body.health = snap.health;
  body.armor = snap.armor;
  body.alive = snap.alive;
  body.respawnIn = snap.respawnIn;
}
