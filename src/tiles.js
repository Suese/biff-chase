// Tile system. ONE TILE per meta-cell. Each road tile auto-picks its
// shape + rotation from which of its 4 cardinal neighbours are also road.
// Walls are not a separate concept — they belong to road tiles whose
// neighbouring cell is NOT road.
//
// There is no half-offset grid, no transition tiles, no special-case
// wall pass. The 2D tile map is rendered as 3D tiles; nothing else.

import { CELL_SIZE, cellToWorld } from './terrain.js';
export { CELL_SIZE };

// Mask bits for the 4 cardinal neighbours.
//   bit 0 (1)  = N  (gy - 1)
//   bit 1 (2)  = E  (gx + 1)
//   bit 2 (4)  = S  (gy + 1)
//   bit 3 (8)  = W  (gx - 1)
export const MASK_N = 1;
export const MASK_E = 2;
export const MASK_S = 4;
export const MASK_W = 8;

// Pick a road-tile shape + rotation from the cardinal-neighbour mask. The
// rotation is what gets applied to the canonical mesh:
//   straight — canonical N↔S; rotation 0 / π/2 (= E↔W).
//   corner   — canonical N→E; rotations 0, π/2, π, -π/2.
//   tee      — canonical missing south; rotations cycle through which side
//              the stem points.
//   cross    — no rotation.
//   cap      — single-neighbour dead-end; canonical neighbour=N.
function shapeAndRotation(mask) {
  const n = (mask & MASK_N) !== 0;
  const e = (mask & MASK_E) !== 0;
  const s = (mask & MASK_S) !== 0;
  const w = (mask & MASK_W) !== 0;
  const count = (n + e + s + w);
  if (count === 4) return { type: 'cross', rotation: 0 };
  if (count === 3) {
    if (!s) return { type: 'tee', rotation: 0 };
    if (!w) return { type: 'tee', rotation: Math.PI / 2 };
    if (!n) return { type: 'tee', rotation: Math.PI };
    return { type: 'tee', rotation: -Math.PI / 2 };
  }
  if (count === 2) {
    if (n && s) return { type: 'straight', rotation: 0 };
    if (e && w) return { type: 'straight', rotation: Math.PI / 2 };
    if (n && e) return { type: 'corner', rotation: 0 };
    if (e && s) return { type: 'corner', rotation: Math.PI / 2 };
    if (s && w) return { type: 'corner', rotation: Math.PI };
    if (w && n) return { type: 'corner', rotation: -Math.PI / 2 };
  }
  if (count === 1) {
    if (n) return { type: 'cap', rotation: 0 };
    if (e) return { type: 'cap', rotation: Math.PI / 2 };
    if (s) return { type: 'cap', rotation: Math.PI };
    return { type: 'cap', rotation: -Math.PI / 2 };
  }
  // Isolated road cell — render as a tee with no rotation (4 walls).
  return { type: 'isolated', rotation: 0 };
}

// Auto-tile every road cell. Each placement carries the per-tile mask
// (so the renderer knows which sides need walls) plus the picked shape
// and rotation.
export function autotileRoad(roadCells, roadType = 'pavement') {
  const has = new Set(roadCells.map(c => `${c.gx},${c.gy}`));
  const placements = [];
  for (const c of roadCells) {
    let mask = 0;
    if (has.has(`${c.gx},${c.gy - 1}`)) mask |= MASK_N;
    if (has.has(`${c.gx + 1},${c.gy}`)) mask |= MASK_E;
    if (has.has(`${c.gx},${c.gy + 1}`)) mask |= MASK_S;
    if (has.has(`${c.gx - 1},${c.gy}`)) mask |= MASK_W;
    const shape = shapeAndRotation(mask);
    const world = cellToWorld(c.gx, c.gy);
    placements.push({
      gx: c.gx, gy: c.gy,
      cx: world.x, cy: world.y,
      type: shape.type,
      rotation: shape.rotation,
      mask,
      roadType,
    });
  }
  return placements;
}

// Centerline polyline derived from a road-cell chain (one point per cell
// centre). Cells must already be sorted so consecutive entries are
// 4-connected.
export function centerlineFromCells(roadCells) {
  return roadCells.map(c => cellToWorld(c.gx, c.gy));
}

// Dilate a 1-cell-wide chain into a multi-cell-wide road area. Returns
//   { set, cells, widths }
// where widths is per input-cell road width in metres.
export function dilateRoadCells(centerCells, radiusFor) {
  const set = new Set();
  const cells = [];
  const widths = [];
  for (let i = 0; i < centerCells.length; i++) {
    const c = centerCells[i];
    const r = Math.max(1, Math.floor(radiusFor(i)));
    widths.push((2 * r + 1) * CELL_SIZE);
    const r2 = r * r;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (dx * dx + dy * dy > r2) continue;
        const gx = c.gx + dx;
        const gy = c.gy + dy;
        const key = `${gx},${gy}`;
        if (!set.has(key)) {
          set.add(key);
          cells.push({ gx, gy });
        }
      }
    }
  }
  return { set, cells, widths };
}

// Wall segments from cell adjacency: every road-tile side with a non-road
// neighbour becomes a 4m wall along that edge. Used by physics + renderer.
export function wallSegmentsFromTiles(placements) {
  const walls = [];
  for (const p of placements) {
    if ((p.mask & MASK_N) === 0) {
      walls.push({ x: p.cx,                      y: p.cy - CELL_SIZE / 2, len: CELL_SIZE, axis: 'x', side: 'N' });
    }
    if ((p.mask & MASK_E) === 0) {
      walls.push({ x: p.cx + CELL_SIZE / 2,      y: p.cy,                  len: CELL_SIZE, axis: 'y', side: 'E' });
    }
    if ((p.mask & MASK_S) === 0) {
      walls.push({ x: p.cx,                      y: p.cy + CELL_SIZE / 2, len: CELL_SIZE, axis: 'x', side: 'S' });
    }
    if ((p.mask & MASK_W) === 0) {
      walls.push({ x: p.cx - CELL_SIZE / 2,      y: p.cy,                  len: CELL_SIZE, axis: 'y', side: 'W' });
    }
  }
  return walls;
}
