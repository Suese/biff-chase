// Half-tile road system.
//
// Cells are 4m × 4m. A track is built by walking a continuous polyline
// (the centerline) and figuring out, for each cell the line passes through,
// where it enters and where it exits the cell. From those two edges we pick
// a TILE TYPE and a ROTATION; the renderer instantiates a pre-authored
// mesh oriented to match.
//
// Edges are numbered:  0=N (top), 1=E, 2=S (bottom), 3=W. The CELL_SIZE
// constant defines metres per cell. Tile rotation is in radians around the
// cell's vertical (Y) axis.
//
// "Smart mapping": rather than authoring every combination of entry/exit,
// each unique unordered edge pair maps to ONE base mesh, with a rotation
// derived from how the canonical pair (N→S for straights, N→E for corners)
// rotates onto the observed pair.
//
// Tile shapes:
//   - 'straight'   — road runs straight across opposite edges (N↔S).
//   - 'corner'     — 90° turn between adjacent edges (N↔E).
//   - 'dual'       — straight section with a centre median (N↔S).
//
// Road surface materials are picked per tile from the section's road type
// ('pavement' | 'gravel' | 'ice').

export const CELL_SIZE = 4;       // metres per half-tile cell

// --- Tile classification --------------------------------------------------

// Determine which edge of a cell a point belongs to, given the cell's
// local x/y range. Returns 0..3 (N/E/S/W) or -1 if the point is interior.
function classifyEdge(p, cell) {
  const lx = p.x - cell.x;       // local 0..CELL_SIZE
  const ly = p.y - cell.y;
  // Snap to whichever edge the point is closest to (with a tolerance).
  const dN = ly;                 // distance from top (smaller y assumed top)
  const dS = CELL_SIZE - ly;
  const dW = lx;
  const dE = CELL_SIZE - lx;
  const best = Math.min(dN, dE, dS, dW);
  if (best === dN) return 0;
  if (best === dE) return 1;
  if (best === dS) return 2;
  return 3;
}

// Pick the tile shape from an (entryEdge, exitEdge) pair. Returns
// { type, rotation } where rotation is in radians around world Y.
//
// The canonical orientations are:
//   straight  — N↔S   (canonical: 0..2 → rotation 0)
//   corner    — N→E   (canonical: 0→1 → rotation 0)
//   diagonal_straight is not yet authored; falls back to straight.
function pickTile(entryEdge, exitEdge) {
  if (entryEdge < 0 || exitEdge < 0 || entryEdge === exitEdge) {
    // Degenerate — render a straight as a fallback.
    return { type: 'straight', rotation: 0 };
  }
  // Opposite edges → straight.
  if ((entryEdge + 2) % 4 === exitEdge) {
    // Canonical N↔S. Rotate by entry edge × 90° (radians: × π/2).
    // N(0)↔S(2) → 0; E(1)↔W(3) → π/2.
    const rot = (entryEdge % 2) * (Math.PI / 2);
    return { type: 'straight', rotation: rot };
  }
  // Adjacent edges → corner. Canonical N→E (0→1). Map other pairs by
  // rotating the canonical so that "entry edge" matches.
  const pair = [entryEdge, exitEdge];
  // Treat pair as unordered: canonical pairs and their rotations.
  const canonical = [
    { a: 0, b: 1, rot: 0 },                  // N↔E
    { a: 1, b: 2, rot: Math.PI / 2 },        // E↔S
    { a: 2, b: 3, rot: Math.PI },            // S↔W
    { a: 3, b: 0, rot: -Math.PI / 2 },       // W↔N
  ];
  for (const c of canonical) {
    if ((pair[0] === c.a && pair[1] === c.b) || (pair[0] === c.b && pair[1] === c.a)) {
      return { type: 'corner', rotation: c.rot };
    }
  }
  return { type: 'straight', rotation: 0 };
}

// --- Placer ---------------------------------------------------------------

