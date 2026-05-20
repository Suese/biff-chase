// PixiJS renderer. Pure procedural — no asset files. Owns three things:
//   - World scene: a Container that's transformed by the camera so we can draw
//     in world coordinates.
//   - HUD layer: stays in screen space (we draw the minimap into it).
//   - Per-car GFX (body + livery), per-pickup GFX, per-hazard GFX.
//
// One render pass per RAF tick. The Scene is reset every time the track
// changes (new race). Camera is set externally by main.js to track the local
// player's car.

import { Application, Container, Graphics, Text } from 'pixi.js';
import { ITEMS } from './items.js';
import { mulberry32 } from './rng.js';
import { PLAYER_COLORS } from './colors.js';

export class RallyScene {
  constructor(rootEl) {
    this.rootEl = rootEl;
    this.app = null;
    this.world = null;
    this.hud = null;
    this.bgLayer = null;
    this.trackLayer = null;
    this.pickupLayer = null;
    this.hazardLayer = null;
    this.carLayer = null;
    this.particleLayer = null;
    this.minimapGfx = null;
    this.tickCbs = [];
    this.camera = { x: 0, y: 0, zoom: 1.0, targetZoom: 1.0 };
    this.carGfx = new Map();        // id -> Graphics container
    this.pickupGfx = new Map();     // slotIndex -> Graphics
    this.hazardGfx = new Map();     // id -> Graphics
    this.particles = [];            // { g, vx, vy, life, max, fade }
    this._trackSeed = null;
    this._currentTrack = null;
  }

  async init() {
    this.app = new Application();
    // Force WebGL — WebGPU detection in PixiJS 8 can occasionally hang on
    // Chromium-based browsers without explicit GPU support, and our
    // rendering doesn't need WebGPU features.
    await this.app.init({
      background: '#0a0c10',
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      resizeTo: window,
      preference: 'webgl',
    });
    this.rootEl.appendChild(this.app.canvas);

    this.world = new Container();
    this.bgLayer = new Container();
    this.trackLayer = new Container();
    this.pickupLayer = new Container();
    this.hazardLayer = new Container();
    this.carLayer = new Container();
    this.particleLayer = new Container();
    this.world.addChild(this.bgLayer);
    this.world.addChild(this.trackLayer);
    this.world.addChild(this.pickupLayer);
    this.world.addChild(this.hazardLayer);
    this.world.addChild(this.particleLayer);
    this.world.addChild(this.carLayer);
    this.app.stage.addChild(this.world);

    this.hud = new Container();
    this.app.stage.addChild(this.hud);
    this.minimapGfx = new Graphics();
    this.hud.addChild(this.minimapGfx);

    // The PixiJS ticker only RENDERS — the game tick is driven externally via
    // _driveTick(dt) from main.js's master rAF loop. This way physics keeps
    // running even if PixiJS somehow stalls.
    this.app.ticker.autoStart = true;
  }

  onTick(cb) { this.tickCbs.push(cb); }

  // Called by the external rAF loop with a real dt.
  _driveTick(dt) { this._onTick({ deltaMS: dt * 1000 }); }

