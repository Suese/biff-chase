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

import { CELL_SIZE, GRID_SIZE, cellToWorld, ROAD } from './terrain.js';
export { CELL_SIZE };

// ------------------------------------------------------------------------
//   Half-offset output tile system
// ------------------------------------------------------------------------
// Each meta-cell is split into 4 quadrants. An OUTPUT tile sits at the
// corner intersection of 4 meta-cells; it renders the 4 quadrants of the
// 4 surrounding meta-cells (its NW quadrant = SE quadrant of the NW
// meta-cell, etc.). Output tiles tile the world cleanly with no overlap.
//
// For each pair of adjacent quadrants within a tile, if exactly one is
// ROAD we emit a WALL along the shared edge. Walls are part of the tile
// description, not a separate pass — they're authored INTO the tile.

export function buildOutputTiles(metaMap) {
  const tiles = [];
  const halfW = (GRID_SIZE * CELL_SIZE) / 2;
  // Output tile coordinates range from 0..GRID_SIZE inclusive. At cgx=0 or
  // cgx=GRID_SIZE the tile sits on the world border — those border tiles
  // still render but their out-of-range corners read as WATER (off the map).
  for (let cgy = 0; cgy <= GRID_SIZE; cgy++) {
    for (let cgx = 0; cgx <= GRID_SIZE; cgx++) {
      const nw = sampleMeta(metaMap, cgx - 1, cgy - 1);
      const ne = sampleMeta(metaMap, cgx,     cgy - 1);
      const sw = sampleMeta(metaMap, cgx - 1, cgy);
      const se = sampleMeta(metaMap, cgx,     cgy);
      // World position of the corner.
      const cx = cgx * CELL_SIZE - halfW;
      const cy = cgy * CELL_SIZE - halfW;
      // Walls — one per pair of adjacent quadrants with mixed road/non-road.
      // axis = 'x' means the wall RUNS along the world X axis (horizontal
      // segment in the XZ plane). axis = 'y' means it runs along world Y
      // (which is world Z in 3D after the 2D→3D mapping).
      const walls = [];
      const halfQ = CELL_SIZE / 4;     // distance from tile centre to quadrant boundary
      const isRoad = (b) => b === ROAD;
      // NW-NE shared edge is the VERTICAL segment at x = cx in the top
      // half of the tile — runs along world Y.
      if (isRoad(nw) !== isRoad(ne)) {
        walls.push({ x: cx, y: cy - halfQ, len: CELL_SIZE / 2, axis: 'y' });
      }
      // NE-SE shared edge is the HORIZONTAL segment at y = cy in the right
      // half of the tile — runs along world X.
      if (isRoad(ne) !== isRoad(se)) {
        walls.push({ x: cx + halfQ, y: cy, len: CELL_SIZE / 2, axis: 'x' });
      }
      // SE-SW shared edge is the VERTICAL segment at x = cx in the bottom
      // half of the tile — runs along world Y.
      if (isRoad(se) !== isRoad(sw)) {
        walls.push({ x: cx, y: cy + halfQ, len: CELL_SIZE / 2, axis: 'y' });
      }
      // SW-NW shared edge is the HORIZONTAL segment at y = cy in the left
      // half of the tile — runs along world X.
      if (isRoad(sw) !== isRoad(nw)) {
        walls.push({ x: cx - halfQ, y: cy, len: CELL_SIZE / 2, axis: 'x' });
      }
      tiles.push({
        cgx, cgy,
        cx, cy,
        corners: { nw, ne, sw, se },
        walls,
      });
    }
  }
  return tiles;
}

// Out-of-bounds reads as WATER so map borders show ocean.
function sampleMeta(metaMap, gx, gy) {
  if (gx < 0 || gx >= GRID_SIZE || gy < 0 || gy >= GRID_SIZE) return 'water';
  return metaMap[gy][gx];
}

// Stable hash for "wall present?" toggle so the same seed produces the
// same wall layout. About 70% of eligible walls actually render; the
// gaps make sections of the track feel more open.
function wallPresent(tile, dirIdx) {
  let h = (tile.cgx + 1009) * 73856093 ^ (tile.cgy + 2003) * 19349663 ^ dirIdx * 83492791;
  h = (h ^ (h >>> 13)) * 0x5bd1e995;
  h = h ^ (h >>> 15);
  return ((h >>> 0) % 100) < 78;
}

// Re-walk the output tiles to attach a `present` boolean to every wall.
// Called after buildOutputTiles so callers can iterate `t.walls` and skip
// invisible ones (or render them as a low kerb instead).
export function annotateWalls(outputTiles) {
  for (const t of outputTiles) {
    for (let i = 0; i < t.walls.length; i++) {
      t.walls[i].present = wallPresent(t, i);
    }
  }
}

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
