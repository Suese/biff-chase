// Tile-based track generator.
//
// A closed-loop track is built in three layers:
//
//  1. SECTIONS: a closed ring of ~10 anchor points around the origin
//     defines the rough shape. Each consecutive pair of anchors becomes
//     a "section" with its own bounding rectangle, a chosen CONNECTOR
//     algorithm (winding, bezier sweep, maze, etc.), and a ROAD TYPE
//     (pavement / gravel / ice).
//
//  2. CENTERLINE: each section's connector emits a polyline between its
//     start and end anchors; the polylines are concatenated and lightly
//     smoothed to make a single closed centerline.
//
//  3. TILES: the centerline is walked on a 4 m grid; each visited cell
//     gets a tile (straight / corner / dual) chosen by which two edges of
//     the cell the line enters and exits. The tile placer also tags the
//     cell with the section's road type.
//
// Physics-side (clampToTrack) still consumes the trapezoid `tiles` derived
// from the centerline + widths. Cosmetics come from `tilePlacements`.

import { mulberry32, rfloat } from './rng.js';
import { CONNECTORS, pickConnector } from './connectors.js';
import { CELL_SIZE, placeTiles } from './tiles.js';

const ROAD_TYPES = ['pavement', 'gravel', 'ice'];

// ---- Section layout ------------------------------------------------------

function buildAnchors(rng) {
  const N = 9 + Math.floor(rng() * 4);   // 9–12 sections
  const baseR = 95;
  const radJitter = 28;
  const angularJitter = 0.18;
  const anchors = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + rfloat(rng, -angularJitter, angularJitter);
    const r = baseR + rfloat(rng, -radJitter, radJitter);
    anchors.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return anchors;
}

// A section's bounding rectangle is the AABB of its start/end with a margin.
function sectionBounds(start, end) {
  const margin = 14;
  return {
    minX: Math.min(start.x, end.x) - margin,
    minY: Math.min(start.y, end.y) - margin,
    maxX: Math.max(start.x, end.x) + margin,
    maxY: Math.max(start.y, end.y) + margin,
  };
}

// ---- Width / surface helpers --------------------------------------------

function widthsForCenterline(pts, rng) {
  const widthBase = 16;
  const widthVar  = 4;
  const phase = rng() * Math.PI * 2;
  const freq = 3 + Math.floor(rng() * 3);
  const widths = pts.map((_, i) => {
    const t = (i / pts.length) * Math.PI * 2;
    return widthBase + Math.sin(t * freq + phase) * widthVar;
  });
  // Guarantee start width for the 4-wide grid.
  const startMin = 22;
  const startRange = 16;
  for (let i = 0; i < startRange; i++) {
    const back = (pts.length - i) % pts.length;
    widths[i] = Math.max(widths[i], startMin);
    widths[back] = Math.max(widths[back], startMin);
  }
  return widths;
}

// ---- Maths ---------------------------------------------------------------

function chaikinClosed(pts) {
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

function resampleByArc(pts, spacing) {
  const out = [];
  let acc = 0;
  out.push(pts[0]);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const seg = Math.hypot(dx, dy);
    let t = 0;
    while (acc + seg - t >= spacing) {
      const need = spacing - acc;
      t += need;
      acc = 0;
      const u = t / seg;
      out.push({ x: a.x + dx * u, y: a.y + dy * u });
    }
    acc += seg - t;
  }
  return out;
}

function normalize(v) {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
}

// ---- Entry point ---------------------------------------------------------

