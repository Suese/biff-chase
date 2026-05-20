// Tile-grid connectors.
//
// Each connector emits a CHAIN OF GRID CELLS (not a polyline). The chain
// goes from anchor cell A to anchor cell B; consecutive cells in the chain
// must share an edge (4-connected) so the placer can read the entry/exit
// edges and pick a tile shape. Connectors that naturally produce diagonal
// or curved moves run their output through a 4-connector step expander
// that inserts axis-aligned intermediate cells when needed.

import { rfloat, rint } from './rng.js';

// ---- Cell maths ---------------------------------------------------------

const key = (gx, gy) => `${gx},${gy}`;
const eq = (a, b) => a.gx === b.gx && a.gy === b.gy;

// Force a sequence of cells to be 4-connected by inserting intermediate
// straight-line cells when consecutive entries jump more than one step.
// Also dedupes consecutive duplicates.
function makeConnected(cells) {
  const out = [];
  let prev = null;
  for (const c of cells) {
    if (prev && (c.gx !== prev.gx || c.gy !== prev.gy)) {
      // Walk from prev to c one cell at a time. Always axis-aligned: do
      // horizontal moves first when the gap is bigger in x, vertical otherwise.
      let { gx, gy } = prev;
      while (gx !== c.gx || gy !== c.gy) {
        const dx = c.gx - gx;
        const dy = c.gy - gy;
        if (Math.abs(dx) > 0 && (Math.abs(dx) >= Math.abs(dy))) {
          gx += Math.sign(dx);
        } else {
          gy += Math.sign(dy);
        }
        if (gx === prev.gx && gy === prev.gy) continue;  // shouldn't happen
        out.push({ gx, gy });
        prev = { gx, gy };
      }
    } else if (!prev) {
      out.push(c);
      prev = c;
    }
  }
  // Final dedupe.
  const dedup = [];
  let last = null;
  for (const c of out) {
    if (!last || c.gx !== last.gx || c.gy !== last.gy) {
      dedup.push(c);
      last = c;
    }
  }
  return dedup;
}

// ---- Connector helpers --------------------------------------------------

function bresenham(ax, ay, bx, by) {
  // Cells visited by a Bresenham line from (ax,ay) to (bx,by), inclusive.
  const cells = [];
  let x0 = ax, y0 = ay;
  const x1 = bx, y1 = by;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  while (true) {
    cells.push({ gx: x0, gy: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 <  dx) { err += dx; y0 += sy; }
  }
  return cells;
}

function bezierSample(a, b, c1, c2, steps) {
  const cells = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    cells.push({
      gx: Math.round(mt*mt*mt*a.gx + 3*mt*mt*t*c1.gx + 3*mt*t*t*c2.gx + t*t*t*b.gx),
      gy: Math.round(mt*mt*mt*a.gy + 3*mt*mt*t*c1.gy + 3*mt*t*t*c2.gy + t*t*t*b.gy),
    });
  }
  return cells;
}

// ---- Connector library --------------------------------------------------

// 1. DIRECT — straight line between anchors, 4-connected.
export function connectorDirect(a, b, rng) {
  return makeConnected(bresenham(a.gx, a.gy, b.gx, b.gy));
}
connectorDirect.kind = 'direct';

// 2. BEZIER SWEEP — both control handles offset to the same side.
export function connectorBezierSweep(a, b, rng) {
  const dx = b.gx - a.gx, dy = b.gy - a.gy;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len, py = dx / len;
  const off = (rng() < 0.5 ? 1 : -1) * len * rfloat(rng, 0.25, 0.45);
  const c1 = { gx: a.gx + dx * 0.33 + px * off, gy: a.gy + dy * 0.33 + py * off };
  const c2 = { gx: a.gx + dx * 0.67 + px * off, gy: a.gy + dy * 0.67 + py * off };
  return makeConnected(bezierSample(a, b, c1, c2, Math.max(16, Math.floor(len * 2))));
}
connectorBezierSweep.kind = 'bezier_sweep';

