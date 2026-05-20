// Procedural closed-loop track generator.
//
// The centerline is built by jittering N points on a circle, then smoothed by
// chaikin subdivision into a closed polyline. Track width is sampled per
// vertex with a slow noise so straights feel wide and chicanes feel tight.
// Walls are offset polylines; checkpoints are evenly-spaced segments crossed
// in order for lap detection.

import { mulberry32, rfloat } from './rng.js';

export function generateTrack(seed) {
  const rng = mulberry32(seed >>> 0);

  // Polygon-based centerline. All distances in METRES.
  //   baseR ≈ 75m radius — roughly a 150m × 150m track footprint.
  //   radJitter ≈ ±25m for shape variety.
  const N = 16 + Math.floor(rng() * 5);
  const baseR = 75;
  const radJitter = 25;
  const ctrl = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + rfloat(rng, -0.08, 0.08);
    const r = baseR + rfloat(rng, -radJitter, radJitter);
    ctrl.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }

  // One Chaikin pass — barely rounds the polygon corners, keeps the angles.
  let pts = chaikinClosed(ctrl);

  // Fine resampling — 3m between centerline vertices. Many small bends mean
  // the offset polyline used to build the road ring rarely hits the miter
  // clamp, so the edges are smooth.
  pts = resampleByArc(pts, 3);

  // Track width — 12m base, ±2m variation. Wide enough for a 4-wide grid
  // (cars 1.8m wide, gaps 1.7m → 14m needed; we force ≥14m near the start).
  const widthBase = 12;
  const widthVar  = 2;
  const phase     = rng() * Math.PI * 2;
  const widthFreq = 3 + Math.floor(rng() * 3);
  const widths = pts.map((_, i) => {
    const t = (i / pts.length) * Math.PI * 2;
    return widthBase + Math.sin(t * widthFreq + phase) * widthVar;
  });
  const startMin = 14;
  const startRange = 10;
  for (let i = 0; i < startRange; i++) {
    const idxBack = (pts.length - i) % pts.length;
    widths[i] = Math.max(widths[i], startMin);
    widths[idxBack] = Math.max(widths[idxBack], startMin);
  }

  // CSG-style track: a UNION of per-segment trapezoid tiles. Each tile is
  // perpendicular to its own segment (no bisector), so sharp turns just have
  // overlapping tiles where neighbours meet — no offset-polyline blow-up.
  const tiles = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;        // left-perpendicular in math coords
    const ny =  ux;
    const wA = widths[i] / 2;
    const wB = widths[(i + 1) % widths.length] / 2;
    tiles.push({
      al: { x: a.x + nx * wA, y: a.y + ny * wA },
      ar: { x: a.x - nx * wA, y: a.y - ny * wA },
      bl: { x: b.x + nx * wB, y: b.y + ny * wB },
      br: { x: b.x - nx * wB, y: b.y - ny * wB },
      ax: a.x, ay: a.y,
      bx: b.x, by: b.y,
      ux, uy, nx, ny,
      len, wA, wB,
    });
  }

  // Inner/outer offset polylines kept around for the minimap (visual only;
  // they have artifacts at sharp corners but the minimap is forgiving).
  const inner = [];
  const outer = [];
  for (let i = 0; i < pts.length; i++) {
    const t = tiles[i];
    inner.push({ x: t.al.x, y: t.al.y });
    outer.push({ x: t.ar.x, y: t.ar.y });
  }

  // Start/finish: take the segment between pts[0] and pts[1] perpendicular,
  // place spawn slots offset back from the line.
  const start = pts[0];
  const startTangent = normalize({
    x: pts[1].x - pts[pts.length - 1].x,
    y: pts[1].y - pts[pts.length - 1].y,
  });
  const startNormal = { x: -startTangent.y, y: startTangent.x };
  const startWidth = widths[0];

  // Checkpoints — every K vertices. We need lap detection to verify the player
  // crossed each in order before counting the finish line.
  const numCheckpoints = 8;
  const step = Math.floor(pts.length / numCheckpoints);
  const checkpoints = [];
  for (let i = 0; i < numCheckpoints; i++) {
    const idx = (i * step) % pts.length;
    checkpoints.push({
      cx: pts[idx].x,
      cy: pts[idx].y,
      ax: inner[idx].x, ay: inner[idx].y,
      bx: outer[idx].x, by: outer[idx].y,
      index: idx,
    });
  }

  // Pickup slots — every ~75m of track (5 or 6 pickups per loop).
  const pickupSlots = [];
  const pickupStep = 25;
  for (let i = 0; i < pts.length; i += pickupStep) {
    const p = pts[i];
    const prev = pts[(i - 1 + pts.length) % pts.length];
    const next = pts[(i + 1) % pts.length];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len;
    const ny = tx / len;
    const w = widths[i] * 0.25 * ((i % (pickupStep * 2) === 0) ? 1 : -1);
    pickupSlots.push({ x: p.x + nx * w, y: p.y + ny * w });
  }

  // World bounds (in metres) — covers every tile corner.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of tiles) {
    for (const c of [t.al, t.ar, t.bl, t.br]) {
      if (c.x < minX) minX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.x > maxX) maxX = c.x;
      if (c.y > maxY) maxY = c.y;
    }
  }
  const pad = 12;     // 12 m of room around the track
  const bounds = {
    minX: minX - pad, minY: minY - pad,
    maxX: maxX + pad, maxY: maxY + pad,
  };

  return {
    seed,
    centerline: pts,
    widths,
    tiles,
    inner,
    outer,
    start: { x: start.x, y: start.y, tx: startTangent.x, ty: startTangent.y, nx: startNormal.x, ny: startNormal.y, width: startWidth },
    checkpoints,
    pickupSlots,
    bounds,
  };
}

// Closed-curve Chaikin: each segment subdivides into Q (1/4) and R (3/4) points.
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
    const dx = b.x - a.x;
    const dy = b.y - a.y;
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

// Grid 4-wide × N-deep, all behind the start line. Lateral span is 10.5m
// (4 columns at 3.5m spacing). Fits inside the guaranteed ≥14m start-area
// width.
export function gridSpawnPositions(track, count) {
  const { start } = track;
  const slots = [];
  const COLS = 4;
  const colSpacing = 3.5;   // metres
  const rowSpacing = 6;     // metres
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
