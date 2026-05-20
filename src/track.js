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

  // Polygon-based centerline. Vertices live on a jittered circle — but with
  // only one Chaikin smoothing pass each corner stays sharp, giving the
  // angular Death Rally feel without the self-intersection risk of a
  // grid-snapped layout.
  const N = 16 + Math.floor(rng() * 5);    // 16-20 vertices
  const baseR = 900;
  const radJitter = 380;
  const ctrl = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + rfloat(rng, -0.08, 0.08);
    const r = baseR + rfloat(rng, -radJitter, radJitter);
    ctrl.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }

  // One Chaikin pass — barely rounds the polygon corners, keeps the angles.
  let pts = chaikinClosed(ctrl);

  // Resample at coarser interval.
  pts = resampleByArc(pts, 60);

  // Per-vertex track width with smooth variation. Base is wide enough that a
  // 4-wide starting grid (≈ 180 px including car widths + gaps) fits in any
  // section with margin to spare. Variation adds character to the track shape.
  const widthBase = 320;
  const widthVar  = 60;
  const phase     = rng() * Math.PI * 2;
  const widthFreq = 3 + Math.floor(rng() * 3);
  const widths = pts.map((_, i) => {
    const t = (i / pts.length) * Math.PI * 2;
    return widthBase + Math.sin(t * widthFreq + phase) * widthVar;
  });
  // Force generous width near the start/finish so the grid is always inside
  // the track regardless of where the noise dipped. Indices 0 and the last
  // few cover the start point + the backward grid rows.
  const startMin = 280;
  const startRange = 6;       // ~300 px back along the centerline
  for (let i = 0; i < startRange; i++) {
    const idxBack = (pts.length - i) % pts.length;
    widths[i] = Math.max(widths[i], startMin);
    widths[idxBack] = Math.max(widths[idxBack], startMin);
  }

  const inner = [];
  const outer = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const prev = pts[(i - 1 + pts.length) % pts.length];
    const next = pts[(i + 1) % pts.length];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len;
    const ny = tx / len;
    const w = widths[i] / 2;
    inner.push({ x: p.x + nx * w, y: p.y + ny * w });
    outer.push({ x: p.x - nx * w, y: p.y - ny * w });
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

  // Pickup slots — very sparse on the new fast tracks. A handful of pickups
  // per loop, alternating sides.
  const pickupSlots = [];
  const pickupStep = 80;
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

  // World bounds for camera + minimap
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of outer.concat(inner)) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = 100;
  const bounds = {
    minX: minX - pad, minY: minY - pad,
    maxX: maxX + pad, maxY: maxY + pad,
  };

  return {
    seed,
    centerline: pts,
    widths,
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

// Grid 4-wide × N-deep, all behind the start line. Lateral span is 180 px
// (4 columns at 60 px spacing), which fits inside the guaranteed start-area
// width of 280. Forward direction is the start tangent so cars face the
// finish line.
export function gridSpawnPositions(track, count) {
  const { start } = track;
  const slots = [];
  const COLS = 4;
  const colSpacing = 60;
  const rowSpacing = 75;
  const colOffset = -(COLS - 1) / 2;   // centre the grid: -1.5, -0.5, +0.5, +1.5
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
