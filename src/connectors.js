// Track connector library. Each connector takes (start, end, bounds, rng)
// and returns a polyline (array of {x, y}) going FROM start TO end, NOT
// including the start point (so concatenated runs don't duplicate joins).
//
// All connectors stay inside their `bounds` rectangle as best as possible
// — some clamp explicitly, others use sub-radii that respect the box.
//
// `bounds` is {minX, minY, maxX, maxY} in metres. `rng` is mulberry32().

import { rfloat } from './rng.js';

// ---------- Helpers ----------

function clampToBounds(p, bounds, margin = 2) {
  return {
    x: Math.max(bounds.minX + margin, Math.min(bounds.maxX - margin, p.x)),
    y: Math.max(bounds.minY + margin, Math.min(bounds.maxY - margin, p.y)),
  };
}

function frame(start, end) {
  const dx = end.x - start.x, dy = end.y - start.y;
  const len = Math.hypot(dx, dy) || 1;
  return {
    len,
    ux: dx / len, uy: dy / len,            // forward
    px: -dy / len, py: dx / len,           // left-perpendicular
    start, end,
  };
}

function bezierPoints(start, c1, c2, end, steps) {
  const out = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    out.push({
      x: mt*mt*mt*start.x + 3*mt*mt*t*c1.x + 3*mt*t*t*c2.x + t*t*t*end.x,
      y: mt*mt*mt*start.y + 3*mt*mt*t*c1.y + 3*mt*t*t*c2.y + t*t*t*end.y,
    });
  }
  return out;
}

// ---------- Connectors ----------

// 1. DIRECT — single line from a to b, sampled at fine spacing.
export function connectorDirect(start, end, bounds, rng) {
  const f = frame(start, end);
  const steps = Math.max(4, Math.floor(f.len / 2));
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    pts.push({ x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t });
  }
  return pts;
}
connectorDirect.kind = 'direct';

// 2. BEZIER SWEEP — cubic curve with both control handles offset to one side.
//    Reads as a long flowing arc.
export function connectorBezierSweep(start, end, bounds, rng) {
  const f = frame(start, end);
  const off = (rng() < 0.5 ? 1 : -1) * f.len * rfloat(rng, 0.25, 0.45);
  const c1 = clampToBounds({ x: start.x + f.ux * f.len * 0.33 + f.px * off, y: start.y + f.uy * f.len * 0.33 + f.py * off }, bounds);
  const c2 = clampToBounds({ x: start.x + f.ux * f.len * 0.67 + f.px * off, y: start.y + f.uy * f.len * 0.67 + f.py * off }, bounds);
  return bezierPoints(start, c1, c2, end, Math.max(14, Math.floor(f.len / 2)));
}
connectorBezierSweep.kind = 'bezier_sweep';

// 3. WINDING — chain of small sinusoidal wiggles perpendicular to the line.
export function connectorWinding(start, end, bounds, rng) {
  const f = frame(start, end);
  const wiggles = 2 + Math.floor(rng() * 3);    // 2–4
  const amp = Math.min(f.len * 0.10, 10);
  const phaseShift = rng() * Math.PI * 2;
  const steps = Math.max(32, Math.floor(f.len / 2));
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const offset = Math.sin(t * wiggles * Math.PI * 2 + phaseShift) * amp;
    const p = {
      x: start.x + f.ux * f.len * t + f.px * offset,
      y: start.y + f.uy * f.len * t + f.py * offset,
    };
    pts.push(clampToBounds(p, bounds));
  }
  return pts;
}
connectorWinding.kind = 'winding';