// 3. LAZY ARC — gentler bezier (smaller offset).
export function connectorLazyArc(a, b, rng) {
  const dx = b.gx - a.gx, dy = b.gy - a.gy;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len, py = dx / len;
  const off = (rng() < 0.5 ? 1 : -1) * len * rfloat(rng, 0.10, 0.18);
  const c1 = { gx: a.gx + dx * 0.4 + px * off, gy: a.gy + dy * 0.4 + py * off };
  const c2 = { gx: a.gx + dx * 0.6 + px * off, gy: a.gy + dy * 0.6 + py * off };
  return makeConnected(bezierSample(a, b, c1, c2, Math.max(12, Math.floor(len * 2))));
}
connectorLazyArc.kind = 'lazy_arc';

// 4. WINDING — sinusoidal offset perpendicular to a-b.
export function connectorWinding(a, b, rng) {
  const dx = b.gx - a.gx, dy = b.gy - a.gy;
  const len = Math.hypot(dx, dy) || 1;
  const fx = dx / len, fy = dy / len;
  const px = -fy, py = fx;
  const wiggles = 2 + Math.floor(rng() * 3);
  const amp = Math.min(len * 0.18, 5);
  const phase = rng() * Math.PI * 2;
  const steps = Math.max(20, Math.floor(len * 3));
  const cells = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const offset = Math.sin(t * wiggles * Math.PI * 2 + phase) * amp;
    cells.push({
      gx: Math.round(a.gx + fx * len * t + px * offset),
      gy: Math.round(a.gy + fy * len * t + py * offset),
    });
  }
  return makeConnected(cells);
}
connectorWinding.kind = 'winding';

// 5. MEANDERING — random walk on a smoothed path.
export function connectorMeandering(a, b, rng) {
  const dx = b.gx - a.gx, dy = b.gy - a.gy;
  const len = Math.hypot(dx, dy) || 1;
  const fx = dx / len, fy = dy / len;
  const px = -fy, py = fx;
  const segments = 3 + Math.floor(rng() * 3);
  const ctrls = [a];
  for (let i = 1; i < segments; i++) {
    const t = i / segments;
    const offMul = rfloat(rng, -0.20, 0.20);
    ctrls.push({
      gx: a.gx + fx * len * t + px * len * offMul,
      gy: a.gy + fy * len * t + py * len * offMul,
    });
  }
  ctrls.push(b);
  const out = [];
  for (let i = 0; i < ctrls.length - 1; i++) {
    const x = ctrls[i], y = ctrls[i + 1];
    const before = ctrls[Math.max(0, i - 1)];
    const after  = ctrls[Math.min(ctrls.length - 1, i + 2)];
    const c1 = { gx: x.gx + (y.gx - before.gx) * 0.18, gy: x.gy + (y.gy - before.gy) * 0.18 };
    const c2 = { gx: y.gx - (after.gx - x.gx) * 0.18, gy: y.gy - (after.gy - x.gy) * 0.18 };
    const segLen = Math.hypot(y.gx - x.gx, y.gy - x.gy);
    for (const c of bezierSample(x, y, c1, c2, Math.max(8, Math.floor(segLen * 2)))) out.push(c);
  }
  return makeConnected(out);
}
connectorMeandering.kind = 'meandering';

// 6. DOGLEG — straight, 45° kink, straight again.
export function connectorDogleg(a, b, rng) {
  const dx = b.gx - a.gx, dy = b.gy - a.gy;
  const len = Math.hypot(dx, dy) || 1;
  const fx = dx / len, fy = dy / len;
  const px = -fy, py = fx;
  const off = (rng() < 0.5 ? 1 : -1) * len * rfloat(rng, 0.15, 0.30);
  const m1 = { gx: Math.round(a.gx + fx * len * 0.35 + px * off), gy: Math.round(a.gy + fy * len * 0.35 + py * off) };
  const m2 = { gx: Math.round(a.gx + fx * len * 0.65 + px * off), gy: Math.round(a.gy + fy * len * 0.65 + py * off) };
  return makeConnected([
    ...bresenham(a.gx, a.gy, m1.gx, m1.gy),
    ...bresenham(m1.gx, m1.gy, m2.gx, m2.gy).slice(1),
    ...bresenham(m2.gx, m2.gy, b.gx, b.gy).slice(1),
  ]);
}
connectorDogleg.kind = 'dogleg';

// 7. DUAL STRAIGHT — geometry is identical to direct (the median is a render-
//    only detail driven by the section's road type and shape choice).
export function connectorDualStraight(a, b, rng) {
  return connectorDirect(a, b, rng);
}
connectorDualStraight.kind = 'dual_straight';

