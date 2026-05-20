// Three.js renderer. Gameplay stays in 2D — game coordinates (x, y) map to
// world (x, 0, y) so the entire scene lives on the XZ plane. An orthographic
// camera positioned above the player looks straight down for a clean
// top-down view; we still get specular highlights and shadowed depth from
// box/cone geometry under directional lighting.

import * as THREE from 'three';
import { PLAYER_COLORS } from './colors.js';
import { ITEMS } from './items.js';

function lerpColor(a, b, t) {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  return ((ar + (br - ar) * t) | 0) << 16 | ((ag + (bg - ag) * t) | 0) << 8 | ((ab + (bb - ab) * t) | 0);
}

export class RallyScene {
  constructor(rootEl) {
    this.rootEl = rootEl;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.cameraPos = { x: 0, y: 0 };
    this.cameraZoom = 1.0;
    this.targetZoom = 1.0;
    this._cameraTarget = null;
    this._cameraSet = false;

    this.tickCbs = [];
    this.trackGroup = null;

    this.carMeshes = new Map();      // id -> Group
    this.carFlashUntil = new Map();
    this.pickupMeshes = new Map();   // slotIndex -> Group
    this.hazardMeshes = new Map();   // id -> Group
    this.particles = [];

    this.minimapCanvas = null;
    this.minimapCtx = null;

    this._currentTrack = null;
  }