// 4. MEANDERING — pseudo-random walk smoothed via Bezier through control points.
export function connectorMeandering(start, end, bounds, rng) {
  const f = frame(start, end);
  const segments = 3 + Math.floor(rng() * 3);   // 3–5
  const ctrls = [start];
  for (let i = 1; i < segments; i++) {
    const t = i / segments;
    const offMul = rfloat(rng, -0.18, 0.18);
    const p = {
      x: start.x + f.ux * f.len * t + f.px * f.len * offMul,
      y: start.y + f.uy * f.len * t + f.py * f.len * offMul,
    };
    ctrls.push(clampToBounds(p, bounds));
  }
  ctrls.push(end);

  // Chain Beziers between consecutive control points.
  const out = [];
  for (let i = 0; i < ctrls.length - 1; i++) {
    const a = ctrls[i];
    const b = ctrls[i + 1];
    const before = ctrls[Math.max(0, i - 1)];
    const after  = ctrls[Math.min(ctrls.length - 1, i + 2)];
    // Catmull-Rom-like control offsets.
    const c1 = { x: a.x + (b.x - before.x) * 0.18, y: a.y + (b.y - before.y) * 0.18 };
    const c2 = { x: b.x - (after.x - a.x) * 0.18, y: b.y - (after.y - a.y) * 0.18 };
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    for (const p of bezierPoints(a, c1, c2, b, Math.max(6, Math.floor(len / 2)))) {
      out.push(clampToBounds(p, bounds));
    }
  }
  return out;
}
connectorMeandering.kind = 'meandering';

// 5. DOGLEG — straight, 45° kink to one side, straight again.
export function connectorDogleg(start, end, bounds, rng) {
  const f = frame(start, end);
  const off = (rng() < 0.5 ? 1 : -1) * f.len * rfloat(rng, 0.15, 0.30);
  const t1 = 0.35, t2 = 0.65;
  const m1 = clampToBounds({ x: start.x + f.ux * f.len * t1 + f.px * off, y: start.y + f.uy * f.len * t1 + f.py * off }, bounds);
  const m2 = clampToBounds({ x: start.x + f.ux * f.len * t2 + f.px * off, y: start.y + f.uy * f.len * t2 + f.py * off }, bounds);
  const out = [];
  for (const seg of [[start, m1], [m1, m2], [m2, end]]) {
    const len = Math.hypot(seg[1].x - seg[0].x, seg[1].y - seg[0].y);
    const steps = Math.max(2, Math.floor(len / 2));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      out.push({ x: seg[0].x + (seg[1].x - seg[0].x) * t, y: seg[0].y + (seg[1].y - seg[0].y) * t });
    }
  }
  return out;
}
connectorDogleg.kind = 'dogleg';

// 6. DUAL STRAIGHT — straight line, BUT the road carries a centre median
//    for its whole length. The polyline geometry is identical to a direct
//    line; the renderer reads the section's `feature` tag to draw the median.
export function connectorDualStraight(start, end, bounds, rng) {
  return connectorDirect(start, end, bounds, rng);
}
connectorDualStraight.kind = 'dual_straight';

// 7. WAVE — sinusoidal centerline with a single large wavelength.
export function connectorWave(start, end, bounds, rng) {
  const f = frame(start, end);
  const amp = Math.min(f.len * 0.18, 12);
  const period = rfloat(rng, 0.9, 1.5);
  const sign = rng() < 0.5 ? 1 : -1;
  const steps = Math.max(32, Math.floor(f.len / 1.8));
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const offset = Math.sin(t * Math.PI * period) * amp * sign;
    pts.push(clampToBounds({
      x: start.x + f.ux * f.len * t + f.px * offset,
      y: start.y + f.uy * f.len * t + f.py * offset,
    }, bounds));
  }
  return pts;
}
connectorWave.kind = 'wave';