export function generateTrack(seed) {
  const rng = mulberry32(seed >>> 0);

  // 1. Anchors → sections.
  const anchors = buildAnchors(rng);
  const N = anchors.length;
  const sections = [];
  for (let i = 0; i < N; i++) {
    const start = anchors[i];
    const end = anchors[(i + 1) % N];
    const segLen = Math.hypot(end.x - start.x, end.y - start.y);
    const connector = pickConnector(rng, segLen);
    const roadType = ROAD_TYPES[Math.floor(rng() * ROAD_TYPES.length)];
    sections.push({
      start, end,
      connector,
      roadType,
      bounds: sectionBounds(start, end),
    });
  }

  // 2. Centerline assembly. Track which centerline indices belong to each
  // section so the tile placer can tag them with the right road type.
  const ctrl = [];
  const sectionForIndex = [];   // parallel to `ctrl`
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (i === 0) {
      ctrl.push(s.start);
      sectionForIndex.push(0);
    }
    const inter = s.connector(s.start, s.end, s.bounds, rng);
    for (const p of inter) {
      ctrl.push(p);
      sectionForIndex.push(i);
    }
  }

  // Light Chaikin smoothing softens section joins. We re-derive the
  // parallel section index by nearest-neighbour-along-arc after smoothing.
  let pts = chaikinClosed(ctrl);

  // Re-index sectionForIndex against the smoothed pts. Each smoothed point
  // came from a pair of consecutive ctrl points; reuse the earlier section.
  let smoothedSection = [];
  for (let i = 0; i < pts.length; i++) {
    smoothedSection.push(sectionForIndex[Math.floor(i / 2) % sectionForIndex.length]);
  }

  // Resample at 3 m — same parallel-array trick.
  const beforeLen = pts.length;
  pts = resampleByArc(pts, 3);
  const afterLen = pts.length;
  const stride = beforeLen / afterLen;
  const finalSectionForIndex = pts.map((_, i) => smoothedSection[Math.min(beforeLen - 1, Math.floor(i * stride))]);

  // 3. Widths + start vector + checkpoints.
  const widths = widthsForCenterline(pts, rng);

  const start = pts[0];
  const startTangent = normalize({
    x: pts[1].x - pts[pts.length - 1].x,
    y: pts[1].y - pts[pts.length - 1].y,
  });
  const startNormal = { x: -startTangent.y, y: startTangent.x };

  // Checkpoints — evenly spaced.
  const numCheckpoints = 8;
  const cpStep = Math.floor(pts.length / numCheckpoints);
  const checkpoints = [];
  for (let i = 0; i < numCheckpoints; i++) {
    const idx = (i * cpStep) % pts.length;
    const cp = pts[idx];
    const prev = pts[(idx - 1 + pts.length) % pts.length];
    const next = pts[(idx + 1) % pts.length];
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

  // Pickups — every ~75 m of track.
  const pickupSlots = [];
  const pickupStep = 25;
  for (let i = 0; i < pts.length; i += pickupStep) {
    const p = pts[i];
    const prev = pts[(i - 1 + pts.length) % pts.length];
    const next = pts[(i + 1) % pts.length];
    const tx = next.x - prev.x, ty = next.y - prev.y;
    const tl = Math.hypot(tx, ty) || 1;
    const nx = -ty / tl, ny = tx / tl;
    const off = widths[i] * 0.20 * ((i % (pickupStep * 2) === 0) ? 1 : -1);
    pickupSlots.push({ x: p.x + nx * off, y: p.y + ny * off });
  }

  // Physics CSG trapezoids.
  const phyTiles = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
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

  // Legacy inner/outer (still used by minimap).
  const inner = phyTiles.map(t => ({ x: t.al.x, y: t.al.y }));
  const outer = phyTiles.map(t => ({ x: t.ar.x, y: t.ar.y }));

  // World bounds.
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

  // 4. Tile placements for rendering. Each cell gets a tile chosen by the
  // edges where the centerline enters/exits, tagged with its section's
  // road type.
  const tilePlacements = placeTiles(pts, (idx) => sections[finalSectionForIndex[idx]].roadType);

  // Mark sections in the snapshot for client logging.
  const sectionSummary = sections.map(s => ({ connector: s.connector.kind, roadType: s.roadType }));

  return {
    seed,
    centerline: pts,
    widths,
    tiles: phyTiles,            // physics-side CSG trapezoids
    tilePlacements,             // render-side half-tile placements
    cellSize: CELL_SIZE,
    inner,
    outer,
    sections: sectionSummary,
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

// ---- Grid spawn -- unchanged ---------------------------------------------

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
