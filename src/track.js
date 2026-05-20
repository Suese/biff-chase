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
import { autotileRoad, dilateRoadCells, wallSegmentsFromTiles } from './tiles.js';

export function generateTrack(seed) {
  const rng = mulberry32(seed >>> 0);

  // 1. Biome map.
  const biomeMap = generateBiomeMap(seed);

  // 2. Checkpoints (road waypoints).
  let waypoints = pickCheckpoints(biomeMap, rng, 6);
  if (waypoints.length < 3) waypoints = pickCheckpoints(biomeMap, rng, 4);

  // 3. A* carving.
  let roadCells = carveRoad(waypoints, biomeMap);
  if (roadCells.length < 8) {
    // Fallback square loop in case the noise produced an unraceable map.
    const cx = Math.floor(GRID_SIZE / 2), cy = Math.floor(GRID_SIZE / 2);
    const R = 8;
    roadCells = [];
    for (let x = -R; x <= R; x++) roadCells.push({ gx: cx + x, gy: cy - R });
    for (let y = -R + 1; y <= R; y++) roadCells.push({ gx: cx + R, gy: cy + y });
    for (let x = R - 1; x >= -R; x--) roadCells.push({ gx: cx + x, gy: cy + R });
    for (let y = R - 1; y >= -R + 1; y--) roadCells.push({ gx: cx - R, gy: cy + y });
  }

  // 4. Dilate the road into a multi-cell-wide area. Width varies along the
  // path (1..3 cell radius → 3..7 tiles wide).
  const widthPhase = rng() * Math.PI * 2;
  const widthFreq = 2 + Math.floor(rng() * 3);
  const radiusFor = (i) => {
    const t = i / Math.max(1, roadCells.length);
    const wave = Math.sin(t * Math.PI * 2 * widthFreq + widthPhase);
    const r = 2 + wave * 1.0 + ((rng() < 0.05) ? 1 : 0);
    return Math.max(1, Math.min(3, Math.round(r)));
  };
  const { set: roadCellSet, cells: dilatedCells } = dilateRoadCells(roadCells, radiusFor);

  // 5. Auto-tile the road area + bake wall segments from non-road neighbours.
  const tilePlacements = autotileRoad(dilatedCells, 'pavement');
  for (const p of tilePlacements) {
    if (p.gy < 0 || p.gy >= GRID_SIZE || p.gx < 0 || p.gx >= GRID_SIZE) continue;
    const b = biomeMap.map[p.gy][p.gx];
    if (b === FOREST) p.roadType = 'gravel';
  }
  const wallSegments = wallSegmentsFromTiles(tilePlacements);

  // 6. Start tile = the first road cell (along the original carved path).
  // Facing direction = vector from start cell toward the next cell on the
  // carved path so the car points down the road.
  const startCell = roadCells[0];
  const nextCell  = roadCells[1] || roadCells[0];
  const startWorld = cellToWorld(startCell.gx, startCell.gy);
  const tx = nextCell.gx - startCell.gx;
  const ty = nextCell.gy - startCell.gy;
  const tLen = Math.hypot(tx, ty) || 1;
  const startTangent = { x: tx / tLen, y: ty / tLen };
  const startNormal  = { x: -startTangent.y, y: startTangent.x };

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

  // 10. World bounds.
  const bounds = {
    minX: -WORLD_HALF, minY: -WORLD_HALF,
    maxX:  WORLD_HALF, maxY:  WORLD_HALF,
  };

  return {
    seed,
    metaMap,
    biomeCells,
    tilePlacements,
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
export function gridSpawnPositions(track, count) {
  const { start } = track;
  const slots = [];
  const COLS = 4;
  const colSpacing = 3.5;
  const rowSpacing = 6;
  const colOffset = -(COLS - 1) / 2;
  for (let i = 0; i < count; i++) {
    const colIdx = i % COLS;
    const rowIdx = Math.floor(i / COLS);
    const back = -rowSpacing * (rowIdx + 1);
    const side = (colOffset + colIdx) * colSpacing;
    const x = start.x + start.tx * back + start.nx * side;
    const y = start.y + start.ty * back + start.ny * side;
    const angle = Math.atan2(start.ty, start.tx);
    slots.push({ x, y, angle });
  }
  return slots;
}