// 8. SWITCHBACK — alternating 45° kinks. Three S-shaped reversals.
export function connectorSwitchback(start, end, bounds, rng) {
  const f = frame(start, end);
  const kinks = 3 + Math.floor(rng() * 2);  // 3 or 4
  const amp = Math.min(f.len * 0.12, 8);
  const ctrls = [start];
  for (let i = 1; i <= kinks; i++) {
    const t = i / (kinks + 1);
    const sign = (i % 2 === 0) ? 1 : -1;
    const p = {
      x: start.x + f.ux * f.len * t + f.px * amp * sign,
      y: start.y + f.uy * f.len * t + f.py * amp * sign,
    };
    ctrls.push(clampToBounds(p, bounds));
  }
  ctrls.push(end);
  // Smooth-ish — straight between control points.
  const out = [];
  for (let i = 0; i < ctrls.length - 1; i++) {
    const a = ctrls[i], b = ctrls[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(2, Math.floor(len / 2));
    for (let j = 1; j <= steps; j++) {
      const t = j / steps;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}
connectorSwitchback.kind = 'switchback';

// 9. MANHATTAN — axis-aligned right-angle steps from start to end.
export function connectorManhattan(start, end, bounds, rng) {
  const dx = end.x - start.x, dy = end.y - start.y;
  const steps = 2 + Math.floor(rng() * 2);   // 2 or 3 zig-zags
  const stepX = dx / steps;
  const stepY = dy / steps;
  const ctrls = [start];
  let cur = { ...start };
  for (let i = 0; i < steps; i++) {
    if (i % 2 === 0) {
      cur = clampToBounds({ x: cur.x + stepX, y: cur.y },             bounds);
      ctrls.push({ ...cur });
      cur = clampToBounds({ x: cur.x,         y: cur.y + stepY },     bounds);
      ctrls.push({ ...cur });
    } else {
      cur = clampToBounds({ x: cur.x,         y: cur.y + stepY },     bounds);
      ctrls.push({ ...cur });
      cur = clampToBounds({ x: cur.x + stepX, y: cur.y },             bounds);
      ctrls.push({ ...cur });
    }
  }
  ctrls[ctrls.length - 1] = end;
  // Subdivide and slightly round the corners so the placer doesn't see
  // exact-90° transitions that would force a sharp single-cell turn.
  const out = [];
  for (let i = 0; i < ctrls.length - 1; i++) {
    const a = ctrls[i], b = ctrls[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const N = Math.max(2, Math.floor(len / 2));
    for (let j = 1; j <= N; j++) {
      const t = j / N;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}
connectorManhattan.kind = 'manhattan';

// 10. MAZE-COLLAPSED — generate a small maze inside the room's bounding
//     box on a 6m sub-grid, depth-first search; then collapse the longest
//     simple path from start-cell to end-cell into a polyline.
export function connectorMazeCollapsed(start, end, bounds, rng) {
  const CELL = 6;
  const W = Math.max(2, Math.floor((bounds.maxX - bounds.minX) / CELL));
  const H = Math.max(2, Math.floor((bounds.maxY - bounds.minY) / CELL));
  const ox = bounds.minX;
  const oy = bounds.minY;

  const cellAt = (gx, gy) => `${gx},${gy}`;
  const startGX = Math.max(0, Math.min(W - 1, Math.floor((start.x - ox) / CELL)));
  const startGY = Math.max(0, Math.min(H - 1, Math.floor((start.y - oy) / CELL)));
  const endGX   = Math.max(0, Math.min(W - 1, Math.floor((end.x   - ox) / CELL)));
  const endGY   = Math.max(0, Math.min(H - 1, Math.floor((end.y   - oy) / CELL)));

  // DFS to find a SIMPLE path from start cell to end cell, exploring
  // neighbours in randomized order. Bounded by maxBacktracks to keep it cheap.
  const visited = new Set();
  const stack = [[startGX, startGY]];
  const path = [];
  const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
  let safety = W * H * 4;
  while (stack.length && safety-- > 0) {
    const [gx, gy] = stack[stack.length - 1];
    const key = cellAt(gx, gy);
    if (!visited.has(key)) {
      visited.add(key);
      path.push([gx, gy]);
    }
    if (gx === endGX && gy === endGY) break;
    // Randomize neighbour order.
    const order = dirs.slice().sort(() => rng() - 0.5);
    let advanced = false;
    for (const [dx, dy] of order) {
      const nx = gx + dx, ny = gy + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      if (visited.has(cellAt(nx, ny))) continue;
      stack.push([nx, ny]);
      advanced = true;
      break;
    }
    if (!advanced) {
      stack.pop();
      // Backtrack the path too.
      if (path.length > 1 && path[path.length - 1][0] === gx && path[path.length - 1][1] === gy) {
        path.pop();
      }
    }
  }
  if (path.length < 1) return connectorDirect(start, end, bounds, rng);

  // Build a polyline through cell centres, snapping start/end exactly.
  const pts = [];
  const N = path.length;
  for (let i = 0; i < N; i++) {
    const cx = ox + (path[i][0] + 0.5) * CELL;
    const cy = oy + (path[i][1] + 0.5) * CELL;
    pts.push({ x: cx, y: cy });
  }
  // Replace last point with the actual end.
  pts[pts.length - 1] = end;
  // Insert intermediate points along each segment so tiles fill in nicely.
  const out = [];
  let prev = start;
  for (const p of pts) {
    const len = Math.hypot(p.x - prev.x, p.y - prev.y);
    const steps = Math.max(2, Math.floor(len / 2.5));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      out.push({ x: prev.x + (p.x - prev.x) * t, y: prev.y + (p.y - prev.y) * t });
    }
    prev = p;
  }
  return out;
}
connectorMazeCollapsed.kind = 'maze';

// 11. LAZY ARC — wide, gentle bezier (smaller offset than the sweep).
export function connectorLazyArc(start, end, bounds, rng) {
  const f = frame(start, end);
  const off = (rng() < 0.5 ? 1 : -1) * f.len * rfloat(rng, 0.10, 0.18);
  const c1 = { x: start.x + f.ux * f.len * 0.4 + f.px * off, y: start.y + f.uy * f.len * 0.4 + f.py * off };
  const c2 = { x: start.x + f.ux * f.len * 0.6 + f.px * off, y: start.y + f.uy * f.len * 0.6 + f.py * off };
  return bezierPoints(start, c1, c2, end, Math.max(12, Math.floor(f.len / 2.2)));
}
connectorLazyArc.kind = 'lazy_arc';

// 12. CHICANE — quick S-curve through the centre.
export function connectorChicane(start, end, bounds, rng) {
  const f = frame(start, end);
  const amp = Math.min(f.len * 0.18, 12);
  const sign = rng() < 0.5 ? 1 : -1;
  const m1 = clampToBounds({ x: start.x + f.ux * f.len * 0.25 + f.px * amp * sign, y: start.y + f.uy * f.len * 0.25 + f.py * amp * sign }, bounds);
  const m2 = clampToBounds({ x: start.x + f.ux * f.len * 0.5,                     y: start.y + f.uy * f.len * 0.5 }, bounds);
  const m3 = clampToBounds({ x: start.x + f.ux * f.len * 0.75 - f.px * amp * sign, y: start.y + f.uy * f.len * 0.75 - f.py * amp * sign }, bounds);
  const out = [];
  let prev = start;
  for (const p of [m1, m2, m3, end]) {
    const len = Math.hypot(p.x - prev.x, p.y - prev.y);
    const N = Math.max(4, Math.floor(len / 1.8));
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      out.push({ x: prev.x + (p.x - prev.x) * t, y: prev.y + (p.y - prev.y) * t });
    }
    prev = p;
  }
  return out;
}
connectorChicane.kind = 'chicane';

// ---------- Registry ----------

export const CONNECTORS = [
  connectorDirect,
  connectorBezierSweep,
  connectorWinding,
  connectorMeandering,
  connectorDogleg,
  connectorDualStraight,
  connectorWave,
  connectorSwitchback,
  connectorManhattan,
  connectorMazeCollapsed,
  connectorLazyArc,
  connectorChicane,
];

export function pickConnector(rng, segLen) {
  // Length-aware weighting: short segments favour direct / chicane / dogleg;
  // long ones favour sweepers / mazes / winding.
  const r = rng();
  if (segLen < 25) {
    if (r < 0.35) return connectorDirect;
    if (r < 0.55) return connectorChicane;
    if (r < 0.75) return connectorDogleg;
    if (r < 0.90) return connectorLazyArc;
    return connectorDualStraight;
  }
  if (segLen < 55) {
    if (r < 0.18) return connectorBezierSweep;
    if (r < 0.34) return connectorWave;
    if (r < 0.46) return connectorChicane;
    if (r < 0.58) return connectorDogleg;
    if (r < 0.70) return connectorWinding;
    if (r < 0.80) return connectorSwitchback;
    if (r < 0.88) return connectorMeandering;
    if (r < 0.94) return connectorManhattan;
    return connectorDualStraight;
  }
  // Long
  if (r < 0.22) return connectorBezierSweep;
  if (r < 0.38) return connectorMeandering;
  if (r < 0.52) return connectorWinding;
  if (r < 0.64) return connectorMazeCollapsed;
  if (r < 0.74) return connectorWave;
  if (r < 0.82) return connectorSwitchback;
  if (r < 0.90) return connectorManhattan;
  if (r < 0.96) return connectorLazyArc;
  return connectorDualStraight;
}