  _onTick(ticker) {
    const dt = ticker.deltaMS / 1000;
    // Camera smoothing — but on the first frame after a camera target appears,
    // snap there so we don't see the world shoot in from (0,0).
    if (this._cameraTarget) {
      if (!this._cameraSet) {
        this.camera.x = this._cameraTarget.x;
        this.camera.y = this._cameraTarget.y;
        this._cameraSet = true;
      } else {
        const k = 1 - Math.pow(0.001, dt);
        this.camera.x += (this._cameraTarget.x - this.camera.x) * k;
        this.camera.y += (this._cameraTarget.y - this.camera.y) * k;
      }
    }
    this.camera.zoom += (this.camera.targetZoom - this.camera.zoom) * (1 - Math.pow(0.001, dt));
    // app.screen is the CSS-pixel viewport, regardless of autoDensity/resolution.
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    this.world.scale.set(this.camera.zoom);
    this.world.position.set(w / 2 - this.camera.x * this.camera.zoom, h / 2 - this.camera.y * this.camera.zoom);

    // Update particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particleLayer.removeChild(p.g);
        p.g.destroy();
        this.particles.splice(i, 1);
        continue;
      }
      p.g.x += p.vx * dt;
      p.g.y += p.vy * dt;
      p.vx *= 0.9;
      p.vy *= 0.9;
      p.g.alpha = p.life / p.max;
    }

    for (const cb of this.tickCbs) cb(dt);
  }

  setCameraTarget(x, y) { this._cameraTarget = { x, y }; }
  resetCamera() { this._cameraSet = false; }
  setZoom(z) { this.camera.targetZoom = z; }

  // ---- Background tiling — pseudo-asphalt with subtle noise.
  buildBackground(bounds) {
    this.bgLayer.removeChildren();
    const g = new Graphics();
    const w = bounds.maxX - bounds.minX;
    const h = bounds.maxY - bounds.minY;
    g.rect(bounds.minX, bounds.minY, w, h).fill({ color: 0x141821 });
    // Sparse noise blotches
    const rng = mulberry32(0xDEAD ^ Math.floor(bounds.minX) ^ Math.floor(bounds.minY));
    for (let i = 0; i < 220; i++) {
      const x = bounds.minX + rng() * w;
      const y = bounds.minY + rng() * h;
      const r = 4 + rng() * 18;
      const a = 0.04 + rng() * 0.08;
      g.circle(x, y, r).fill({ color: 0x21262f, alpha: a });
    }
    this.bgLayer.addChild(g);
  }

  // ---- Track ribbon: filled polygon between inner+outer, with center stripes.
  buildTrack(track) {
    this._currentTrack = track;
    this.trackLayer.removeChildren();
    this.pickupLayer.removeChildren();
    this.pickupGfx.clear();

    const trackFill = new Graphics();
    // Combine outer + reversed inner into one closed polygon
    const pts = [...track.outer, ...track.inner.slice().reverse()];
    trackFill.beginPath();
    trackFill.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) trackFill.lineTo(pts[i].x, pts[i].y);
    trackFill.closePath();
    trackFill.fill({ color: 0x2a2f3a });

    // Curb edges — alternating red/white along inner & outer
    const curb = new Graphics();
    const drawCurb = (loop, off) => {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        const color = ((i + off) % 2 === 0) ? 0xff3a3a : 0xf3f3f3;
        curb.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color, width: 5, alpha: 0.85 });
      }
    };
    drawCurb(track.inner, 0);
    drawCurb(track.outer, 1);

    // Center dashed stripe
    const stripe = new Graphics();
    for (let i = 0; i < track.centerline.length; i += 2) {
      const a = track.centerline[i];
      const b = track.centerline[(i + 1) % track.centerline.length];
      stripe.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: 0xffffff, width: 3, alpha: 0.35 });
    }

    // Start/finish stripe — checkered, oriented to the track tangent.
    const sf = new Graphics();
    const s = track.start;
    for (let k = -4; k <= 4; k++) {
      const px = s.x + s.nx * (k * 22);
      const py = s.y + s.ny * (k * 22);
      const color = (k % 2 === 0) ? 0xffffff : 0x111111;
      const len = 18, wid = 32;
      const corner = (sx, sy) => ({
        x: px + s.tx * sx + s.nx * sy,
        y: py + s.ty * sx + s.ny * sy,
      });
      const c1 = corner(-len/2, -wid/2);
      const c2 = corner( len/2, -wid/2);
      const c3 = corner( len/2,  wid/2);
      const c4 = corner(-len/2,  wid/2);
      sf.beginPath();
      sf.moveTo(c1.x, c1.y).lineTo(c2.x, c2.y).lineTo(c3.x, c3.y).lineTo(c4.x, c4.y).closePath();
      sf.fill({ color });
    }

    this.trackLayer.addChild(trackFill);
    this.trackLayer.addChild(curb);
    this.trackLayer.addChild(stripe);
    this.trackLayer.addChild(sf);

    // Pickup slots — create placeholder GFX (state will toggle visibility)
    for (let i = 0; i < track.pickupSlots.length; i++) {
      const slot = track.pickupSlots[i];
      const g = new Graphics();
      g.x = slot.x; g.y = slot.y;
      this.pickupLayer.addChild(g);
      this.pickupGfx.set(i, g);
    }
  }

  drawPickup(g, kind, t = 0) {
    g.clear();
    const item = ITEMS[kind];
    if (!item) return;
    // Backplate
    const breath = Math.sin(t * 4) * 2;
    g.circle(0, 0, 14 + breath).fill({ color: 0x0f1218, alpha: 0.7 }).stroke({ color: 0xffce3d, width: 2 });
    // Glyph (cheap: a colored shape)
    if (kind === 'scrap') {
      g.rect(-5, -5, 10, 10).fill({ color: 0xb0b8c4 });
    } else if (kind === 'nitro') {
      g.poly([-6, 6, 0, -8, 6, 6]).fill({ color: 0xff6a3d });
    } else if (kind === 'mine') {
      g.circle(0, 0, 7).fill({ color: 0x222 });
      g.circle(0, 0, 3).fill({ color: 0xff3030 });
    } else if (kind === 'oil') {
      g.ellipse(0, 0, 8, 5).fill({ color: 0x101010 });
    } else if (kind === 'repair') {
      g.rect(-2, -7, 4, 14).fill({ color: 0x7cf3a0 });
      g.rect(-7, -2, 14, 4).fill({ color: 0x7cf3a0 });
    } else if (kind === 'spikes') {
      g.poly([-7, 5, -3, -5, 0, 5, 3, -5, 7, 5]).fill({ color: 0xaab0bd });
    }
  }

  syncPickups(pickups, t) {
    for (const p of pickups) {
      const g = this.pickupGfx.get(p.slotIndex);
      if (!g) continue;
      if (p.taken) {
        g.visible = false;
      } else {
        g.visible = true;
        this.drawPickup(g, p.kind, t);
      }
    }
  }

  // ---- Cars
  ensureCar(id, colorIdx) {
    let g = this.carGfx.get(id);
    if (!g) {
      g = new Container();
      const body = new Graphics();
      const tag = new Text({
        text: '',
        style: { fontSize: 11, fill: 0xffffff, fontFamily: 'system-ui', stroke: { color: 0x000, width: 3 } },
      });
      tag.anchor.set(0.5, 1.4);
      g.addChild(body);
      g.addChild(tag);
      g.bodyGfx = body;
      g.tagGfx = tag;
      this.drawCarLivery(body, colorIdx, id);
      this.carLayer.addChild(g);
      this.carGfx.set(id, g);
    }
    return g;
  }
  drawCarLivery(g, colorIdx, id) {
    g.clear();
    const baseHex = parseInt(PLAYER_COLORS[colorIdx % PLAYER_COLORS.length].replace('#',''), 16);
    const W = 32, L = 56;
    // Body
    g.roundRect(-W/2, -L/2, W, L, 6).fill({ color: 0x14171d }).stroke({ color: 0x0a0c10, width: 2 });
    // Color flank
    g.rect(-W/2 + 3, -L/2 + 8, W - 6, L - 22).fill({ color: baseHex });
    // Windshield
    g.roundRect(-W/2 + 5, -L/2 + 4, W - 10, 12, 3).fill({ color: 0x101418, alpha: 0.85 });
    // Spoiler
    g.rect(-W/2 + 2, L/2 - 8, W - 4, 6).fill({ color: 0x0a0c10 });
    // Random procedural decals based on the id hash
    let hash = 0;
    for (const c of String(id)) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
    const rng = mulberry32(hash);
    if (rng() > 0.5) {
      // Stripe down the middle
      g.rect(-1.5, -L/2 + 2, 3, L - 14).fill({ color: 0xffffff, alpha: 0.6 });
    }
    if (rng() > 0.6) {
      // Roof spot
      g.circle(0, -L/2 + 22, 4).fill({ color: 0xffffff, alpha: 0.6 });
    }
    // Wheels (decorative — physics doesn't simulate them)
    g.rect(-W/2 - 3, -L/2 + 6, 4, 12).fill({ color: 0x000 });
    g.rect( W/2 - 1, -L/2 + 6, 4, 12).fill({ color: 0x000 });
    g.rect(-W/2 - 3,  L/2 - 18, 4, 12).fill({ color: 0x000 });
    g.rect( W/2 - 1,  L/2 - 18, 4, 12).fill({ color: 0x000 });
  }

  syncCars(state, t) {
    const presentIds = new Set();
    for (const car of state.cars) {
      presentIds.add(car.id);
      const colorIdx = state.players.findIndex(p => p.id === car.id);
      const g = this.ensureCar(car.id, colorIdx < 0 ? 0 : colorIdx);
      g.x = car.x;
      g.y = car.y;
      // Matter angle 0 = facing +X. Our car geometry is drawn facing +Y. Rotate -90°.
      g.rotation = car.a - Math.PI / 2;
      g.alpha = car.alive ? 1 : 0.3;
      g.bodyGfx.tint = car.alive ? 0xffffff : 0x666666;
      const p = state.players.find(p => p.id === car.id);
      if (p && g.tagGfx) g.tagGfx.text = p.name;
      // Boost trail
      if (car.boost > 0 && Math.random() < 0.7) {
        this.emitParticle(car.x - Math.cos(car.a) * 28, car.y - Math.sin(car.a) * 28, -car.vx * 0.2, -car.vy * 0.2, 0.4, 0xff6a3d);
      }
    }
    for (const [id, g] of this.carGfx) {
      if (!presentIds.has(id)) {
        this.carLayer.removeChild(g);
        g.destroy({ children: true });
        this.carGfx.delete(id);
      }
    }
  }

  // ---- Hazards
  syncHazards(hazards, t) {
    const present = new Set();
    for (const h of hazards) {
      present.add(h.id);
      let g = this.hazardGfx.get(h.id);
      if (!g) {
        g = new Graphics();
        this.hazardLayer.addChild(g);
        this.hazardGfx.set(h.id, g);
      }
      g.x = h.x; g.y = h.y;
      g.clear();
      if (h.kind === 'mine') {
        const pulse = Math.sin(t * 8) * 0.5 + 0.5;
        g.circle(0, 0, 10).fill({ color: 0x222 });
        g.circle(0, 0, 4).fill({ color: 0xff3030, alpha: 0.5 + pulse * 0.5 });
      } else if (h.kind === 'oil') {
        g.ellipse(0, 0, 60, 38).fill({ color: 0x101010, alpha: 0.65 });
        g.ellipse(0, 0, 36, 22).fill({ color: 0x222222, alpha: 0.4 });
      } else if (h.kind === 'spikes') {
        g.poly([-22, 6, -16, -6, -10, 6, -4, -6, 4, 6, 10, -6, 16, 6, 22, -6]).fill({ color: 0xaab0bd }).stroke({ color: 0x222, width: 1 });
      }
    }
    for (const [id, g] of this.hazardGfx) {
      if (!present.has(id)) {
        this.hazardLayer.removeChild(g);
        g.destroy();
        this.hazardGfx.delete(id);
      }
    }
  }

  // ---- Particles
  emitParticle(x, y, vx, vy, life, color) {
    const g = new Graphics();
    g.circle(0, 0, 3).fill({ color });
    g.x = x; g.y = y;
    this.particleLayer.addChild(g);
    this.particles.push({ g, vx, vy, life, max: life });
  }

  emitBurst(x, y, count, color = 0xff8040, speed = 240, life = 0.5) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.8);
      this.emitParticle(x, y, Math.cos(a) * s, Math.sin(a) * s, life, color);
    }
  }

  // ---- Minimap (drawn in HUD/screen space)
  drawMinimap(state, myId) {
    const g = this.minimapGfx;
    g.clear();
    if (!state.track) return;
    const mm = document.getElementById('minimap');
    if (!mm) return;
    const rect = mm.getBoundingClientRect();
    const ox = rect.left;
    const oy = rect.top;
    const w = rect.width, h = rect.height;
    const b = state.track.bounds;
    const bw = b.maxX - b.minX;
    const bh = b.maxY - b.minY;
    const pad = 8;
    const scale = Math.min((w - pad*2) / bw, (h - pad*2) / bh);
    const dx = ox + (w - bw * scale) / 2 - b.minX * scale;
    const dy = oy + (h - bh * scale) / 2 - b.minY * scale;

    // Track outline
    const outer = state.track.outer;
    const inner = state.track.inner;
    g.beginPath();
    g.moveTo(dx + outer[0].x * scale, dy + outer[0].y * scale);
    for (let i = 1; i < outer.length; i++) g.lineTo(dx + outer[i].x * scale, dy + outer[i].y * scale);
    g.closePath();
    g.moveTo(dx + inner[0].x * scale, dy + inner[0].y * scale);
    for (let i = 1; i < inner.length; i++) g.lineTo(dx + inner[i].x * scale, dy + inner[i].y * scale);
    g.closePath();
    g.fill({ color: 0x2a2f3a });

    // Cars
    for (const car of state.cars) {
      const colorIdx = state.players.findIndex(p => p.id === car.id);
      const c = parseInt(PLAYER_COLORS[(colorIdx < 0 ? 0 : colorIdx) % PLAYER_COLORS.length].replace('#',''), 16);
      g.circle(dx + car.x * scale, dy + car.y * scale, car.id === myId ? 4 : 3).fill({ color: c });
    }
  }
}
