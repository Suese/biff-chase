// Tile-grid track generator.
//
// One tile per meta-cell. There is no polyline, no width array, no CSG
// trapezoids, no clamp-to-track. The 2D tile map is the only source of
// truth; physics keeps the car on the road by colliding with WALL bodies
// derived directly from road↔non-road tile adjacency.
//
// Pipeline:
//   1. Generate biome map (terrain.js) → 50×50 grid of {water, land, forest, mountain}.
//   2. Pick checkpoints on traversable cells in a rough circle.
//   3. A* between consecutive checkpoints with biome costs → ordered road cells.
//   4. Dilate the road to a multi-cell-wide area.
//   5. Auto-tile every road cell: type + rotation + 4-neighbour mask.
//   6. Walls = every road-tile side whose neighbour isn't road.
//   7. Derive start, lap checkpoints (specific tiles), spawn grid, pickup
//      slots, world bounds from the cell grid.

import { mulberry32, rfloat } from './rng.js';
import {
  GRID_SIZE, CELL_SIZE, WORLD_HALF,
  generateBiomeMap, pickCheckpoints, carveRoad,
  cellToWorld, WATER, LAND, FOREST, MOUNTAIN, ROAD,
} from './terrain.js';
import { autotileRoad, dilateRoadCells, buildOutputTiles } from './tiles.js';

export function generateTrack(seed) {
  const rng = mulberry32(seed >>> 0);

  // 1. Biome map.
  const biomeMap = generateBiomeMap(seed);

  // 2–3. Pick checkpoints + carve a non-self-overlapping closed road. If
  // the closing leg can't find a clear path because previous segments
  // have fenced off the start, throw the whole attempt away and try
  // again with a fresh set of checkpoints. Up to 30 tries before falling
  // back to a guaranteed square loop.
  let roadCells = null;
  for (let attempt = 0; attempt < 30 && !roadCells; attempt++) {
    const waypoints = pickCheckpoints(biomeMap, rng, 6);
    if (waypoints.length < 3) continue;
    const carved = carveRoad(waypoints, biomeMap);
    if (carved && carved.length >= 8) roadCells = carved;
  }
  if (!roadCells) {
    // Last-ditch square loop centred on the grid.
    const cx = Math.floor(GRID_SIZE / 2), cy = Math.floor(GRID_SIZE / 2);
    const R = 8;
    roadCells = [];
    for (let x = -R; x <= R; x++) roadCells.push({ gx: cx + x, gy: cy - R });
    for (let y = -R + 1; y <= R; y++) roadCells.push({ gx: cx + R, gy: cy + y });
    for (let x = R - 1; x >= -R; x--) roadCells.push({ gx: cx + x, gy: cy + R });
    for (let y = R - 1; y >= -R + 1; y--) roadCells.push({ gx: cx - R, gy: cy + y });
  }

  // 4. Pick a START INDEX along the carved path that:
  //    a) has at least 3 cells of straight axial road ahead;
  //    b) sits far enough from the grid edge that a 6×5 start zone fits.
  // Then rotate roadCells so the start cell is at index 0.
  const startIdx = findStartIndex(roadCells);
  roadCells = roadCells.slice(startIdx).concat(roadCells.slice(0, startIdx));

  // Establish the start direction (axial). roadCells[0] → roadCells[1].
  const startCell = roadCells[0];
  const nextCell  = roadCells[1] || roadCells[0];
  const fwdX = Math.sign(nextCell.gx - startCell.gx);
  const fwdY = Math.sign(nextCell.gy - startCell.gy);
  const perpX = -fwdY;
  const perpY = fwdX;

  // 5. Dilate the road into a multi-cell-wide area.
  const widthPhase = rng() * Math.PI * 2;
  const widthFreq = 2 + Math.floor(rng() * 3);
  const radiusFor = (i) => {
    const t = i / Math.max(1, roadCells.length);
    const wave = Math.sin(t * Math.PI * 2 * widthFreq + widthPhase);
    const r = 2 + wave * 1.0 + ((rng() < 0.05) ? 1 : 0);
    return Math.max(1, Math.min(3, Math.round(r)));
  };
  const { set: roadCellSet, cells: dilatedCells } = dilateRoadCells(roadCells, radiusFor);

  // 5b. Force the START ZONE — a 6-cell-wide × 5-cell-deep axially-aligned
  // patch of road centred on the start cell. Guarantees that 8 cars
  // arranged in 4 columns × 2 rows behind the start line all sit on road
  // tiles, regardless of how thin or curvy the road is elsewhere.
  for (let p = -3; p <= 2; p++) {           // 6 cells wide (perpendicular)
    for (let f = -3; f <= 1; f++) {         // 5 cells deep (along forward)
      const gx = startCell.gx + fwdX * f + perpX * p;
      const gy = startCell.gy + fwdY * f + perpY * p;
      if (gx < 0 || gx >= GRID_SIZE || gy < 0 || gy >= GRID_SIZE) continue;
      const k = `${gx},${gy}`;
      if (!roadCellSet.has(k)) {
        roadCellSet.add(k);
        dilatedCells.push({ gx, gy });
      }
    }
  }

  // 5. Auto-tile the road area + bake wall segments from non-road neighbours.
  const tilePlacements = autotileRoad(dilatedCells, 'pavement');
  for (const p of tilePlacements) {
    if (p.gy < 0 || p.gy >= GRID_SIZE || p.gx < 0 || p.gx >= GRID_SIZE) continue;
    const b = biomeMap.map[p.gy][p.gx];
    if (b === FOREST) p.roadType = 'gravel';
  }
  // wallSegments + outputTiles will be computed after metaMap is built (we
  // need the full meta-grid to read corner biomes for every output tile).
  let outputTiles = [];
  let wallSegments = [];

  // 6. Start tile = roadCells[0] (after the rotation above). Facing
  // direction = the axial fwd vector computed earlier.
  const startWorld = cellToWorld(startCell.gx, startCell.gy);
  const startTangent = { x: fwdX, y: fwdY };
  const startNormal  = { x: perpX, y: perpY };

  // 7. Lap checkpoints — 8 specific tiles along the carved path. A car
  // "hits" a checkpoint by entering its cell; no segment intersection
  // tests, no perpendicular geometry.
  const numCp = 8;
  const cpStep = Math.max(1, Math.floor(roadCells.length / numCp));
  const checkpoints = [];
  for (let i = 0; i < numCp; i++) {
    const idx = (i * cpStep) % roadCells.length;
    const c = roadCells[idx];
    const w = cellToWorld(c.gx, c.gy);
    checkpoints.push({
      gx: c.gx, gy: c.gy,
      cx: w.x, cy: w.y,
      index: i,
    });
  }

  // 8. Pickup slots — every ~12th cell along the original carved road,
  // placed at the cell centre. No more "perpendicular offset" — the wide
  // road is so big a centred pickup still feels like it's on the racing line.
  const pickupSlots = [];
  const pickupStep = 12;
  for (let i = 0; i < roadCells.length; i += pickupStep) {
    const w = cellToWorld(roadCells[i].gx, roadCells[i].gy);
    pickupSlots.push({ x: w.x, y: w.y });
  }

  // 9. Biome cells for the renderer (per non-road meta-cell).
  const biomeCells = [];
  const metaMap = new Array(GRID_SIZE);
  for (let gy = 0; gy < GRID_SIZE; gy++) {
    metaMap[gy] = new Array(GRID_SIZE);
    for (let gx = 0; gx < GRID_SIZE; gx++) {
      const isRoad = roadCellSet.has(`${gx},${gy}`);
      const baseBiome = biomeMap.map[gy][gx];
      metaMap[gy][gx] = isRoad ? ROAD : baseBiome;
      const w = cellToWorld(gx, gy);
      biomeCells.push({
        gx, gy,
        cx: w.x, cy: w.y,
        biome: baseBiome,
        elev: biomeMap.elevation[gy][gx],
        isRoad,
      });
    }
  }

  // 10. Half-offset output tiles — paint the actual rendered grid from
  // the meta-map. Each output tile reads 4 surrounding meta-cells and
  // emits the wall segments inside itself based on the 4-corner road
  // pattern (16 cases). Adjacent output tiles share two corners, so
  // their walls join automatically at the shared midpoints.
  outputTiles = buildOutputTiles(metaMap, GRID_SIZE);
  wallSegments = [];
  for (const t of outputTiles) {
    for (const w of t.walls) wallSegments.push(w);
  }

  // 11. World bounds.
  const bounds = {
    minX: -WORLD_HALF, minY: -WORLD_HALF,
    maxX:  WORLD_HALF, maxY:  WORLD_HALF,
  };

  return {
    seed,
    metaMap,
    biomeCells,
    tilePlacements,
    outputTiles,
    wallSegments,
    gridSize: GRID_SIZE,
    cellSize: CELL_SIZE,
    start: {
      x: startWorld.x, y: startWorld.y,
      gx: startCell.gx, gy: startCell.gy,
      tx: startTangent.x, ty: startTangent.y,
      nx: startNormal.x,  ny: startNormal.y,
    },
    checkpoints,
    pickupSlots,
    bounds,
  };
}

