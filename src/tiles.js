// Road auto-tiling.
//
// Each road cell is rendered as ONE tile whose shape and rotation come
// from which of its four cardinal neighbours are ALSO road cells. This is
// the standard 4-connected Wang-style auto-tile decision:
//
//   0 neighbours → no road (skipped — should not occur on a closed loop)
//   1            → cap (rare)
//   2 opposite   → straight  (N+S → rotation 0, E+W → π/2)
//   2 adjacent   → corner    (N+E → 0, E+S → π/2, S+W → π, W+N → -π/2)
//   3            → tee
//   4            → cross
//
// Edge numbering matches terrain.js: 0=N, 1=E, 2=S, 3=W. Cell (gx, gy)
// has neighbours at (gx, gy-1)=N, (gx+1, gy)=E, (gx, gy+1)=S, (gx-1, gy)=W.

import { CELL_SIZE, cellToWorld } from './terrain.js';
export { CELL_SIZE };

function shapeAndRotation(neighbourMask) {
  // neighbourMask is a 4-bit value: bit0=N, bit1=E, bit2=S, bit3=W
  const n = (neighbourMask & 1) !== 0;
  const e = (neighbourMask & 2) !== 0;
  const s = (neighbourMask & 4) !== 0;
  const w = (neighbourMask & 8) !== 0;
  const count = (n + e + s + w);
  if (count === 4) return { type: 'cross', rotation: 0 };
  if (count === 3) {
    // Three branches — rotate so the missing edge points S (rotation 0).
    if (!s) return { type: 'tee', rotation: 0 };
    if (!w) return { type: 'tee', rotation: Math.PI / 2 };
    if (!n) return { type: 'tee', rotation: Math.PI };
    return { type: 'tee', rotation: -Math.PI / 2 };   // missing E
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
  return { type: 'straight', rotation: 0 };
}

// Build flat road-plate placements from a set of road cells (after dilation).
// Roads can be many cells wide so the auto-tile-shape distinction doesn't
// really apply per cell — every road cell is a flat plate. The renderer
// decides on markings (centre dashes, apex arcs) based on the cell's
// distance from the centerline path.
export function flatRoadPlacements(roadCells, roadType = 'pavement') {
  const placements = [];
  for (const c of roadCells) {
    const world = cellToWorld(c.gx, c.gy);
    placements.push({
      gx: c.gx, gy: c.gy,
      cx: world.x, cy: world.y,
      type: 'plate',
      rotation: 0,
      roadType,
    });
  }
  return placements;
}

// Legacy single-cell-wide autotile retained for cases where roads must be
// exactly one cell wide (not currently used by the main pipeline).
export function autotileRoad(roadCells, roadType = 'pavement') {
  const has = new Set(roadCells.map(c => `${c.gx},${c.gy}`));
  const placements = [];
  for (const c of roadCells) {
    let mask = 0;
    if (has.has(`${c.gx},${c.gy - 1}`)) mask |= 1;
    if (has.has(`${c.gx + 1},${c.gy}`)) mask |= 2;
    if (has.has(`${c.gx},${c.gy + 1}`)) mask |= 4;
    if (has.has(`${c.gx - 1},${c.gy}`)) mask |= 8;
    const { type, rotation } = shapeAndRotation(mask);
    const world = cellToWorld(c.gx, c.gy);
    placements.push({
      gx: c.gx, gy: c.gy,
      cx: world.x, cy: world.y,
      type, rotation, roadType,
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

// Dilate a centerline cell chain into a wide road area. For each cell in
// the chain we add all neighbouring cells within `radius[i]` cells using
// a circular footprint (so corners stay rounded instead of stepped).
// Returns:
//   set     — Set<"gx,gy"> of every cell now considered road area.
//   cells   — [{gx,gy}] in the same set (handy for iteration).
//   widthM  — per-input-cell width in metres ((2r+1) * CELL_SIZE).
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

// One Chaikin smoothing pass on a closed polyline.
export function chaikinClosed(pts) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    out.push({ x: 0.75 * p.x + 0.25 * q.x, y: 0.75 * p.y + 0.25 * q.y });
    out.push({ x: 0.25 * p.x + 0.75 * q.x, y: 0.25 * p.y + 0.75 * q.y });
  }
  return out;
}