// 8. WAVE — single large-period sinusoid.
export function connectorWave(a, b, rng) {
  const dx = b.gx - a.gx, dy = b.gy - a.gy;
  const len = Math.hypot(dx, dy) || 1;
  const fx = dx / len, fy = dy / len;
  const px = -fy, py = fx;
  const amp = Math.min(len * 0.22, 6);
  const period = rfloat(rng, 0.9, 1.5);
  const sign = rng() < 0.5 ? 1 : -1;
  const steps = Math.max(24, Math.floor(len * 3));
  const cells = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const offset = Math.sin(t * Math.PI * period) * amp * sign;
    cells.push({
      gx: Math.round(a.gx + fx * len * t + px * offset),
      gy: Math.round(a.gy + fy * len * t + py * offset),
    });
  }
  return makeConnected(cells);
}
connectorWave.kind = 'wave';

// 9. SWITCHBACK — alternating cross-track kinks.
export function connectorSwitchback(a, b, rng) {
  const dx = b.gx - a.gx, dy = b.gy - a.gy;
  const len = Math.hypot(dx, dy) || 1;
  const fx = dx / len, fy = dy / len;
  const px = -fy, py = fx;
  const kinks = 3 + Math.floor(rng() * 2);
  const amp = Math.min(len * 0.16, 5);
  const ctrls = [a];
  for (let i = 1; i <= kinks; i++) {
    const t = i / (kinks + 1);
    const sign = (i % 2 === 0) ? 1 : -1;
    ctrls.push({
      gx: Math.round(a.gx + fx * len * t + px * amp * sign),
      gy: Math.round(a.gy + fy * len * t + py * amp * sign),
    });
  }
  ctrls.push(b);
  const out = [];
  for (let i = 0; i < ctrls.length - 1; i++) {
    const line = bresenham(ctrls[i].gx, ctrls[i].gy, ctrls[i + 1].gx, ctrls[i + 1].gy);
    for (const c of (i === 0 ? line : line.slice(1))) out.push(c);
  }
  return makeConnected(out);
}
connectorSwitchback.kind = 'switchback';

// 10. MANHATTAN — only 90° turns, axis-aligned stairs.
export function connectorManhattan(a, b, rng) {
  const dx = b.gx - a.gx;
  const dy = b.gy - a.gy;
  const steps = 2 + Math.floor(rng() * 2);
  const stepX = dx / steps;
  const stepY = dy / steps;
  const ctrls = [{ gx: a.gx, gy: a.gy }];
  let curGx = a.gx, curGy = a.gy;
  const hFirst = rng() < 0.5;
  for (let i = 0; i < steps; i++) {
    if ((i + (hFirst ? 0 : 1)) % 2 === 0) {
      curGx = Math.round(a.gx + stepX * (i + 1));
      ctrls.push({ gx: curGx, gy: curGy });
      curGy = Math.round(a.gy + stepY * (i + 1));
      ctrls.push({ gx: curGx, gy: curGy });
    } else {
      curGy = Math.round(a.gy + stepY * (i + 1));
      ctrls.push({ gx: curGx, gy: curGy });
      curGx = Math.round(a.gx + stepX * (i + 1));
      ctrls.push({ gx: curGx, gy: curGy });
    }
  }
  ctrls[ctrls.length - 1] = { gx: b.gx, gy: b.gy };
  const out = [];
  for (let i = 0; i < ctrls.length - 1; i++) {
    const line = bresenham(ctrls[i].gx, ctrls[i].gy, ctrls[i + 1].gx, ctrls[i + 1].gy);
    for (const c of (i === 0 ? line : line.slice(1))) out.push(c);
  }
  return makeConnected(out);
}
connectorManhattan.kind = 'manhattan';

