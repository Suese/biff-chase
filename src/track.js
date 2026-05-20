// Tile-grid track generator.
//
//   1. Generate a 50×50 biome map with fBM value noise (water / land /
//      forest / mountain).
//   2. Place ~6 checkpoints in a circle, snapped to traversable cells.
//   3. A* between consecutive checkpoints using biome costs (water and
//      mountain blocked, land = 1, forest = 3). The concatenated paths
//      form a closed loop of grid cells — the road.
//   4. Auto-tile the road from its 4-cardinal neighbours into placements
//      (straight / corner / tee / cross) with rotations.
//   5. Derive a smooth centerline for cars + physics (one Chaikin pass on
//      the cell-centre polyline). Trapezoid CSG tiles for clampToTrack
//      come from that centerline + a fixed road width.

import { mulberry32, rfloat } from './rng.js';
import {
  GRID_SIZE, CELL_SIZE, WORLD_HALF,
  generateBiomeMap, pickCheckpoints, carveRoad,
  cellToWorld, WATER, LAND, FOREST, MOUNTAIN,
} from './terrain.js';
import { autotileRoad, centerlineFromCells, chaikinClosed } from './tiles.js';

const ROAD_WIDTH = 10;    // metres

export function generateTrack(seed) {
  const rng = mulberry32(seed >>> 0);

  // 1. Biome map.
  const biomeMap = generateBiomeMap(seed);

  // 2. Checkpoints.
  let checkpoints = pickCheckpoints(biomeMap, rng, 6);
  if (checkpoints.length < 3) {
    // Fall back to fewer if traversable land is sparse.
    checkpoints = pickCheckpoints(biomeMap, rng, 4);
  }

  // 3. A* road carving between consecutive checkpoints (closed loop).
  let roadCells = carveRoad(checkpoints, biomeMap);
  if (roadCells.length < 6) {
    // Last-ditch: a small ring on the grid centre, all land.
    const cx = Math.floor(GRID_SIZE / 2), cy = Math.floor(GRID_SIZE / 2);
    roadCells = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      roadCells.push({ gx: cx + Math.round(Math.cos(a) * 8), gy: cy + Math.round(Math.sin(a) * 8) });
    }
  }

  // 4. Auto-tile the road. Vary road material a bit per section by sampling
  // the biome cost at each cell — land = pavement, forest = gravel — so the
  // track tells you what it's running over.
  const placementsRaw = autotileRoad(roadCells, 'pavement');
  for (const p of placementsRaw) {
    const b = biomeMap.map[p.gy][p.gx];
    if (b === FOREST) p.roadType = 'gravel';
  }

  // 5. Centerline (cell-centre polyline → Chaikin smoothing).
  const rawCenterline = centerlineFromCells(roadCells);
  const centerline = chaikinClosed(rawCenterline);
  const widths = centerline.map(() => ROAD_WIDTH);

  // 6. Start vector at centerline[0].
  const start = centerline[0];
  const startTangent = normalize({
    x: centerline[1].x - centerline[centerline.length - 1].x,
    y: centerline[1].y - centerline[centerline.length - 1].y,
  });
  const startNormal = { x: -startTangent.y, y: startTangent.x };

  // 7. Checkpoint segments for lap detection (8 evenly spaced).
  const numCp = 8;
  const cpStep = Math.floor(centerline.length / numCp);
  const lapCheckpoints = [];
  for (let i = 0; i < numCp; i++) {
    const idx = (i * cpStep) % centerline.length;
    const cp = centerline[idx];
    const prev = centerline[(idx - 1 + centerline.length) % centerline.length];
    const next = centerline[(idx + 1) % centerline.length];
    const tx = next.x - prev.x, ty = next.y - prev.y;
    const tl = Math.hypot(tx, ty) || 1;
    const nx = -ty / tl, ny = tx / tl;
    const w = widths[idx] / 2;
    lapCheckpoints.push({
      cx: cp.x, cy: cp.y,
      ax: cp.x + nx * w, ay: cp.y + ny * w,
      bx: cp.x - nx * w, by: cp.y - ny * w,
      index: idx,
    });
  }

  // 8. Pickup slots — every ~25 centerline vertices.
  const pickupSlots = [];
  const pickupStep = 25;
  for (let i = 0; i < centerline.length; i += pickupStep) {
    const p = centerline[i];
    const prev = centerline[(i - 1 + centerline.length) % centerline.length];
    const next = centerline[(i + 1) % centerline.length];
    const tx = next.x - prev.x, ty = next.y - prev.y;
    const tl = Math.hypot(tx, ty) || 1;
    const nx = -ty / tl, ny = tx / tl;
    const off = widths[i] * 0.22 * ((i % (pickupStep * 2) === 0) ? 1 : -1);
    pickupSlots.push({ x: p.x + nx * off, y: p.y + ny * off });
  }

  // 9. Physics CSG trapezoids.
  const phyTiles = [];
  for (let i = 0; i < centerline.length; i++) {
    const a = centerline[i];
    const b = centerline[(i + 1) % centerline.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const nx = -uy, ny = ux;
    const wA = widths[i] / 2;
    const wB = widths[(i + 1) % widths.length] / 2;
    phyTiles.push({
      al: { x: a.x + nx * wA, y: a.y + ny * wA },
      ar: { x: a.x - nx * wA, y: a.y - ny * wA },
      bl: { x: b.x + nx * wB, y: b.y + ny * wB },
      br: { x: b.x - nx * wB, y: b.y - ny * wB },
      ax: a.x, ay: a.y, bx: b.x, by: b.y,
      ux, uy, nx, ny, len, wA, wB,
    });
  }

  const inner = phyTiles.map(t => ({ x: t.al.x, y: t.al.y }));
  const outer = phyTiles.map(t => ({ x: t.ar.x, y: t.ar.y }));

  // 10. World bounds — full biome map (so the camera can see everything).
  const bounds = {
    minX: -WORLD_HALF, minY: -WORLD_HALF,
    maxX:  WORLD_HALF, maxY:  WORLD_HALF,
  };

  // 11. Biome cell data for the renderer (one entry per non-road cell).
  const biomeCells = [];
  const roadKey = new Set(roadCells.map(c => `${c.gx},${c.gy}`));
  for (let gy = 0; gy < GRID_SIZE; gy++) {
    for (let gx = 0; gx < GRID_SIZE; gx++) {
      const isRoad = roadKey.has(`${gx},${gy}`);
      const world = cellToWorld(gx, gy);
      biomeCells.push({
        gx, gy,
        cx: world.x, cy: world.y,
        biome: biomeMap.map[gy][gx],
        elev: biomeMap.elevation[gy][gx],
        isRoad,
      });
    }
  }

  return {
    seed,
    centerline,
    widths,
    tiles: phyTiles,
    tilePlacements: placementsRaw,
    biomeCells,
    gridSize: GRID_SIZE,
    cellSize: CELL_SIZE,
    inner,
    outer,
    sections: [],            // legacy field — empty now
    start: {
      x: start.x, y: start.y,
      tx: startTangent.x, ty: startTangent.y,
      nx: startNormal.x, ny: startNormal.y,
      width: widths[0],
    },
    checkpoints: lapCheckpoints,
    pickupSlots,
    bounds,
  };
}

function normalize(v) {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
}

// Grid spawn — unchanged.
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
