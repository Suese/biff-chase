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

// ---- World units are METRES, period. No more pixel-scale fudge factors.
// A car is 4.5 m × 1.8 m, a stock top speed is ~33 m/s (120 km/h), the
// procedurally generated track is roughly 75 m in radius with a ~12 m wide
// surface. Three.js world space, Matter.js bodies, and everything that
// gets serialized over the wire is the same scale.

export const FIXED_DT  = 1 / 60;
export const CAR_LENGTH = 4.5;
export const CAR_WIDTH  = 1.8;
export const PICKUP_R   = 1.6;    // how close you have to be to grab a pickup
export const MINE_R     = 1.4;
export const OIL_R      = 5.0;

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

// Build Matter static bodies for the track's wall segments. Two kinds:
//   axial — { kind: 'axial', x, y, len, axis: 'x'|'y' } (4 m axis-aligned)
//   diag  — { kind: 'diag',  ax, ay, bx, by }          (45° chamfer)
export function buildWallBodies(world, wallSegments) {
  const bodies = [];
  const thickness = 0.35;
  for (const w of wallSegments) {
    if (w.kind === 'diag') {
      const dx = w.bx - w.ax;
      const dy = w.by - w.ay;
      const len = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const body = Matter.Bodies.rectangle(
        (w.ax + w.bx) / 2,
        (w.ay + w.by) / 2,
        len, thickness, {
          isStatic: true, angle,
          friction: 0, frictionStatic: 0, restitution: 0.1,
          label: 'wall', slop: 0.005,
        },
      );
      bodies.push(body);
    } else {
      let bw, bh;
      if (w.axis === 'x') { bw = w.len; bh = thickness; }
      else                { bw = thickness; bh = w.len; }
      const body = Matter.Bodies.rectangle(w.x, w.y, bw, bh, {
        isStatic: true,
        friction: 0,
        frictionStatic: 0,
        restitution: 0.1,
        label: 'wall',
        slop: 0.005,
      });
      bodies.push(body);
    }
  }
  Matter.Composite.add(world, bodies);
  return bodies;
}

// ---- Per-surface physics modifiers --------------------------------------
//
// The car's body carries a `surface` field written by game.js each step
// from the underlying meta-cell's biome. Each surface modifies grip and
// top-speed, and tells the renderer how to colour skid marks.

export const SURFACE_PAVEMENT = 'pavement';
export const SURFACE_GRAVEL   = 'gravel';
export const SURFACE_ICE      = 'ice';
export const SURFACE_LAND     = 'land';      // off-road grass
export const SURFACE_FOREST   = 'forest';    // off-road forest floor

export function surfaceModifiers(surface) {
  switch (surface) {
    case SURFACE_GRAVEL: return { gripMul: 0.65, speedMul: 0.90, skidColor: 0xc6a06a, skidOpacity: 0.45 };
    case SURFACE_ICE:    return { gripMul: 0.25, speedMul: 0.95, skidColor: 0xd4f0ff, skidOpacity: 0.55 };
    case SURFACE_LAND:   return { gripMul: 0.55, speedMul: 0.55, skidColor: 0x4a5a2c, skidOpacity: 0.40 };
    case SURFACE_FOREST: return { gripMul: 0.45, speedMul: 0.40, skidColor: 0x3a2614, skidOpacity: 0.40 };
    default:             return { gripMul: 1.00, speedMul: 1.00, skidColor: 0x080808, skidOpacity: 0.55 };
  }
}

// ---------- Cars ----------

