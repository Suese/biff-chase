// Terrain — biome generation, checkpoint placement, and A* road pathing.
//
// We work on a 50×50 cell grid (200 m × 200 m world centred on the origin).
// Each cell gets a biome via fractional-Brownian value noise: water, land,
// forest, mountain. The race road is then carved through the map with A*:
// water and mountains are blocked, land costs 1, forest costs 3.

import { mulberry32 } from './rng.js';

export const GRID_SIZE = 50;
export const CELL_SIZE = 4;      // metres per cell
export const WORLD_HALF = (GRID_SIZE * CELL_SIZE) / 2;   // 100 m

export const WATER    = 'water';
export const LAND     = 'land';
export const FOREST   = 'forest';
export const MOUNTAIN = 'mountain';
export const ROAD     = 'road';        // Road is the 5th biome at the meta-grid level.

// ---- Hashing & noise ----------------------------------------------------

function hash2D(x, y, seed) {
  let h = (seed + 1) >>> 0;
  h = Math.imul(h ^ (x | 0), 0x85ebca6b);
  h = Math.imul(h ^ (y | 0), 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return ((h >>> 0) / 0xffffffff);
}

function smoothstep(t) { return t * t * (3 - 2 * t); }

function valueNoise2D(x, y, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const h00 = hash2D(ix, iy, seed);
  const h10 = hash2D(ix + 1, iy, seed);
  const h01 = hash2D(ix, iy + 1, seed);
  const h11 = hash2D(ix + 1, iy + 1, seed);
  const u = smoothstep(fx);
  const v = smoothstep(fy);
  return (h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v;
}

function fbm2D(x, y, seed, octaves = 4) {
  let n = 0, amp = 1, freq = 1, total = 0;
  for (let i = 0; i < octaves; i++) {
    n += amp * valueNoise2D(x * freq, y * freq, seed + i * 137);
    total += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return n / total;
}

// ---- Biome map ----------------------------------------------------------

export function generateBiomeMap(seed) {
  const scale = 0.10;
  // Elevation gives the mountain/water shape; moisture (a separate noise)
  // splits land vs forest within the mid-elevation band.
  const elevation = new Array(GRID_SIZE);
  const moisture  = new Array(GRID_SIZE);
  for (let gy = 0; gy < GRID_SIZE; gy++) {
    elevation[gy] = new Array(GRID_SIZE);
    moisture[gy]  = new Array(GRID_SIZE);
    for (let gx = 0; gx < GRID_SIZE; gx++) {
      let e = fbm2D(gx * scale, gy * scale, seed, 5);
      // A subtle inward bias so the world doesn't drown around the edges.
      const cx = GRID_SIZE / 2, cy = GRID_SIZE / 2;
      const dist = Math.hypot(gx - cx, gy - cy) / (GRID_SIZE * 0.5);
      e = e - dist * 0.12;
      elevation[gy][gx] = e;
      moisture[gy][gx] = fbm2D(gx * scale * 1.7 + 50, gy * scale * 1.7 + 50, seed + 9001, 4);
    }
  }
  const map = new Array(GRID_SIZE);
  for (let gy = 0; gy < GRID_SIZE; gy++) {
    map[gy] = new Array(GRID_SIZE);
    for (let gx = 0; gx < GRID_SIZE; gx++) {
      const e = elevation[gy][gx];
      const m = moisture[gy][gx];
      let biome;
      if (e < 0.30)      biome = WATER;
      else if (e > 0.78) biome = MOUNTAIN;
      else if (m > 0.55) biome = FOREST;
      else               biome = LAND;
      map[gy][gx] = biome;
    }
  }
  return { map, elevation, moisture, gridSize: GRID_SIZE, cellSize: CELL_SIZE };
}

export function biomeCost(biome) {
  if (biome === WATER || biome === MOUNTAIN) return Infinity;
  if (biome === FOREST) return 3;
  return 1;
}

// ---- Coordinate helpers -------------------------------------------------

// World origin sits at the grid centre. cellToWorld returns the centre of
// a cell in world metres.
export function cellToWorld(gx, gy) {
  return {
    x: (gx - GRID_SIZE / 2) * CELL_SIZE + CELL_SIZE / 2,
    y: (gy - GRID_SIZE / 2) * CELL_SIZE + CELL_SIZE / 2,
  };
}

// ---- Checkpoint placement -----------------------------------------------

// Pick N checkpoints distributed in a rough circle, each snapped to the
// nearest traversable (land / forest) cell.
export function pickCheckpoints(biomeMap, rng, count = 6) {
  const { map, gridSize } = biomeMap;
  const checkpoints = [];
  const baseR = gridSize * 0.35;
  const angleJitter = 0.25;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + (rng() - 0.5) * angleJitter;
    const r = baseR * (0.85 + rng() * 0.3);
    const tx = gridSize / 2 + Math.cos(angle) * r;
    const ty = gridSize / 2 + Math.sin(angle) * r;
    const best = nearestTraversable(map, gridSize, Math.round(tx), Math.round(ty));
    if (best) checkpoints.push(best);
  }
  return checkpoints;
}

function nearestTraversable(map, gridSize, gx, gy) {
  // Spiral search.
  for (let r = 0; r < gridSize; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const nx = gx + dx, ny = gy + dy;
        if (nx < 0 || nx >= gridSize || ny < 0 || ny >= gridSize) continue;
        const b = map[ny][nx];
        if (b !== WATER && b !== MOUNTAIN) return { gx: nx, gy: ny };
      }
    }
  }
  return null;
}

