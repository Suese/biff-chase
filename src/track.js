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
import { flatRoadPlacements, centerlineFromCells, dilateRoadCells, buildOutputTiles, annotateWalls } from './tiles.js';
import { ROAD } from './terrain.js';

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
  // carveRoad already dedupes globally and excludes used cells on each run
  // so no two road cells can share the same (gx, gy).
  let roadCells = carveRoad(checkpoints, biomeMap);
  if (roadCells.length < 6) {
    // Last-ditch fallback: a small square ring on the grid centre.
    const cx = Math.floor(GRID_SIZE / 2), cy = Math.floor(GRID_SIZE / 2);
    const R = 8;
    roadCells = [];
    for (let x = -R; x <= R; x++) roadCells.push({ gx: cx + x, gy: cy - R });
    for (let y = -R + 1; y <= R; y++) roadCells.push({ gx: cx + R, gy: cy + y });
    for (let x = R - 1; x >= -R; x--) roadCells.push({ gx: cx + x, gy: cy + R });
    for (let y = R - 1; y >= -R + 1; y--) roadCells.push({ gx: cx - R, gy: cy + y });
  }

  // 4. Per-centerline-cell width. We pick a base radius (in cells) that
  // varies along the path with a slow sinusoid + a touch of noise so the
  // road feels like it widens into pit lanes and narrows through forest
  // pinches. Radius 1 = 3 tiles wide (12 m); radius 3 = 7 tiles (28 m).
  const widthPhase = rng() * Math.PI * 2;
  const widthFreq = 2 + Math.floor(rng() * 3);
  const radiusFor = (i) => {
    const t = i / Math.max(1, roadCells.length);
    const wave = Math.sin(t * Math.PI * 2 * widthFreq + widthPhase);
    // 1..3 base + sometimes pushes up to 4 (= 9 tiles, max-wide section)
    const r = 2 + wave * 1.2 + ((rng() < 0.06) ? 1 : 0);
    return Math.max(1, Math.min(4, Math.round(r)));
  };
  const { set: roadCellSet, cells: dilatedCells, widths: cellWidthsM } =
    dilateRoadCells(roadCells, radiusFor);

  // 5. Centerline = exact cell-centre polyline (no curve smoothing).
  const centerline = centerlineFromCells(roadCells);
  const widths = cellWidthsM;

  // 6. Road tile placements: every dilated cell becomes a flat road plate.
  // Material per cell: forest cells stay gravel, ice/pavement use seed-based
  // choice so each track has personality.
  const placementsRaw = flatRoadPlacements(dilatedCells, 'pavement');
  for (const p of placementsRaw) {
    if (p.gy < 0 || p.gy >= GRID_SIZE || p.gx < 0 || p.gx >= GRID_SIZE) continue;
    const b = biomeMap.map[p.gy][p.gx];
    if (b === FOREST) p.roadType = 'gravel';
  }

  // 7. Start vector at centerline[0].
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

  // 11. Biome cell data + the unified metaMap (with road as a 5th biome)
  // that the output-tile system reads from.
  const biomeCells = [];
  const metaMap = new Array(GRID_SIZE);
  for (let gy = 0; gy < GRID_SIZE; gy++) {
    metaMap[gy] = new Array(GRID_SIZE);
    for (let gx = 0; gx < GRID_SIZE; gx++) {
      const isRoad = roadCellSet.has(`${gx},${gy}`);
      const baseBiome = biomeMap.map[gy][gx];
      const effective = isRoad ? ROAD : baseBiome;
      metaMap[gy][gx] = effective;
      const world = cellToWorld(gx, gy);
      biomeCells.push({
        gx, gy,
        cx: world.x, cy: world.y,
        biome: baseBiome,
        elev: biomeMap.elevation[gy][gx],
        isRoad,
      });
    }
  }

  // 12. Half-offset output tiles — the actual rendered surface. Walls
  // belong to the tiles, not as a separate pass. annotateWalls() picks
  // which walls actually render/collide so sections of the track have
  // gaps instead of being continuous walls.
  const outputTiles = buildOutputTiles(metaMap);
  annotateWalls(outputTiles);

  // Flatten the present walls so physics can build static bodies from them.
  const wallSegments = [];
  for (const t of outputTiles) {
    for (const w of t.walls) {
      if (w.present) wallSegments.push(w);
    }
  }

  return {
    seed,
    centerline,
    widths,
    tiles: phyTiles,
    tilePlacements: placementsRaw,
    biomeCells,
    outputTiles,
    wallSegments,
    metaMap,
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
