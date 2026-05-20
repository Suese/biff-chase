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

// HALF-OFFSET OUTPUT TILES.
//
// The meta-grid says "what's on this cell" (biome / road). The OUTPUT
// grid sits at the CORNER INTERSECTIONS of meta-cells (offset by ½ cell
// on both axes). For every output-tile position we read the 4 meta-cells
// that touch its corners (NW, NE, SW, SE) and pick a wall shape that
// satisfies that constraint. Adjacent output tiles share two corners, so
// walls join automatically across tile borders.
//
// Each tile carries { cgx, cgy, cx, cy, corners {nw, ne, sw, se}, walls }.
// `walls` is the list of segments INSIDE the tile derived from its
// road-corner pattern. There are 16 patterns (2^4 corner road/no-road
// states); each maps to a specific wall layout.

export function buildOutputTiles(metaMap, gridSize) {
  const tiles = [];
  const halfW = (gridSize * CELL_SIZE) / 2;
  const H = CELL_SIZE / 2;
  for (let cgy = 0; cgy <= gridSize; cgy++) {
    for (let cgx = 0; cgx <= gridSize; cgx++) {
      const nw = sampleMeta(metaMap, cgx - 1, cgy - 1, gridSize);
      const ne = sampleMeta(metaMap, cgx,     cgy - 1, gridSize);
      const sw = sampleMeta(metaMap, cgx - 1, cgy,     gridSize);
      const se = sampleMeta(metaMap, cgx,     cgy,     gridSize);
      const cx = cgx * CELL_SIZE - halfW;
      const cy = cgy * CELL_SIZE - halfW;
      const mask =
        (nw === 'road' ? 1 : 0) |
        (ne === 'road' ? 2 : 0) |
        (sw === 'road' ? 4 : 0) |
        (se === 'road' ? 8 : 0);
      const walls = wallsForCornerMask(mask, cx, cy, H);
      tiles.push({
        cgx, cgy, cx, cy,
        corners: { nw, ne, sw, se },
        mask,
        walls,
      });
    }
  }
  return tiles;
}

function sampleMeta(metaMap, gx, gy, gridSize) {
  if (gx < 0 || gx >= gridSize || gy < 0 || gy >= gridSize) return 'water';
  return metaMap[gy][gx];
}

// 16-case auto-tile wall lookup. Mask bits: 1=NW, 2=NE, 4=SW, 8=SE.
//
//   0 / 15 (none or all road) → no walls
//   1 corner               → diagonal cutting that corner
//   2 adjacent (half tile) → straight wall on the dividing line
//   2 opposite (saddle)    → two diagonals (X)
//   3 corners              → diagonal cutting the missing corner
function wallsForCornerMask(mask, cx, cy, H) {
  const Nm = { x: cx,     y: cy - H };
  const Em = { x: cx + H, y: cy };
  const Sm = { x: cx,     y: cy + H };
  const Wm = { x: cx - H, y: cy };
  const out = [];
  const diag = (a, b) => out.push({ kind: 'diag', ax: a.x, ay: a.y, bx: b.x, by: b.y });
  const horiz = () => out.push({ kind: 'axial', x: cx, y: cy, len: 2 * H, axis: 'x' });
  const vert  = () => out.push({ kind: 'axial', x: cx, y: cy, len: 2 * H, axis: 'y' });
  switch (mask) {
    case 0: case 15: break;
    case 1:  diag(Nm, Wm); break;   // NW only
    case 2:  diag(Nm, Em); break;   // NE only
    case 4:  diag(Sm, Wm); break;   // SW only
    case 8:  diag(Sm, Em); break;   // SE only
    case 3:  horiz(); break;         // NW+NE → top half road
    case 12: horiz(); break;         // SW+SE → bottom half road
    case 5:  vert();  break;         // NW+SW → left half road
    case 10: vert();  break;         // NE+SE → right half road
    case 6:  diag(Nm, Em); diag(Sm, Wm); break;  // NE+SW saddle
    case 9:  diag(Nm, Wm); diag(Sm, Em); break;  // NW+SE saddle
    case 7:  diag(Sm, Em); break;   // missing SE
    case 11: diag(Sm, Wm); break;   // missing SW
    case 13: diag(Nm, Em); break;   // missing NE
    case 14: diag(Nm, Wm); break;   // missing NW
  }
  return out;
}

// LEGACY axial-only wall extraction from road placements — kept for
// backwards compatibility but no longer used by the main pipeline.
export function wallSegmentsFromTiles(placements) {
  const H = CELL_SIZE / 2;
  const walls = [];
  for (const p of placements) {
    const n = (p.mask & MASK_N) !== 0;
    const e = (p.mask & MASK_E) !== 0;
    const s = (p.mask & MASK_S) !== 0;
    const w = (p.mask & MASK_W) !== 0;
    const count = (n + e + s + w);
    const isCornerAdjacent = count === 2 &&
      ((n && e) || (e && s) || (s && w) || (w && n));

    if (isCornerAdjacent) {
      // Diagonal wall connecting the midpoints of the two MISSING sides.
      let ax, ay, bx, by;
      if (n && e)       { ax = p.cx;     ay = p.cy + H; bx = p.cx - H; by = p.cy;     }
      else if (e && s)  { ax = p.cx - H; ay = p.cy;     bx = p.cx;     by = p.cy - H; }
      else if (s && w)  { ax = p.cx;     ay = p.cy - H; bx = p.cx + H; by = p.cy;     }
      else /* w && n */ { ax = p.cx + H; ay = p.cy;     bx = p.cx;     by = p.cy + H; }
      walls.push({ kind: 'diag', ax, ay, bx, by });
      continue;
    }

    if (!n) walls.push({ kind: 'axial', x: p.cx,     y: p.cy - H, len: CELL_SIZE, axis: 'x', side: 'N' });
    if (!e) walls.push({ kind: 'axial', x: p.cx + H, y: p.cy,     len: CELL_SIZE, axis: 'y', side: 'E' });
    if (!s) walls.push({ kind: 'axial', x: p.cx,     y: p.cy + H, len: CELL_SIZE, axis: 'x', side: 'S' });
    if (!w) walls.push({ kind: 'axial', x: p.cx - H, y: p.cy,     len: CELL_SIZE, axis: 'y', side: 'W' });
  }
  return walls;
}
