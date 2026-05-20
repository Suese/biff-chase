// Tile system: cell chain → tile placements + derived centerline.
//
// Connectors emit a 4-connected chain of grid cells. From that chain we
// can read each cell's entry edge (= direction from the previous cell)
// and exit edge (= direction to the next cell), pick a tile shape
// (straight if edges are opposite, corner if adjacent), and a rotation
// that maps the canonical orientation onto the observed pair.
//
// The centerline polyline (used by physics + cars + minimap) is DERIVED
// from the cell chain — at every cell we drop the centerline-snap-point
// that the tile's road-line passes through. For a straight tile this is
// just the cell centre; for a corner it's still the centre (the renderer
// draws the apex curve). One Chaikin pass smooths it for nice arcs.
//
// Cells are 4m × 4m.

export const CELL_SIZE = 4;

// Octilinear edge numbers used elsewhere in the codebase: 0=N (–Y direction
// in world / game), 1=E (+X), 2=S (+Y), 3=W (–X).
// For our cell-step logic we use the convention that going from cell (gx,gy)
// to cell (gx,gy-1) means the SECOND cell was entered from its SOUTH edge
// (since the line came from below... wait that's backwards). Let me state
// the convention clearly:
//   World-Y goes from -Y (north) to +Y (south) in the game's 2D coords.
//   So if cell B is north of cell A (B.gy = A.gy - 1), then the chain
//   enters B from its SOUTH edge (the edge B shares with A).
//
//   gy decreases → moved NORTH → cell entered through its SOUTH edge.
//   gy increases → moved SOUTH → cell entered through its NORTH edge.
//   gx increases → moved EAST   → cell entered through its WEST edge.
//   gx decreases → moved WEST   → cell entered through its EAST edge.
function enteredEdge(from, to) {
  if (to.gy < from.gy) return 2;        // came from south
  if (to.gy > from.gy) return 0;        // came from north
  if (to.gx > from.gx) return 3;        // came from west
  if (to.gx < from.gx) return 1;        // came from east
  return -1;
}
function exitedEdge(from, to) {
  // Edge of `from` through which we leave toward `to`.
  if (to.gy < from.gy) return 0;        // leave through north
  if (to.gy > from.gy) return 2;        // leave through south
  if (to.gx > from.gx) return 1;        // leave through east
  if (to.gx < from.gx) return 3;        // leave through west
  return -1;
}

// Canonical orientations:
//   straight  — N↔S: rotation 0      (entry/exit edges 0 & 2)
//                E↔W: rotation π/2
//   corner    — N→E (entry 0, exit 1): rotation 0
//                E→S (entry 1, exit 2): rotation π/2
//                S→W (entry 2, exit 3): rotation π
//                W→N (entry 3, exit 0): rotation -π/2
function pickShape(entryEdge, exitEdge) {
  if (entryEdge < 0 || exitEdge < 0 || entryEdge === exitEdge) {
    return { type: 'straight', rotation: 0 };
  }
  if ((entryEdge + 2) % 4 === exitEdge) {
    return { type: 'straight', rotation: (entryEdge % 2) * (Math.PI / 2) };
  }
  // Adjacent edges → corner.
  const map = [
    { a: 0, b: 1, rot: 0 },
    { a: 1, b: 2, rot: Math.PI / 2 },
    { a: 2, b: 3, rot: Math.PI },
    { a: 3, b: 0, rot: -Math.PI / 2 },
  ];
  for (const c of map) {
    if ((entryEdge === c.a && exitEdge === c.b) || (entryEdge === c.b && exitEdge === c.a)) {
      return { type: 'corner', rotation: c.rot };
    }
  }
  return { type: 'straight', rotation: 0 };
}

// cells: 4-connected closed chain of {gx, gy, roadType?}
// Returns:
//   { placements: [{gx,gy,cx,cy,type,rotation,roadType}],
//     centerline: [{x,y}],     // closed polyline, one point per cell
//     widths:     [width],     // per centerline vertex; from per-cell roadWidth
//   }
export function buildFromCellChain(cells) {
  const N = cells.length;
  if (N < 3) return { placements: [], centerline: [], widths: [] };

  const placements = [];
  const centerline = [];
  const widths = [];

  for (let i = 0; i < N; i++) {
    const prev = cells[(i - 1 + N) % N];
    const cur  = cells[i];
    const next = cells[(i + 1) % N];
    const entryEdge = enteredEdge(prev, cur);
    const exitEdge  = exitedEdge(cur, next);
    const shape = pickShape(entryEdge, exitEdge);
    const cx = cur.gx * CELL_SIZE + CELL_SIZE / 2;
    const cy = cur.gy * CELL_SIZE + CELL_SIZE / 2;

    placements.push({
      gx: cur.gx,
      gy: cur.gy,
      cx, cy,
      type: shape.type,
      rotation: shape.rotation,
      roadType: cur.roadType || 'pavement',
      entryEdge,
      exitEdge,
    });

    centerline.push({ x: cx, y: cy });
    // Width per cell: roadType drives this.
    widths.push(roadWidthFor(cur.roadType || 'pavement'));
  }

  return { placements, centerline, widths };
}

function roadWidthFor(roadType) {
  // Pavement is the widest 4-lane racing surface; gravel and ice slightly
  // narrower for visual variety.
  if (roadType === 'gravel') return 9.5;
  if (roadType === 'ice')    return 10.5;
  return 11;   // pavement
}

// One Chaikin pass on a closed polyline — used to smooth the cell-centre
// centerline so cars + physics see flowing arcs through the corners
// instead of sharp 90° elbow joints.
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

export function expandWidths(widths) {
  // After a Chaikin pass each input width becomes two output widths (an
  // 0.75/0.25 mix would be needed for perfect accuracy, but per-vertex
  // road width changes slowly so simple duplication is fine).
  const out = [];
  for (const w of widths) { out.push(w); out.push(w); }
  return out;
}
