// Track generator (tile-grid native).
//
// Grid cells are the PRIMARY data representation. Connectors emit chains
// of cells; the assembled chain forms a closed cycle. From the cells we
// derive:
//   - tile placements (per-cell { type, rotation, roadType, cx, cy })
//   - a centerline polyline (cell centres, one Chaikin smoothing pass)
//   - per-vertex widths (from each cell's road type)
//   - physics CSG trapezoids (from centerline + widths, used by clampToTrack)
//   - checkpoints, pickup slots, world bounds
//
// The polyline is a derivative. It is NOT used to choose tile shapes —
// tile shapes are chosen from each cell's grid neighbours.

import { mulberry32, rfloat } from './rng.js';
import { CONNECTORS, pickConnector } from './connectors.js';
import { CELL_SIZE, buildFromCellChain, chaikinClosed, expandWidths } from './tiles.js';

const ROAD_TYPES = ['pavement', 'gravel', 'ice'];

// ---- Anchor layout (in cells) -------------------------------------------

function buildAnchorCells(rng) {
  const N = 8 + Math.floor(rng() * 4);     // 8–11 anchor cells
  // Base radius in CELLS, not metres.
  const baseR = 22;
  const radJitter = 6;
  const anchors = [];
  for (let i = 0; i < N; i++) {
    const angle = (i / N) * Math.PI * 2 + rfloat(rng, -0.12, 0.12);
    const r = baseR + rfloat(rng, -radJitter, radJitter);
    anchors.push({
      gx: Math.round(Math.cos(angle) * r),
      gy: Math.round(Math.sin(angle) * r),
    });
  }
  return anchors;
}

// ---- Entry --------------------------------------------------------------

export function generateTrack(seed) {
  const rng = mulberry32(seed >>> 0);

  // 1. Anchor cells around the origin.
  const anchors = buildAnchorCells(rng);
  const N = anchors.length;

  // 2. For each consecutive anchor pair, pick a connector and a road type.
  //    Each connector returns a 4-connected chain of cells from A to B.
  const cellSegments = [];          // [{cells, roadType, connectorKind}]
  for (let i = 0; i < N; i++) {
    const a = anchors[i];
    const b = anchors[(i + 1) % N];
    const segCells = Math.abs(a.gx - b.gx) + Math.abs(a.gy - b.gy);
    const connector = pickConnector(rng, segCells);
    const roadType = ROAD_TYPES[Math.floor(rng() * ROAD_TYPES.length)];
    const cells = connector(a, b, rng).map(c => ({ ...c, roadType }));
    cellSegments.push({ cells, roadType, connectorKind: connector.kind });
  }

  // 3. Concatenate all segments into one closed cell chain. Trim the
  //    first cell of each segment (except the very first) to avoid
  //    duplicating anchors.
  const chain = [];
  for (let i = 0; i < cellSegments.length; i++) {
    const cells = cellSegments[i].cells;
    const start = (i === 0) ? 0 : 1;
    for (let j = start; j < cells.length; j++) chain.push(cells[j]);
  }
  // Final dedupe: if the very last cell equals the first, drop it.
  if (chain.length > 1
      && chain[0].gx === chain[chain.length - 1].gx
      && chain[0].gy === chain[chain.length - 1].gy) {
    chain.pop();
  }
  // Also remove any other consecutive duplicates that snuck through.
  const deduped = [];
  for (const c of chain) {
    if (!deduped.length || deduped[deduped.length - 1].gx !== c.gx || deduped[deduped.length - 1].gy !== c.gy) {
      deduped.push(c);
    }
  }

  // 4. Build placements + centerline + widths from the cell chain.
  const { placements, centerline: rawCenterline, widths: rawWidths } = buildFromCellChain(deduped);

  // 5. Smooth the centerline (one Chaikin pass softens cell-elbow corners).
  let centerline = chaikinClosed(rawCenterline);
  let widths = expandWidths(rawWidths);

  // Widen the start area so the 4-wide spawn grid fits comfortably.
  const startMin = 22;
  const startRange = Math.min(20, centerline.length);
  for (let i = 0; i < startRange; i++) {
    const backIdx = (centerline.length - i) % centerline.length;
    widths[i] = Math.max(widths[i], startMin);
    widths[backIdx] = Math.max(widths[backIdx], startMin);
  }

  // 6. Start / finish vector — tangent at centerline[0].
  const start = centerline[0];
  const startTangent = normalize({
    x: centerline[1].x - centerline[centerline.length - 1].x,
    y: centerline[1].y - centerline[centerline.length - 1].y,
  });
  const startNormal = { x: -startTangent.y, y: startTangent.x };

  // 7. Checkpoints — 8 evenly spaced.
  const numCheckpoints = 8;
  const cpStep = Math.floor(centerline.length / numCheckpoints);
  const checkpoints = [];
  for (let i = 0; i < numCheckpoints; i++) {
    const idx = (i * cpStep) % centerline.length;
    const cp = centerline[idx];
    const prev = centerline[(idx - 1 + centerline.length) % centerline.length];
    const next = centerline[(idx + 1) % centerline.length];
    const tx = next.x - prev.x, ty = next.y - prev.y;
    const tl = Math.hypot(tx, ty) || 1;
    const nx = -ty / tl, ny = tx / tl;
    const w = widths[idx] / 2;
    checkpoints.push({
      cx: cp.x, cy: cp.y,
      ax: cp.x + nx * w, ay: cp.y + ny * w,
      bx: cp.x - nx * w, by: cp.y - ny * w,
      index: idx,
    });
  }

  // 8. Pickup slots — every ~20 centerline points, alternating sides.
  const pickupSlots = [];
  const pickupStep = 22;
  for (let i = 0; i < centerline.length; i += pickupStep) {
    const p = centerline[i];
    const prev = centerline[(i - 1 + centerline.length) % centerline.length];
    const next = centerline[(i + 1) % centerline.length];
    const tx = next.x - prev.x, ty = next.y - prev.y;
    const tl = Math.hypot(tx, ty) || 1;
    const nx = -ty / tl, ny = tx / tl;
    const off = widths[i] * 0.20 * ((i % (pickupStep * 2) === 0) ? 1 : -1);
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
      ux, uy, nx, ny,
      len, wA, wB,
    });
  }

  // Minimap inner/outer (cheap derivation).
  const inner = phyTiles.map(t => ({ x: t.al.x, y: t.al.y }));
  const outer = phyTiles.map(t => ({ x: t.ar.x, y: t.ar.y }));

  // 10. World bounds.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of phyTiles) {
    for (const c of [t.al, t.ar, t.bl, t.br]) {
      if (c.x < minX) minX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.x > maxX) maxX = c.x;
      if (c.y > maxY) maxY = c.y;
    }
  }
  const pad = 12;
  const bounds = {
    minX: minX - pad, minY: minY - pad,
    maxX: maxX + pad, maxY: maxY + pad,
  };

  // 11. Section summary for the log line.
  const sections = cellSegments.map(s => ({
    connector: s.connectorKind,
    roadType: s.roadType,
  }));

  return {
    seed,
    centerline,
    widths,
    tiles: phyTiles,
    tilePlacements: placements,
    cellSize: CELL_SIZE,
    inner,
    outer,
    sections,
    start: {
      x: start.x, y: start.y,
      tx: startTangent.x, ty: startTangent.y,
      nx: startNormal.x, ny: startNormal.y,
      width: widths[0],
    },
    checkpoints,
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
