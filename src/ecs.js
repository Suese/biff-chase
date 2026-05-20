// Thin ECS layer on top of ecs-lib. Matter.js owns physics state and is the
// source of truth for positions/velocities; ecs-lib is the canonical registry
// of *logical* entities (car/pickup/hazard) and the components they carry
// (driver identity, lap progress, item slot kind, hazard ttl).
//
// Systems iterate the ECS world; the host's GameRoom calls them each tick.

import ECS, { Entity, Component, System } from 'ecs-lib';

class GameEntity extends Entity {}

// Components — data only.
export const RigidBody = Component.register();   // { body, kind }
export const Driver    = Component.register();   // { id, name }
export const Lap       = Component.register();   // { lap, nextCheckpoint, finishedAtMs }
export const Pickup    = Component.register();   // { slotIndex, kind, x, y, taken, respawnAtMs }
export const Hazard    = Component.register();   // { id, kind, ownerId, x, y, ttl }

export function makeECS() { return new ECS(); }

export function makeCarEntity({ body, driverId, driverName }) {
  const e = new GameEntity();
  e.add(new RigidBody({ body, kind: 'car' }));
  e.add(new Driver({ id: driverId, name: driverName }));
  e.add(new Lap({ lap: 0, nextCheckpoint: 1, finishedAtMs: 0 }));
  return e;
}

export function makePickupEntity({ slotIndex, kind, x, y }) {
  const e = new GameEntity();
  e.add(new Pickup({ slotIndex, kind, x, y, taken: false, respawnAtMs: 0 }));
  return e;
}

export function makeHazardEntity({ id, kind, ownerId, x, y, ttl }) {
  const e = new GameEntity();
  e.add(new Hazard({ id, kind, ownerId, x, y, ttl }));
  return e;
}

// ecs-lib 0.7.0's Iterator is broken: the closure inside ECS.prototype.query
// advances its `index` via the for-loop's update expression, which is SKIPPED
// when the body `return`s a matching entity. So `next()` returns the same
// entity forever, and `each()` only terminates if the callback returns
// strictly `false`. We bypass it entirely by walking the entity array.
export function eachCar(ecs, cb) {
  for (const e of ecs.entities) {
    if (!e.active) continue;
    const rb = RigidBody.oneFrom(e);
    if (rb?.data?.kind === 'car') cb(e);
  }
}
export function eachPickup(ecs, cb) {
  for (const e of ecs.entities) {
    if (!e.active) continue;
    if (Pickup.oneFrom(e)) cb(e);
  }
}
export function eachHazard(ecs, cb) {
  for (const e of ecs.entities) {
    if (!e.active) continue;
    if (Hazard.oneFrom(e)) cb(e);
  }
}

export function getRigidBody(e)  { return RigidBody.oneFrom(e)?.data?.body || null; }
export function getDriver(e)     { return Driver.oneFrom(e)?.data || null; }
export function getLapData(e)    { return Lap.oneFrom(e)?.data || null; }
export function getPickupData(e) { return Pickup.oneFrom(e)?.data || null; }
export function getHazardData(e) { return Hazard.oneFrom(e)?.data || null; }

export { Entity, System };