  async init() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x0a0c10);
    this.rootEl.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0a0c10, 1200, 2400);

    // Top-down orthographic camera. Frustum width driven by zoom.
    this.camera = new THREE.OrthographicCamera(-100, 100, 100, -100, 1, 4000);
    this.camera.position.set(0, 900, 0);
    this.camera.up.set(0, 0, -1);
    this.camera.lookAt(0, 0, 0);

    // Lighting — soft fill + directional sun for cabin/wheel highlights.
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffffff, 0.85);
    sun.position.set(600, 1000, 400);
    this.scene.add(sun);

    // Ground plane (large grey slab beneath the road).
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(8000, 8000),
      new THREE.MeshLambertMaterial({ color: 0x141821 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.scene.add(this.ground);

    // Track group — cleared and rebuilt each race.
    this.trackGroup = new THREE.Group();
    this.scene.add(this.trackGroup);

    // 2D minimap canvas inside the existing #minimap div.
    const mm = document.getElementById('minimap');
    if (mm) {
      this.minimapCanvas = document.createElement('canvas');
      this.minimapCanvas.width = 180;
      this.minimapCanvas.height = 180;
      this.minimapCanvas.style.cssText = 'width:100%;height:100%;display:block;';
      mm.appendChild(this.minimapCanvas);
      this.minimapCtx = this.minimapCanvas.getContext('2d');
    }

    window.addEventListener('resize', () => this._resize());
    this._resize();
  }

  _resize() {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this._updateFrustum();
  }

  _updateFrustum() {
    const aspect = window.innerWidth / window.innerHeight;
    // Halfheight of the visible world at zoom=1 is 420 px. Bigger zoom = closer.
    const halfH = 420 / this.cameraZoom;
    const halfW = halfH * aspect;
    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.updateProjectionMatrix();
  }

  onTick(cb) { this.tickCbs.push(cb); }
  setCameraTarget(x, y) { this._cameraTarget = { x, y }; }
  setZoom(z) { this.targetZoom = z; }
  resetCamera() { this._cameraSet = false; }

  // Driven by main.js's master rAF loop.
  _driveTick(dt) {
    // Camera smoothing — snap on first frame after a target appears.
    if (this._cameraTarget) {
      if (!this._cameraSet) {
        this.cameraPos.x = this._cameraTarget.x;
        this.cameraPos.y = this._cameraTarget.y;
        this._cameraSet = true;
      } else {
        const k = 1 - Math.pow(0.001, dt);
        this.cameraPos.x += (this._cameraTarget.x - this.cameraPos.x) * k;
        this.cameraPos.y += (this._cameraTarget.y - this.cameraPos.y) * k;
      }
    }
    this.cameraZoom += (this.targetZoom - this.cameraZoom) * (1 - Math.pow(0.001, dt));
    this._updateFrustum();
    this.camera.position.set(this.cameraPos.x, 900, this.cameraPos.y);
    this.camera.lookAt(this.cameraPos.x, 0, this.cameraPos.y);

    // Particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        p.mesh.material.dispose();
        this.particles.splice(i, 1);
        continue;
      }
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.z += p.vy * dt;
      p.vx *= 0.92;
      p.vy *= 0.92;
      p.mesh.material.opacity = Math.max(0, p.life / p.maxLife);
    }

    for (const cb of this.tickCbs) cb(dt);
    this.renderer.render(this.scene, this.camera);
  }

  // ---- Background / ground
  buildBackground(bounds) {
    if (!this.ground) return;
    const w = bounds.maxX - bounds.minX + 800;
    const h = bounds.maxY - bounds.minY + 800;
    this.ground.geometry.dispose();
    this.ground.geometry = new THREE.PlaneGeometry(w, h);
    this.ground.position.x = (bounds.minX + bounds.maxX) / 2;
    this.ground.position.z = (bounds.minY + bounds.maxY) / 2;
  }

  // ---- Track build (CSG union of trapezoid tiles)
  buildTrack(track) {
    if (!track || !track.tiles) return;     // slim snapshot; nothing to build
    this._currentTrack = track;
    // Wipe previous race's meshes.
    while (this.trackGroup.children.length) {
      const obj = this.trackGroup.children.pop();
      this._disposeNode(obj);
    }

    // Road surface: one merged BufferGeometry quad per tile.
    const roadPos = [];
    const roadIdx = [];
    let v = 0;
    for (const t of track.tiles) {
      roadPos.push(t.al.x, 0.4, t.al.y);
      roadPos.push(t.bl.x, 0.4, t.bl.y);
      roadPos.push(t.br.x, 0.4, t.br.y);
      roadPos.push(t.ar.x, 0.4, t.ar.y);
      roadIdx.push(v, v + 1, v + 2, v, v + 2, v + 3);
      v += 4;
    }
    const roadGeom = new THREE.BufferGeometry();
    roadGeom.setAttribute('position', new THREE.Float32BufferAttribute(roadPos, 3));
    roadGeom.setIndex(roadIdx);
    roadGeom.computeVertexNormals();
    const road = new THREE.Mesh(roadGeom, new THREE.MeshLambertMaterial({ color: 0x2a2f3a }));
    this.trackGroup.add(road);

    // Walls — one short box per tile-edge segment (left + right of each tile).
    // They overlap at corners, which is fine since we only render them.
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x4a5161 });
    const wallH = 22;
    for (const t of track.tiles) {
      this._wallSegment(t.al, t.bl, wallH, wallMat);
      this._wallSegment(t.ar, t.br, wallH, wallMat);
    }

    // Curbs — thin coloured strips just inside each wall.
    for (let i = 0; i < track.tiles.length; i++) {
      const t = track.tiles[i];
      const colorL = (i % 2 === 0) ? 0xff3a3a : 0xf3f3f3;
      const colorR = (i % 2 === 0) ? 0xf3f3f3 : 0xff3a3a;
      this._curbSegment(t.al, t.bl, colorL);
      this._curbSegment(t.ar, t.br, colorR);
    }

    // Start/finish checkered band.
    const s = track.start;
    const stripeMatLight = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const stripeMatDark = new THREE.MeshLambertMaterial({ color: 0x111111 });
    for (let k = -4; k <= 4; k++) {
      const px = s.x + s.nx * (k * 22);
      const pz = s.y + s.ny * (k * 22);
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(18, 0.6, 22),
        (k % 2 === 0) ? stripeMatLight : stripeMatDark,
      );
      stripe.position.set(px, 0.9, pz);
      stripe.rotation.y = -Math.atan2(s.ty, s.tx);
      this.trackGroup.add(stripe);
    }

    // Pickup meshes recreated lazily in syncPickups.
    for (const mesh of this.pickupMeshes.values()) {
      this.scene.remove(mesh);
      this._disposeNode(mesh);
    }
    this.pickupMeshes.clear();
  }

  _wallSegment(a, b, height, mat) {
    const dx = b.x - a.x, dz = b.y - a.y;
    const len = Math.hypot(dx, dz);
    if (len < 0.5) return;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(len, height, 6), mat);
    mesh.position.set((a.x + b.x) / 2, height / 2, (a.y + b.y) / 2);
    mesh.rotation.y = -Math.atan2(dz, dx);
    this.trackGroup.add(mesh);
  }

  _curbSegment(a, b, color) {
    const dx = b.x - a.x, dz = b.y - a.y;
    const len = Math.hypot(dx, dz);
    if (len < 0.5) return;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(len, 0.8, 3),
      new THREE.MeshLambertMaterial({ color }),
    );
    mesh.position.set((a.x + b.x) / 2, 0.8, (a.y + b.y) / 2);
    mesh.rotation.y = -Math.atan2(dz, dx);
    this.trackGroup.add(mesh);
  }

  // ---- Cars
  ensureCarMesh(id, colorIdx) {
    let g = this.carMeshes.get(id);
    if (g) return g;
    g = new THREE.Group();
    const colorHex = parseInt(PLAYER_COLORS[colorIdx % PLAYER_COLORS.length].replace('#', ''), 16);

    // Body — long axis along world X (= game-forward at angle 0).
    const bodyMat = new THREE.MeshLambertMaterial({ color: colorHex });
    const body = new THREE.Mesh(new THREE.BoxGeometry(56, 12, 32), bodyMat);
    body.position.y = 7;
    g.add(body);
    g.bodyMat = bodyMat;
    g.bodyColor = colorHex;

    // Cabin — smaller box slightly behind centre, slightly above body.
    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(26, 9, 26),
      new THREE.MeshLambertMaterial({ color: 0x101418 }),
    );
    cabin.position.set(-4, 16, 0);
    g.add(cabin);

    // Spoiler at the back.
    const spoiler = new THREE.Mesh(
      new THREE.BoxGeometry(4, 4, 24),
      new THREE.MeshLambertMaterial({ color: 0x0a0c10 }),
    );
    spoiler.position.set(-26, 13, 0);
    g.add(spoiler);

    // Wheels.
    const wheelMat = new THREE.MeshLambertMaterial({ color: 0x000000 });
    const wheelGeom = new THREE.CylinderGeometry(5, 5, 4, 12);
    const wheels = [[-18, -16], [-18, 16], [18, -16], [18, 16]];
    for (const [wx, wz] of wheels) {
      const w = new THREE.Mesh(wheelGeom, wheelMat);
      // Cylinders are Y-axis by default; rotate to lay them on their side.
      w.rotation.x = Math.PI / 2;
      w.position.set(wx, 3, wz);
      g.add(w);
    }

    this.scene.add(g);
    this.carMeshes.set(id, g);
    return g;
  }

  flashCar(playerId, ms = 200) {
    this.carFlashUntil.set(playerId, performance.now() + ms);
  }

  syncCars(state, t) {
    const present = new Set();
    const now = performance.now();
    for (const car of state.cars) {
      present.add(car.id);
      const colorIdx = state.players.findIndex(p => p.id === car.id);
      const g = this.ensureCarMesh(car.id, colorIdx < 0 ? 0 : colorIdx);
      g.position.x = car.x;
      g.position.z = car.y;
      // Game angle 0 = facing +X. Y-rotation in three.js with this look
      // direction: world +X stays world +X at rotation.y = 0. For game angle
      // +π/2 (= facing +Y), rotate around Y by -π/2.
      g.rotation.y = -car.a;

      // Damage flash → tint body toward red.
      const flashUntil = this.carFlashUntil.get(car.id) || 0;
      if (flashUntil > now) {
        const pct = (flashUntil - now) / 200;
        g.bodyMat.color.setHex(lerpColor(g.bodyColor, 0xff3a48, pct));
      } else {
        g.bodyMat.color.setHex(car.alive ? g.bodyColor : 0x555555);
      }

      // Boost trail
      if (car.boost > 0 && Math.random() < 0.6) {
        const ang = car.a;
        this.emitParticle(
          car.x - Math.cos(ang) * 28, car.y - Math.sin(ang) * 28,
          -car.vx * 0.15, -car.vy * 0.15, 0.4, 0xff6a3d,
        );
      }
    }
    for (const [id, g] of this.carMeshes) {
      if (!present.has(id)) {
        this.scene.remove(g);
        this._disposeNode(g);
        this.carMeshes.delete(id);
      }
    }
  }

  // ---- Pickups
  syncPickups(pickups, t) {
    for (const p of pickups) {
      let mesh = this.pickupMeshes.get(p.slotIndex);
      if (!mesh) {
        mesh = this._buildPickupMesh(p.kind);
        mesh.position.set(p.x, 14, p.y);
        this.scene.add(mesh);
        this.pickupMeshes.set(p.slotIndex, mesh);
      } else if (mesh._kind !== p.kind) {
        // Pickup respawned with a different kind — rebuild.
        this.scene.remove(mesh);
        this._disposeNode(mesh);
        mesh = this._buildPickupMesh(p.kind);
        mesh.position.set(p.x, 14, p.y);
        this.scene.add(mesh);
        this.pickupMeshes.set(p.slotIndex, mesh);
      }
      mesh.visible = !p.taken;
      if (!p.taken) {
        mesh.rotation.y = t * 2;
        mesh.position.y = 14 + Math.sin(t * 3) * 2.5;
      }
    }
  }

  _buildPickupMesh(kind) {
    const color = ({
      scrap:  0xb0b8c4,
      nitro:  0xff6a3d,
      mine:   0x222222,
      oil:    0x101010,
      repair: 0x7cf3a0,
      spikes: 0xaab0bd,
    })[kind] || 0xffffff;
    let geom;
    switch (kind) {
      case 'scrap':  geom = new THREE.BoxGeometry(14, 14, 14); break;
      case 'nitro':  geom = new THREE.ConeGeometry(9, 18, 6); break;
      case 'mine':   geom = new THREE.SphereGeometry(9, 12, 8); break;
      case 'oil':    geom = new THREE.CylinderGeometry(10, 10, 4, 12); break;
      case 'repair': geom = new THREE.OctahedronGeometry(10); break;
      case 'spikes': geom = new THREE.TetrahedronGeometry(11); break;
      default:       geom = new THREE.OctahedronGeometry(10);
    }
    const mesh = new THREE.Mesh(geom, new THREE.MeshLambertMaterial({ color }));
    mesh._kind = kind;
    return mesh;
  }

  // ---- Hazards
  syncHazards(hazards, t) {
    const present = new Set();
    for (const h of hazards) {
      present.add(h.id);
      let mesh = this.hazardMeshes.get(h.id);
      if (!mesh) {
        mesh = this._buildHazardMesh(h.kind);
        mesh.position.set(h.x, 0.6, h.y);
        this.scene.add(mesh);
        this.hazardMeshes.set(h.id, mesh);
      }
      // Mines pulse.
      if (h.kind === 'mine' && mesh.children[1]) {
        const pulse = (Math.sin(t * 8) + 1) * 0.5;
        mesh.children[1].scale.setScalar(0.8 + pulse * 0.5);
      }
    }
    for (const [id, mesh] of this.hazardMeshes) {
      if (!present.has(id)) {
        this.scene.remove(mesh);
        this._disposeNode(mesh);
        this.hazardMeshes.delete(id);
      }
    }
  }

  _buildHazardMesh(kind) {
    const group = new THREE.Group();
    if (kind === 'mine') {
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(10, 10, 4, 12),
        new THREE.MeshLambertMaterial({ color: 0x222 }),
      );
      group.add(body);
      const led = new THREE.Mesh(
        new THREE.SphereGeometry(3, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0xff3030 }),
      );
      led.position.y = 4;
      group.add(led);
    } else if (kind === 'oil') {
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(38, 24),
        new THREE.MeshBasicMaterial({ color: 0x101010, transparent: true, opacity: 0.72 }),
      );
      disc.rotation.x = -Math.PI / 2;
      group.add(disc);
    } else if (kind === 'spikes') {
      for (let i = -2; i <= 2; i++) {
        const spike = new THREE.Mesh(
          new THREE.ConeGeometry(3, 9, 4),
          new THREE.MeshLambertMaterial({ color: 0xaab0bd }),
        );
        spike.position.set(i * 6, 4.5, 0);
        group.add(spike);
      }
    }
    return group;
  }

  // ---- Particles
  emitParticle(x, y, vx, vy, life, color) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(3.5, 3.5, 3.5),
      new THREE.MeshBasicMaterial({ color, transparent: true }),
    );
    mesh.position.set(x, 10, y);
    this.scene.add(mesh);
    this.particles.push({ mesh, vx, vy, life, maxLife: life });
  }

  emitBurst(x, y, count, color = 0xff8040, speed = 240, life = 0.5) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.8);
      this.emitParticle(x, y, Math.cos(a) * s, Math.sin(a) * s, life, color);
    }
  }

  // ---- Minimap — 2D canvas inside #minimap div.
  drawMinimap(state, myId) {
    const ctx = this.minimapCtx;
    if (!ctx || !this._currentTrack || !this._currentTrack.tiles) return;
    const W = this.minimapCanvas.width;
    const H = this.minimapCanvas.height;
    ctx.clearRect(0, 0, W, H);
    const b = this._currentTrack.bounds;
    const bw = b.maxX - b.minX, bh = b.maxY - b.minY;
    const pad = 8;
    const scale = Math.min((W - pad * 2) / bw, (H - pad * 2) / bh);
    const dx = (W - bw * scale) / 2 - b.minX * scale;
    const dy = (H - bh * scale) / 2 - b.minY * scale;
    ctx.fillStyle = '#2a2f3a';
    for (const t of this._currentTrack.tiles) {
      ctx.beginPath();
      ctx.moveTo(dx + t.al.x * scale, dy + t.al.y * scale);
      ctx.lineTo(dx + t.bl.x * scale, dy + t.bl.y * scale);
      ctx.lineTo(dx + t.br.x * scale, dy + t.br.y * scale);
      ctx.lineTo(dx + t.ar.x * scale, dy + t.ar.y * scale);
      ctx.closePath();
      ctx.fill();
    }
    for (const car of state.cars) {
      const colorIdx = state.players.findIndex(p => p.id === car.id);
      ctx.fillStyle = PLAYER_COLORS[(colorIdx < 0 ? 0 : colorIdx) % PLAYER_COLORS.length];
      const cx = dx + car.x * scale;
      const cy = dy + car.y * scale;
      ctx.beginPath();
      ctx.arc(cx, cy, car.id === myId ? 4 : 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- Utility
  _disposeNode(node) {
    node.traverse?.((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
        else o.material.dispose();
      }
    });
    if (node.geometry) node.geometry.dispose();
    if (node.material) {
      if (Array.isArray(node.material)) node.material.forEach(m => m.dispose());
      else node.material.dispose();
    }
  }
}