export function createCarBody(x, y, angle, ownerId, stats) {
  // Matter.Bodies.rectangle(x, y, w, h): w along local X, h along local Y.
  // At body.angle = 0 the chassis mesh runs LENGTH along world X (it's a
  // BoxGeometry(4.5, ..., 1.8) — 4.5 long), so the body's X dimension is
  // CAR_LENGTH and its Y dimension is CAR_WIDTH. The previous order was
  // swapped, which made the collision box rotated 90° from the mesh.
  const body = Matter.Bodies.rectangle(x, y, CAR_LENGTH, CAR_WIDTH, {
    angle,
    density: 0.4,
    frictionAir: 0,
    friction: 0,
    frictionStatic: 0,
    restitution: 0.05,
    label: 'car',
    chamfer: { radius: 0.25 },
    slop: 0.005,
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
  // Surface modifier — multiplies grip and top speed.
  const surfMod = surfaceModifiers(body.surface || SURFACE_PAVEMENT);
  const maxSpeed = stats.maxSpeed * boostMul * surfMod.speedMul;

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

  // ---- Bicycle-model RWD grip. Treat the car as two axles separated by a
  // wheelbase; the lateral velocity at each axle is decayed by that axle's
  // grip. Front grip is higher (steering bite) while rear grip is lower
  // and falls off fast under throttle / handbrake / drift — classic
  // rear-wheel-drive oversteer. The yaw moment that emerges from front-
  // vs-rear slip mismatch is added back into the chassis angular velocity.
  const halfWB = 1.4;       // half-wheelbase in metres (≈ 2.8m total)
  const omegaSec = body.angularVelocity / dt;
  const latFront = latSpeed + omegaSec * halfWB;
  const latRear  = latSpeed - omegaSec * halfWB;

  let gripF = stats.grip * 1.30 * surfMod.gripMul * (1.0 - drift * 0.25);
  let gripR = stats.grip * 0.75 * surfMod.gripMul * (1.0 - drift * 0.65);
  if (input.brake) gripR *= 0.18;                                 // handbrake
  if (input.up && fwdSpeed > 0.5 * maxSpeed) gripR *= 0.70;       // power oversteer
  if (body.oiled > 0) { gripF *= 0.40; gripR *= 0.40; }

  const decayF = Math.min(1, gripF * dt * 14);
  const decayR = Math.min(1, gripR * dt * 14);
  const newLatF = latFront * (1 - decayF);
  const newLatR = latRear  * (1 - decayR);

  const newLatSpeed = (newLatF + newLatR) * 0.5;
  const omegaFromAxles = (newLatF - newLatR) / (2 * halfWB);

  // Hand back to Matter — lateral velocity recomposed with forward speed.
  Matter.Body.setVelocity(body, {
    x: (fwdSpeed * fx + newLatSpeed * nx) * dt,
    y: (fwdSpeed * fy + newLatSpeed * ny) * dt,
  });

  // ---- Steering. A stationary car can't pivot (ω = v / R), and we blend
  // a fraction of the bicycle-model yaw on top so the rear slide actually
  // rotates the body during a drift.
  const minTurnRadius = 5;
  const omegaFromSpeed = Math.abs(fwdSpeed) / minTurnRadius;
  const omegaCap = Math.min(stats.turnSpeed, omegaFromSpeed);
  let steer = (input.left ? -1 : 0) + (input.right ? 1 : 0);
  if (fwdSpeed < -1) steer *= -1;
  const omegaTarget = steer * omegaCap * (1 + drift * 0.45) * oiledMul;
  const newOmega = omegaTarget + omegaFromAxles * 0.45;
  Matter.Body.setAngularVelocity(body, newOmega * dt);

  body._fwdSpeed = fwdSpeed;
  body._latSpeed = newLatSpeed;
  body._drift = drift;

  if (body.boost > 0) body.boost = Math.max(0, body.boost - dt);
  if (body.oiled > 0) body.oiled = Math.max(0, body.oiled - dt);
}

// ---------- Track containment (CSG approach) ----------
//
// The track is the UNION of per-segment trapezoid tiles. Rather than build a
// thousand Matter wall bodies (which break at sharp corners) we constrain
// each car to the union once per fixed step. Find the nearest centerline
// segment, project the car onto it, and if its perpendicular distance
// exceeds the local half-width, push the car back to the boundary and kill
// the outward velocity component. Returns null when no constraint fired, or
// a small descriptor with the contact info for grind/bump effects.

const CAR_HALF = CAR_WIDTH / 2;     // 0.9 m

export function clampToTrack(body, track) {
  if (!body.alive || !track || !track.tiles?.length) return null;
  const cx = body.position.x, cy = body.position.y;

  let bestDistSq = Infinity;
  let bestPx = 0, bestPy = 0, bestWHalf = 0;
  for (const tile of track.tiles) {
    const dx = tile.bx - tile.ax;
    const dy = tile.by - tile.ay;
    const segLen2 = dx*dx + dy*dy || 1;
    let t = ((cx - tile.ax) * dx + (cy - tile.ay) * dy) / segLen2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const px = tile.ax + dx * t;
    const py = tile.ay + dy * t;
    const ddx = cx - px, ddy = cy - py;
    const distSq = ddx*ddx + ddy*ddy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestPx = px;
      bestPy = py;
      bestWHalf = tile.wA * (1 - t) + tile.wB * t;
    }
  }

  const dist = Math.sqrt(bestDistSq);
  const limit = bestWHalf - CAR_HALF;
  if (dist <= limit) return null;       // safely inside the road

  // Off-track. Push back to the boundary along the outward normal.
  const overhang = dist - limit;
  let nx, ny;
  if (dist > 1e-3) { nx = (cx - bestPx) / dist; ny = (cy - bestPy) / dist; }
  else             { nx = 1; ny = 0; }

  Matter.Body.setPosition(body, {
    x: cx - nx * overhang,
    y: cy - ny * overhang,
  });

  // Kill the outward component of velocity, preserving the tangential slide.
  const vx = body.velocity.x, vy = body.velocity.y;
  const vDotN = vx * nx + vy * ny;
  if (vDotN > 0) {
    Matter.Body.setVelocity(body, {
      x: vx - nx * vDotN * 0.95,
      y: vy - ny * vDotN * 0.95,
    });
  }

  // Per-step velocity → per-sec for the caller's intensity scaling.
  const speedSec = Math.hypot(body.velocity.x, body.velocity.y) / FIXED_DT;
  return {
    nx, ny, overhang, speedSec,
    contactX: cx - nx * overhang,
    contactY: cy - ny * overhang,
  };
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
  const stepRate = 1 / FIXED_DT;
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
    drift: body._drift || 0,
    surface: body.surface || 'pavement',
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