// Spawn the 4-wide grid behind the start cell along the road's incoming
// direction (-tangent). All distances in metres.
// Spawn 8 cars in a 4-wide × 2-deep grid behind the start cell. All slots
// sit on road tiles thanks to the start-zone enforcement in generateTrack.
export function gridSpawnPositions(track, count) {
  const { start } = track;
  const slots = [];
  const COLS = 4;
  const colSpacing = 3.5;          // 14 m total span across 4 cars
  const rowSpacing = 5.5;           // ~1.5 cells of forward depth per row
  const firstRowBack = 6;           // first row 6 m back from start cell centre
  const colOffset = -(COLS - 1) / 2;
  for (let i = 0; i < count; i++) {
    const colIdx = i % COLS;
    const rowIdx = Math.floor(i / COLS);
    const back = -(firstRowBack + rowSpacing * rowIdx);
    const side = (colOffset + colIdx) * colSpacing;
    const x = start.x + start.tx * back + start.nx * side;
    const y = start.y + start.ty * back + start.ny * side;
    const angle = Math.atan2(start.ty, start.tx);
    slots.push({ x, y, angle });
  }
  return slots;
}

// Find an index along the road such that the next 3 cells continue in the
// same axial direction AND the cell is at least 4 cells away from any grid
// edge (so the 6×5 start zone fits). Returns 0 on failure.
function findStartIndex(roadCells) {
  const margin = 4;
  const N = roadCells.length;
  for (let i = 0; i < N; i++) {
    const a = roadCells[i];
    const b = roadCells[(i + 1) % N];
    const c = roadCells[(i + 2) % N];
    const d = roadCells[(i + 3) % N];
    const dx = b.gx - a.gx;
    const dy = b.gy - a.gy;
    if (Math.abs(dx) + Math.abs(dy) !== 1) continue;
    if (c.gx - b.gx !== dx || c.gy - b.gy !== dy) continue;
    if (d.gx - c.gx !== dx || d.gy - c.gy !== dy) continue;
    if (a.gx < margin || a.gx >= GRID_SIZE - margin) continue;
    if (a.gy < margin || a.gy >= GRID_SIZE - margin) continue;
    return i;
  }
  return 0;
}