// Walk the centerline and emit one tile placement per visited cell.
// Returns [{ cellX, cellY, centerX, centerY, type, rotation, roadType }, ...]
//
// roadType is picked per cell from the per-centerline-index `roadTypeAt`
// callback (so a section's road material lays down evenly across all its
// cells).
export function placeTiles(centerline, roadTypeAt) {
  const cells = new Map();    // "gx,gy" -> { gx, gy, x, y, firstIdx, lastIdx, count }
  const N = centerline.length;
  for (let i = 0; i < N; i++) {
    const p = centerline[i];
    const gx = Math.floor(p.x / CELL_SIZE);
    const gy = Math.floor(p.y / CELL_SIZE);
    const key = `${gx},${gy}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        gx, gy,
        x: gx * CELL_SIZE,
        y: gy * CELL_SIZE,
        firstIdx: i,
        lastIdx: i,
        count: 0,
      };
      cells.set(key, cell);
    }
    cell.lastIdx = i;
    cell.count += 1;
  }

  // Determine entry/exit edges per cell.
  const placements = [];
  for (const cell of cells.values()) {
    // Take the centerline points right before entry and right after exit
    // to figure out which edges of the cell the path crosses.
    const beforeIdx = (cell.firstIdx - 1 + N) % N;
    const afterIdx  = (cell.lastIdx + 1) % N;
    const inPoint   = centerline[beforeIdx];
    const outPoint  = centerline[afterIdx];

    // Bring those points to the cell-local edge by linearly extending from
    // the first/last cell-interior point until we cross a boundary.
    const firstInside = centerline[cell.firstIdx];
    const lastInside  = centerline[cell.lastIdx];
    const entryEdge = edgeOfCrossing(inPoint, firstInside, cell);
    const exitEdge  = edgeOfCrossing(lastInside, outPoint, cell);

    const tile = pickTile(entryEdge, exitEdge);
    placements.push({
      gx: cell.gx,
      gy: cell.gy,
      cx: cell.x + CELL_SIZE / 2,
      cy: cell.y + CELL_SIZE / 2,
      type: tile.type,
      rotation: tile.rotation,
      roadType: roadTypeAt(cell.firstIdx),
    });
  }
  return placements;
}

// Find which edge of `cell` the segment a→b crosses (a outside cell, b
// inside, or vice versa). Returns 0/1/2/3 (N/E/S/W) or -1 if no crossing.
function edgeOfCrossing(a, b, cell) {
  const x0 = cell.x, x1 = cell.x + CELL_SIZE;
  const y0 = cell.y, y1 = cell.y + CELL_SIZE;
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return -1;
  // Parametric line, find where it intersects each cell edge.
  const candidates = [];
  if (dy !== 0) {
    const tN = (y0 - a.y) / dy; if (tN >= 0 && tN <= 1) {
      const x = a.x + dx * tN; if (x >= x0 && x <= x1) candidates.push({ t: tN, edge: 0 });
    }
    const tS = (y1 - a.y) / dy; if (tS >= 0 && tS <= 1) {
      const x = a.x + dx * tS; if (x >= x0 && x <= x1) candidates.push({ t: tS, edge: 2 });
    }
  }
  if (dx !== 0) {
    const tE = (x1 - a.x) / dx; if (tE >= 0 && tE <= 1) {
      const y = a.y + dy * tE; if (y >= y0 && y <= y1) candidates.push({ t: tE, edge: 1 });
    }
    const tW = (x0 - a.x) / dx; if (tW >= 0 && tW <= 1) {
      const y = a.y + dy * tW; if (y >= y0 && y <= y1) candidates.push({ t: tW, edge: 3 });
    }
  }
  if (!candidates.length) {
    // Fallback: pick the closest edge to the inside point b.
    return classifyEdge(b, cell);
  }
  candidates.sort((a, b) => a.t - b.t);
  return candidates[0].edge;
}