// 11. MAZE — random DFS from a to b inside a rectangular bounding region.
//     Walks the grid one cell at a time, picking unvisited 4-neighbours in
//     random order, backtracking when stuck. The resulting cell list is
//     guaranteed 4-connected by construction.
export function connectorMazeDFS(a, b, rng) {
  // Bounding box for the walk: expand the a–b AABB by a few cells on each side.
  const minX = Math.min(a.gx, b.gx) - 3;
  const maxX = Math.max(a.gx, b.gx) + 3;
  const minY = Math.min(a.gy, b.gy) - 3;
  const maxY = Math.max(a.gy, b.gy) + 3;
  const visited = new Set();
  const path = [];
  const stack = [{ gx: a.gx, gy: a.gy }];
  const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
  let safety = (maxX - minX + 1) * (maxY - minY + 1) * 4;
  let found = false;
  while (stack.length && safety-- > 0) {
    const top = stack[stack.length - 1];
    const k = key(top.gx, top.gy);
    if (!visited.has(k)) {
      visited.add(k);
      path.push({ gx: top.gx, gy: top.gy });
    }
    if (top.gx === b.gx && top.gy === b.gy) { found = true; break; }
    const order = dirs.slice().sort(() => rng() - 0.5);
    let advanced = false;
    for (const [dx, dy] of order) {
      const nx = top.gx + dx, ny = top.gy + dy;
      if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
      if (visited.has(key(nx, ny))) continue;
      stack.push({ gx: nx, gy: ny });
      advanced = true;
      break;
    }
    if (!advanced) {
      stack.pop();
      if (path.length > 1 && path[path.length - 1].gx === top.gx && path[path.length - 1].gy === top.gy) {
        path.pop();
      }
    }
  }
  if (!found || path.length < 2) {
    return connectorDirect(a, b, rng);
  }
  return makeConnected(path);
}
connectorMazeDFS.kind = 'maze';

// 12. CHICANE — quick S-curve through the middle.
export function connectorChicane(a, b, rng) {
  const dx = b.gx - a.gx, dy = b.gy - a.gy;
  const len = Math.hypot(dx, dy) || 1;
  const fx = dx / len, fy = dy / len;
  const px = -fy, py = fx;
  const amp = Math.min(len * 0.22, 5);
  const sign = rng() < 0.5 ? 1 : -1;
  const m1 = { gx: Math.round(a.gx + fx * len * 0.25 + px * amp * sign), gy: Math.round(a.gy + fy * len * 0.25 + py * amp * sign) };
  const m2 = { gx: Math.round(a.gx + fx * len * 0.50),                   gy: Math.round(a.gy + fy * len * 0.50) };
  const m3 = { gx: Math.round(a.gx + fx * len * 0.75 - px * amp * sign), gy: Math.round(a.gy + fy * len * 0.75 - py * amp * sign) };
  const out = [];
  let prev = a;
  for (const cur of [m1, m2, m3, b]) {
    const line = bresenham(prev.gx, prev.gy, cur.gx, cur.gy);
    for (const c of (prev === a ? line : line.slice(1))) out.push(c);
    prev = cur;
  }
  return makeConnected(out);
}
connectorChicane.kind = 'chicane';

// ---- Registry ------------------------------------------------------------

export const CONNECTORS = [
  connectorDirect,
  connectorBezierSweep,
  connectorLazyArc,
  connectorWinding,
  connectorMeandering,
  connectorDogleg,
  connectorDualStraight,
  connectorWave,
  connectorSwitchback,
  connectorManhattan,
  connectorMazeDFS,
  connectorChicane,
];

export function pickConnector(rng, segCells) {
  const r = rng();
  if (segCells < 8) {
    if (r < 0.35) return connectorDirect;
    if (r < 0.55) return connectorChicane;
    if (r < 0.75) return connectorDogleg;
    if (r < 0.90) return connectorLazyArc;
    return connectorDualStraight;
  }
  if (segCells < 18) {
    if (r < 0.16) return connectorBezierSweep;
    if (r < 0.30) return connectorWave;
    if (r < 0.42) return connectorChicane;
    if (r < 0.54) return connectorDogleg;
    if (r < 0.66) return connectorWinding;
    if (r < 0.76) return connectorSwitchback;
    if (r < 0.84) return connectorMeandering;
    if (r < 0.92) return connectorManhattan;
    return connectorDualStraight;
  }
  // Long segments — sweepers + mazes + winding patterns shine.
  if (r < 0.22) return connectorBezierSweep;
  if (r < 0.38) return connectorMeandering;
  if (r < 0.52) return connectorWinding;
  if (r < 0.66) return connectorMazeDFS;
  if (r < 0.76) return connectorWave;
  if (r < 0.84) return connectorSwitchback;
  if (r < 0.92) return connectorManhattan;
  return connectorLazyArc;
}