// ---- A* -----------------------------------------------------------------

// Find the cheapest 4-connected path from start to end using biomeCost().
// Cells whose "gx,gy" key is in `excludeKeys` are treated as blocked, so
// successive A* runs can avoid revisiting cells used by earlier segments.
export function astar(start, end, biomeMap, excludeKeys = null) {
  const { map, gridSize } = biomeMap;
  const open = new Map();
  const closed = new Set();
  const keyOf = (gx, gy) => gy * gridSize + gx;
  const stringKey = (gx, gy) => `${gx},${gy}`;

  const startKey = keyOf(start.gx, start.gy);
  open.set(startKey, { gx: start.gx, gy: start.gy, g: 0, f: 0, parent: null });

  while (open.size > 0) {
    let bestKey = null, bestNode = null, bestF = Infinity;
    for (const [k, n] of open) {
      if (n.f < bestF) { bestF = n.f; bestKey = k; bestNode = n; }
    }
    if (bestNode.gx === end.gx && bestNode.gy === end.gy) {
      const path = [];
      let n = bestNode;
      while (n) { path.unshift({ gx: n.gx, gy: n.gy }); n = n.parent; }
      return path;
    }
    open.delete(bestKey);
    closed.add(bestKey);

    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = bestNode.gx + dx, ny = bestNode.gy + dy;
      if (nx < 0 || nx >= gridSize || ny < 0 || ny >= gridSize) continue;
      const nKey = keyOf(nx, ny);
      if (closed.has(nKey)) continue;
      if (excludeKeys && excludeKeys.has(stringKey(nx, ny))) continue;
      const b = map[ny][nx];
      const c = biomeCost(b);
      if (!isFinite(c)) continue;
      const g = bestNode.g + c;
      const h = Math.abs(nx - end.gx) + Math.abs(ny - end.gy);
      const f = g + h;
      const existing = open.get(nKey);
      if (existing && existing.g <= g) continue;
      open.set(nKey, { gx: nx, gy: ny, g, f, parent: bestNode });
    }
  }
  return null;
}

// ---- Road carving -------------------------------------------------------

// Visit each checkpoint in order, running A* between consecutive ones, and
// returning the full closed loop of road cells. The closing segment from
// the last checkpoint back to the first is what makes the track loop.
//
// We DO NOT exclude previously-used cells here — doing so could leave the
// closing leg unreachable (everything around the start is fenced off by
// the earlier segments). Allowing path overlap is harmless: dilation +
// auto-tiling collapse duplicates into a single road area, and the
// closing path can always find its way back to checkpoint 0.
export function carveRoad(checkpoints, biomeMap) {
  if (!checkpoints || checkpoints.length < 2) return [];
  const cells = [];
  const usedKeys = new Set();
  const keyOf = (c) => `${c.gx},${c.gy}`;

  for (let i = 0; i < checkpoints.length; i++) {
    const a = checkpoints[i];
    const b = checkpoints[(i + 1) % checkpoints.length];
    const path = astar(a, b, biomeMap);
    if (!path) continue;
    const start = (i === 0) ? 0 : 1;
    for (let j = start; j < path.length; j++) {
      const c = path[j];
      const k = keyOf(c);
      if (usedKeys.has(k)) continue;     // collapse repeats; the loop still closes
      usedKeys.add(k);
      cells.push(c);
    }
  }
  return cells;
}
