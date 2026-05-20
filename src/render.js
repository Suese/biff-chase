// Three.js renderer — tilted top-down view, continuous track geometry,
// PBR-lit 3D primitives. Gameplay/physics stays 2D; (x, y) → (x, 0, y).

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { PLAYER_COLORS } from './colors.js';
import { ITEMS } from './items.js';

function lerpColor(a, b, t) {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  return ((ar + (br - ar) * t) | 0) << 16 | ((ag + (bg - ag) * t) | 0) << 8 | ((ab + (bb - ab) * t) | 0);
}

// Closed Chaikin subdivision (one pass) — softens sharp corners on a ring.
function chaikinSmoothRing(pts) {
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

// Build a closed ring of {left, right} edge points from a centerline +
// widths array. Miter-limited so it survives sharp corners; then a Chaikin
// pass is applied to left + right edges to round out any residual kinks.
function buildEdgeRing(centerline, widths, miterLimit = 2.8) {
  const N = centerline.length;
  const left = new Array(N);
  const right = new Array(N);
  for (let i = 0; i < N; i++) {
    const prev = centerline[(i - 1 + N) % N];
    const cur  = centerline[i];
    const next = centerline[(i + 1) % N];
    let ix = cur.x - prev.x, iy = cur.y - prev.y;
    const il = Math.hypot(ix, iy) || 1;
    ix /= il; iy /= il;
    let ox = next.x - cur.x, oy = next.y - cur.y;
    const ol = Math.hypot(ox, oy) || 1;
    ox /= ol; oy /= ol;
    let bx = ix + ox, by = iy + oy;
    const bl = Math.hypot(bx, by);
    let perpX, perpY;
    if (bl < 1e-3) { perpX = -iy; perpY = ix; }
    else           { bx /= bl; by /= bl; perpX = -by; perpY = bx; }
    const inPerpX = -iy, inPerpY = ix;
    const dot = Math.abs(perpX * inPerpX + perpY * inPerpY);
    let scale = 1 / Math.max(0.001, dot);
    if (scale > miterLimit) scale = miterLimit;
    const halfW = widths[i] * 0.5 * scale;
    left[i]  = { x: cur.x + perpX * halfW, y: cur.y + perpY * halfW };
    right[i] = { x: cur.x - perpX * halfW, y: cur.y - perpY * halfW };
  }
  // One Chaikin pass on each edge smooths residual jutting at sharp corners.
  const smL = chaikinSmoothRing(left);
  const smR = chaikinSmoothRing(right);
  const M = smL.length;
  const ring = new Array(M);
  for (let i = 0; i < M; i++) ring[i] = { left: smL[i], right: smR[i] };
  return ring;
}

export class RallyScene {
  constructor(rootEl) {
    this.rootEl = rootEl;
    this.renderer = null;
    this.scene = null;
    this.camera = null;

    this.cameraPos = { x: 0, z: 0 };
    this.cameraZoom = 1.0;
    this.targetZoom = 1.0;
    this._cameraTarget = null;
    this._cameraSet = false;

    this.tickCbs = [];
    this.trackGroup = null;
    this.carMeshes = new Map();
    this.carFlashUntil = new Map();
    this.pickupMeshes = new Map();
    this.hazardMeshes = new Map();
    this.particles = [];

    this.minimapCanvas = null;
    this.minimapCtx = null;
    this._minimapRing = null;

    // Skid marks pile up on the road and fade after a while. Stored as a
    // ring buffer so they're cheap to manage.
    this.skidGroup = null;
    this.skidMarks = [];           // { mesh, born }
    this.skidMaxCount = 220;
    this.skidLifeSec = 9;

    this._currentTrack = null;
  }

  async init() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x0a0e16);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Film-style tone mapping makes the PBR lighting feel cinematic instead
    // of flat. Exposure dialled in to taste.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.rootEl.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    // Fog in metres: starts at ~110m out, vanishes by 300m.
    this.scene.fog = new THREE.Fog(0x0a0e16, 110, 300);

    // ---- Image-Based Lighting from Three.js's prebaked RoomEnvironment.
    // Pre-filtered into a PMREM cubemap so every MeshStandardMaterial /
    // MeshPhysicalMaterial in the scene picks up soft, broadband ambient
    // reflections. This is what makes the car paint actually look like
    // glossy lacquer instead of flat plastic.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    const envScene = new RoomEnvironment(this.renderer);
    this.scene.environment = pmrem.fromScene(envScene, 0.04).texture;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.5, 800);
    this.camera.position.set(0, 60, 16);
    this.camera.lookAt(0, 0, 0);

    // PBR-style lighting (intensities tuned for ACES tone mapping).
    const sun = new THREE.DirectionalLight(0xfff0d8, 3.4);
    sun.position.set(80, 140, 60);
    this.scene.add(sun);
    const hemi = new THREE.HemisphereLight(0x88a0c8, 0x1a1410, 1.5);
    this.scene.add(hemi);

    // Ground — dark slab beneath the road.
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(800, 800),
      new THREE.MeshStandardMaterial({ color: 0x0f131c, roughness: 0.95, metalness: 0.0 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.05;
    this.scene.add(this.ground);

    this.trackGroup = new THREE.Group();
    this.scene.add(this.trackGroup);

    // Skid marks live outside the track group so they survive a track rebuild
    // (we clear them explicitly).
    this.skidGroup = new THREE.Group();
    this.scene.add(this.skidGroup);

    // Minimap 2D overlay.
    const mm = document.getElementById('minimap');
    if (mm) {
      this.minimapCanvas = document.createElement('canvas');
      this.minimapCanvas.width = 200;
      this.minimapCanvas.height = 200;
      this.minimapCanvas.style.cssText = 'width:100%;height:100%;display:block;';
      mm.appendChild(this.minimapCanvas);
      this.minimapCtx = this.minimapCanvas.getContext('2d');
    }

    window.addEventListener('resize', () => this._resize());
    this._resize();
  }

  _resize() {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  onTick(cb) { this.tickCbs.push(cb); }
  setCameraTarget(x, y, _angleIgnored = null) { this._cameraTarget = { x, y }; }
  setZoom(z) { this.targetZoom = z; }
  resetCamera() { this._cameraSet = false; }

  _driveTick(dt) {
    // ---- Position-only follow. World orientation stays fixed.
    if (this._cameraTarget) {
      const tgt = this._cameraTarget;
      if (!this._cameraSet) {
        this.cameraPos.x = tgt.x;
        this.cameraPos.z = tgt.y;
        this._cameraSet = true;
      } else {
        const kPos = 1 - Math.pow(0.001, dt);
        this.cameraPos.x += (tgt.x - this.cameraPos.x) * kPos;
        this.cameraPos.z += (tgt.y - this.cameraPos.z) * kPos;
      }
    }
    this.cameraZoom += (this.targetZoom - this.cameraZoom) * (1 - Math.pow(0.001, dt));

    // Tilted top-down — camera ~60m above with a 16m +Z offset (≈15° tilt
    // from vertical). The lookAt sits at the car's vertical centre so the
    // car visually sits at the screen centre.
    const height  = 60 / this.cameraZoom;
    const offsetZ = 16 / this.cameraZoom;
    this.camera.position.set(
      this.cameraPos.x,
      height,
      this.cameraPos.z + offsetZ,
    );
    this.camera.lookAt(this.cameraPos.x, 0.8, this.cameraPos.z);

    // ---- Particles (sparks): arc with gravity, fade out.
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
      p.mesh.position.y += p.vyW * dt;
      p.vx *= 0.92; p.vy *= 0.92;
      p.vyW -= 14 * dt;       // gravity in m/s²
      p.mesh.material.opacity = Math.max(0, p.life / p.maxLife);
    }

    // ---- Per-car wheel spin (rolling at speed). _wheelSpeed is m/s,
    // wheel radius is 0.35m → ω = v/r rad/s.
    const tNow = performance.now() / 1000;
    for (const g of this.carMeshes.values()) {
      if (g._lastWheelSpinT == null) g._lastWheelSpinT = tNow;
      const spinDt = tNow - g._lastWheelSpinT;
      g._lastWheelSpinT = tNow;
      const wheelDelta = (g._wheelSpeed || 0) * spinDt / 0.35;
      if (g.wheels) for (const w of g.wheels) w.rotation.y += wheelDelta;
    }

    // ---- Skid mark lifecycle — fade by remaining life.
    if (this.skidMarks.length) {
      const t = performance.now() / 1000;
      for (let i = this.skidMarks.length - 1; i >= 0; i--) {
        const s = this.skidMarks[i];
        const age = t - s.born;
        if (age >= this.skidLifeSec) {
          this.skidGroup.remove(s.mesh);
          this._disposeNode(s.mesh);
          this.skidMarks.splice(i, 1);
        } else {
          s.mesh.material.opacity = Math.max(0, 1 - age / this.skidLifeSec) * 0.55;
        }
      }
    }

    for (const cb of this.tickCbs) cb(dt);
    this.renderer.render(this.scene, this.camera);
  }

  // ---- Background / ground
  buildBackground(bounds) {
    if (!this.ground) return;
    const w = (bounds.maxX - bounds.minX) + 200;     // 200m of skirt
    const h = (bounds.maxY - bounds.minY) + 200;
    this.ground.geometry.dispose();
    this.ground.geometry = new THREE.PlaneGeometry(w, h);
    this.ground.position.x = (bounds.minX + bounds.maxX) / 2;
    this.ground.position.z = (bounds.minY + bounds.maxY) / 2;
  }

  // ---- Track build (continuous geometry — no per-tile seams)
  buildTrack(track) {
    if (!track || !track.centerline || !track.widths) return;
    this._currentTrack = track;

    while (this.trackGroup.children.length) {
      const obj = this.trackGroup.children.pop();
      this._disposeNode(obj);
    }
    // Fresh track → clear any leftover skid marks.
    while (this.skidGroup.children.length) {
      const obj = this.skidGroup.children.pop();
      this._disposeNode(obj);
    }
    this.skidMarks.length = 0;
    for (const mesh of this.pickupMeshes.values()) {
      this.scene.remove(mesh);
      this._disposeNode(mesh);
    }
    this.pickupMeshes.clear();

    const ring = buildEdgeRing(track.centerline, track.widths);
    this._minimapRing = ring;
    const N = ring.length;

    // Road — single closed strip lifted a few centimetres above the ground.
    const roadPos = new Float32Array(N * 2 * 3);
    const roadCol = new Float32Array(N * 2 * 3);
    for (let i = 0; i < N; i++) {
      const l = ring[i].left, r = ring[i].right;
      roadPos[i * 6 + 0] = l.x; roadPos[i * 6 + 1] = 0.05; roadPos[i * 6 + 2] = l.y;
      roadPos[i * 6 + 3] = r.x; roadPos[i * 6 + 4] = 0.05; roadPos[i * 6 + 5] = r.y;
      const n = (Math.sin(i * 0.43) * 0.5 + 0.5) * 0.06 + 0.34;
      roadCol[i * 6 + 0] = n;       roadCol[i * 6 + 1] = n + 0.01; roadCol[i * 6 + 2] = n + 0.04;
      roadCol[i * 6 + 3] = n + 0.02; roadCol[i * 6 + 4] = n + 0.03; roadCol[i * 6 + 5] = n + 0.06;
    }
    const roadIdx = [];
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const a = i * 2, b = i * 2 + 1, c = j * 2, d = j * 2 + 1;
      roadIdx.push(a, c, d, a, d, b);
    }
    const roadGeom = new THREE.BufferGeometry();
    roadGeom.setAttribute('position', new THREE.BufferAttribute(roadPos, 3));
    roadGeom.setAttribute('color',    new THREE.BufferAttribute(roadCol, 3));
    roadGeom.setIndex(roadIdx);
    roadGeom.computeVertexNormals();
    const road = new THREE.Mesh(
      roadGeom,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 }),
    );
    this.trackGroup.add(road);

    // Walls — continuous concrete ribbons, ~1.2m tall.
    const wallHeight = 1.2;
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x3a4050, roughness: 0.7, metalness: 0.0 });
    this.trackGroup.add(this._buildWallRibbon(ring, 'left', wallHeight, wallMat));
    this.trackGroup.add(this._buildWallRibbon(ring, 'right', wallHeight, wallMat));

    // Bright accent rail along the top of each wall.
    const rail = new THREE.MeshStandardMaterial({ color: 0xff6a3d, emissive: 0xff3a10, emissiveIntensity: 0.25, roughness: 0.4 });
    this.trackGroup.add(this._buildRailRibbon(ring, 'left', wallHeight, rail));
    this.trackGroup.add(this._buildRailRibbon(ring, 'right', wallHeight, rail));

    // Curbs — red/white inset strip on the road.
    this.trackGroup.add(this._buildCurbRibbon(ring, 'left'));
    this.trackGroup.add(this._buildCurbRibbon(ring, 'right'));

    // Centerline dashes — 2m long every ~15m of road.
    const dashes = new THREE.Group();
    const dashMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.08, roughness: 0.6 });
    for (let i = 0; i < track.centerline.length; i += 5) {
      const a = track.centerline[i];
      const b = track.centerline[(i + 1) % track.centerline.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 0.1) continue;
      const dash = new THREE.Mesh(new THREE.BoxGeometry(Math.min(len * 0.7, 2.0), 0.04, 0.2), dashMat);
      dash.position.set((a.x + b.x) / 2, 0.07, (a.y + b.y) / 2);
      dash.rotation.y = -Math.atan2(dy, dx);
      dashes.add(dash);
    }
    this.trackGroup.add(dashes);

    // Start/finish checkered band — 0.5m × 0.8m stripes.
    const s = track.start;
    const matLight = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
    const matDark  = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.7 });
    const numStripes = Math.max(4, Math.floor(s.width / 1.5));
    for (let k = -numStripes; k <= numStripes; k++) {
      const px = s.x + s.nx * (k * 0.8);
      const pz = s.y + s.ny * (k * 0.8);
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(1.6, 0.06, 0.8),
        (k % 2 === 0) ? matLight : matDark,
      );
      stripe.position.set(px, 0.08, pz);
      stripe.rotation.y = -Math.atan2(s.ty, s.tx);
      this.trackGroup.add(stripe);
    }
  }

  _buildWallRibbon(ring, side, height, mat) {
    const N = ring.length;
    const positions = new Float32Array(N * 2 * 3);
    for (let i = 0; i < N; i++) {
      const p = ring[i][side];
      positions[i * 6 + 0] = p.x; positions[i * 6 + 1] = 0;      positions[i * 6 + 2] = p.y;
      positions[i * 6 + 3] = p.x; positions[i * 6 + 4] = height; positions[i * 6 + 5] = p.y;
    }
    const indices = [];
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const a = i * 2, b = i * 2 + 1, c = j * 2, d = j * 2 + 1;
      if (side === 'left') indices.push(a, b, d, a, d, c);
      else                 indices.push(a, c, d, a, d, b);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    return new THREE.Mesh(geom, mat);
  }

  _buildRailRibbon(ring, side, height, mat) {
    const N = ring.length;
    const positions = new Float32Array(N * 2 * 3);
    const inset = 0.15;        // 15cm wide rail
    for (let i = 0; i < N; i++) {
      const p = ring[i][side];
      const other = ring[i][side === 'left' ? 'right' : 'left'];
      const dx = other.x - p.x, dy = other.y - p.y;
      const dl = Math.hypot(dx, dy) || 1;
      const inX = dx / dl, inY = dy / dl;
      positions[i * 6 + 0] = p.x;             positions[i * 6 + 1] = height + 0.05; positions[i * 6 + 2] = p.y;
      positions[i * 6 + 3] = p.x + inX * inset; positions[i * 6 + 4] = height + 0.05; positions[i * 6 + 5] = p.y + inY * inset;
    }
    const indices = [];
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const a = i * 2, b = i * 2 + 1, c = j * 2, d = j * 2 + 1;
      indices.push(a, c, d, a, d, b);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    return new THREE.Mesh(geom, mat);
  }

  _buildCurbRibbon(ring, side) {
    const N = ring.length;
    const positions = [];
    const indices = [];
    const colors = [];
    const inset = 0.6;       // 60cm-wide curb strip
    for (let i = 0; i < N; i++) {
      const p = ring[i][side];
      const other = ring[i][side === 'left' ? 'right' : 'left'];
      const dx = other.x - p.x, dy = other.y - p.y;
      const dl = Math.hypot(dx, dy) || 1;
      const inX = dx / dl, inY = dy / dl;
      positions.push(p.x + inX * inset, 0.08, p.y + inY * inset);
      positions.push(p.x,                0.08, p.y);
      const col = ((i % 6 < 3) ? 0xff3a3a : 0xf3f3f3);
      const r = ((col >> 16) & 0xff) / 255;
      const g = ((col >> 8)  & 0xff) / 255;
      const b = ( col        & 0xff) / 255;
      colors.push(r, g, b, r, g, b);
    }
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const a = i * 2, b = i * 2 + 1, c = j * 2, d = j * 2 + 1;
      indices.push(a, c, d, a, d, b);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('color',    new THREE.Float32BufferAttribute(colors, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    return new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15 }));
  }

  // ---- Cars — built to real-world proportions. 4.5m long, 1.8m wide.
  // Long axis along +X (= game forward at angle 0). All dimensions in metres.
  ensureCarMesh(id, colorIdx) {
    let g = this.carMeshes.get(id);
    if (g) return g;
    g = new THREE.Group();
    const colorHex = parseInt(PLAYER_COLORS[colorIdx % PLAYER_COLORS.length].replace('#', ''), 16);

    // Glossy automotive paint: pigment + clearcoat layer that reflects the
    // PMREM environment map. envMapIntensity dialled up so the reflection
    // really pops on a dark track.
    const paint  = new THREE.MeshPhysicalMaterial({
      color: colorHex,
      metalness: 0.6,
      roughness: 0.22,
      clearcoat: 0.95,
      clearcoatRoughness: 0.10,
      envMapIntensity: 1.4,
      emissive: colorHex,
      emissiveIntensity: 0.03,
    });
    const black  = new THREE.MeshPhysicalMaterial({
      color: 0x0a0c10,
      metalness: 0.5,
      roughness: 0.35,
      clearcoat: 0.4,
      clearcoatRoughness: 0.2,
      envMapIntensity: 1.0,
    });
    // Tinted glass — high reflective, smooth, dark base; envmap really sells it.
    const tinted = new THREE.MeshPhysicalMaterial({
      color: 0x0a0e16,
      metalness: 0.0,
      roughness: 0.05,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      transmission: 0.0,
      envMapIntensity: 1.6,
    });

    // ---- Coupe / roadster silhouette: long front (engine bay), short
    // compact cabin, very short rear deck. Heavily front-heavy look that
    // matches the RWD power-oversteer feel of the physics.
    //
    // Reference: 4.5m long, 1.8m wide. The +X direction is forward.

    // Under-chassis slab.
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.18, 1.8), black);
    chassis.position.y = 0.32;
    g.add(chassis);

    // Front bumper — wraps around the leading edge.
    const frontBumper = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.45, 1.8), paint);
    frontBumper.position.set(2.07, 0.55, 0);
    g.add(frontBumper);

    // LONG hood — dominates the front half.
    const hood = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.5, 1.7), paint);
    hood.position.set(1.0, 0.7, 0);
    g.add(hood);

    // Cowl / engine bay rise — slightly taller right before the windshield.
    const cowl = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.65, 1.65), paint);
    cowl.position.set(0.0, 0.85, 0);
    g.add(cowl);

    // Compact cabin (greenhouse). Set back from the leading edge with a
    // chopped-roof look — narrower than the body for proper coupe proportions.
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.55, 1.55), paint);
    cabin.position.set(-0.55, 1.18, 0);
    g.add(cabin);

    // Tinted glass on top of the cabin — slightly inset.
    const glass = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.4, 1.4), tinted);
    glass.position.set(-0.55, 1.65, 0);
    g.add(glass);

    // Short rear deck — drops down behind the cabin like a fastback.
    const rearDeck = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.45, 1.7), paint);
    rearDeck.position.set(-1.6, 0.78, 0);
    g.add(rearDeck);

    // Rear bumper.
    const rearBumper = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.45, 1.75), paint);
    rearBumper.position.set(-2.15, 0.55, 0);
    g.add(rearBumper);

    // Hood scoop (small detail on top of the hood).
    const scoop = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.7), black);
    scoop.position.set(1.4, 1.01, 0);
    g.add(scoop);

    // Twin headlights — bright emissive cubes, narrow.
    const hl = new THREE.MeshStandardMaterial({ color: 0xfff0a0, emissive: 0xfff0a0, emissiveIntensity: 1.4, metalness: 0.2, roughness: 0.4 });
    for (const wz of [-0.5, 0.5]) {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.18, 0.36), hl);
      lamp.position.set(2.24, 0.62, wz);
      g.add(lamp);
    }
    // Tail lights — full-width strip.
    const tl = new THREE.MeshStandardMaterial({ color: 0xff2030, emissive: 0xff1020, emissiveIntensity: 1.0, roughness: 0.4 });
    const tailStrip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.18, 1.4), tl);
    tailStrip.position.set(-2.33, 0.62, 0);
    g.add(tailStrip);

    // Subtle ducktail spoiler at the back of the deck.
    const spoiler = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.06, 1.55), black);
    spoiler.position.set(-2.05, 1.04, 0);
    g.add(spoiler);

    const wheelPositions = [[-1.4, -0.85], [-1.4, 0.85], [1.4, -0.85], [1.4, 0.85]];

    // ---- Wheels — 0.35m radius rubber + brighter rim cap.
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 0.85 });
    const rimMat  = new THREE.MeshStandardMaterial({ color: 0xc0c0c0, metalness: 0.85, roughness: 0.25 });
    g.wheels = [];
    for (const [wx, wz] of wheelPositions) {
      const outer = new THREE.Group();
      outer.position.set(wx, 0.35, wz);
      outer.rotation.x = Math.PI / 2;
      const inner = new THREE.Group();
      inner.add(new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.32, 16), tireMat));
      inner.add(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.34, 12), rimMat));
      outer.add(inner);
      g.add(outer);
      g.wheels.push(inner);
    }

    g.paintMat = paint;
    g.paintColor = colorHex;
    g._wheelSpeed = 0;
    // Keep the world-space positions of the rear two tyres so we can drop
    // skid marks behind them when the car is drifting.
    g._rearWheelOffsets = [
      { x: -1.4, z: -0.85 },
      { x: -1.4, z:  0.85 },
    ];
    g._lastSkidT = 0;

    this.scene.add(g);
    this.carMeshes.set(id, g);
    return g;
  }

  flashCar(playerId, ms = 200) {
    this.carFlashUntil.set(playerId, performance.now() + ms);
  }

  // Drop a short black streak on the road behind the rear wheels of a car.
  // Called by syncCars once per drifting car per frame (rate-limited per car).
  emitSkidMark(worldX, worldZ, carYaw) {
    if (this.skidMarks.length >= this.skidMaxCount) {
      // Recycle the oldest.
      const oldest = this.skidMarks.shift();
      this.skidGroup.remove(oldest.mesh);
      this._disposeNode(oldest.mesh);
    }
    const geom = new THREE.PlaneGeometry(0.55, 0.18);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x080808,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = carYaw;
    mesh.position.set(worldX, 0.08, worldZ);
    this.skidGroup.add(mesh);
    this.skidMarks.push({ mesh, born: performance.now() / 1000 });
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
      g.rotation.y = -car.a;

      const flashUntil = this.carFlashUntil.get(car.id) || 0;
      if (flashUntil > now) {
        const pct = (flashUntil - now) / 200;
        g.paintMat.color.setHex(lerpColor(g.paintColor, 0xff3a48, pct));
      } else if (!car.alive) {
        g.paintMat.color.setHex(0x555555);
      } else {
        g.paintMat.color.setHex(g.paintColor);
      }

      // Cache speed so the wheel-roll tick can spin wheels at the right rate.
      g._wheelSpeed = Math.hypot(car.vx, car.vy);

      // Skid marks behind the rear wheels when actively drifting and moving.
      if ((car.drift || 0) > 0.35 && g._wheelSpeed > 4) {
        const tNow = performance.now() / 1000;
        if (tNow - (g._lastSkidT || 0) > 0.045) {
          g._lastSkidT = tNow;
          // Body-space rear wheel offsets → world space via the car's yaw.
          const cosA = Math.cos(car.a), sinA = Math.sin(car.a);
          for (const off of g._rearWheelOffsets) {
            const wx = car.x + off.x * cosA - off.z * sinA;
            const wz = car.y + off.x * sinA + off.z * cosA;
            this.emitSkidMark(wx, wz, car.a);
          }
        }
      }

      // Boost trail — sparks just behind the exhaust.
      if (car.boost > 0 && Math.random() < 0.7) {
        const ang = car.a;
        this.emitParticle(
          car.x - Math.cos(ang) * 2.4, car.y - Math.sin(ang) * 2.4,
          -car.vx * 0.18, -car.vy * 0.18, 0.45, 0xff7c30,
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

  // ---- Pickups — ~1.2m floating shapes that bob 0.5m above the road.
  syncPickups(pickups, t) {
    for (const p of pickups) {
      let mesh = this.pickupMeshes.get(p.slotIndex);
      if (!mesh || mesh._kind !== p.kind) {
        if (mesh) { this.scene.remove(mesh); this._disposeNode(mesh); }
        mesh = this._buildPickupMesh(p.kind);
        mesh.position.set(p.x, 1.4, p.y);
        this.scene.add(mesh);
        this.pickupMeshes.set(p.slotIndex, mesh);
      }
      mesh.visible = !p.taken;
      if (!p.taken) {
        mesh.rotation.y = t * 2.6;
        mesh.position.y = 1.4 + Math.sin(t * 3 + p.slotIndex) * 0.25;
        if (mesh.userData.coreMat) {
          mesh.userData.coreMat.emissiveIntensity = 0.55 + Math.sin(t * 5 + p.slotIndex) * 0.35;
        }
      }
    }
  }

  _buildPickupMesh(kind) {
    const baseColor = ({
      scrap:  0xc8d0dc,
      nitro:  0xff7c30,
      mine:   0x2a2a2a,
      oil:    0x101010,
      repair: 0x7cf3a0,
      spikes: 0xc0c8d4,
    })[kind] || 0xffffff;

    let geom;
    switch (kind) {
      case 'scrap':  geom = new THREE.BoxGeometry(0.9, 0.9, 0.9); break;
      case 'nitro':  geom = new THREE.ConeGeometry(0.55, 1.2, 6); break;
      case 'mine':   geom = new THREE.IcosahedronGeometry(0.7, 0); break;
      case 'oil':    geom = new THREE.CylinderGeometry(0.6, 0.6, 0.3, 16); break;
      case 'repair': geom = new THREE.OctahedronGeometry(0.7); break;
      case 'spikes': geom = new THREE.TetrahedronGeometry(0.85); break;
      default:       geom = new THREE.OctahedronGeometry(0.6);
    }
    const coreMat = new THREE.MeshStandardMaterial({
      color: baseColor,
      emissive: baseColor,
      emissiveIntensity: 0.6,
      metalness: 0.4,
      roughness: 0.35,
    });
    const core = new THREE.Mesh(geom, coreMat);

    // Halo — flat disc on the ground beneath the floating pickup.
    const haloMat = new THREE.MeshBasicMaterial({ color: baseColor, transparent: true, opacity: 0.28, side: THREE.DoubleSide });
    const halo = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.4, 24), haloMat);
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = -1.35;

    const group = new THREE.Group();
    group.add(core);
    group.add(halo);
    group._kind = kind;
    group.userData.coreMat = coreMat;
    return group;
  }

  // ---- Hazards
  syncHazards(hazards, t) {
    const present = new Set();
    for (const h of hazards) {
      present.add(h.id);
      let mesh = this.hazardMeshes.get(h.id);
      if (!mesh) {
        mesh = this._buildHazardMesh(h.kind);
        mesh.position.set(h.x, 0.06, h.y);
        this.scene.add(mesh);
        this.hazardMeshes.set(h.id, mesh);
      }
      if (h.kind === 'mine' && mesh.userData.led) {
        const pulse = (Math.sin(t * 9) + 1) * 0.5;
        mesh.userData.led.material.emissiveIntensity = 0.6 + pulse * 1.6;
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
      group.add(new THREE.Mesh(
        new THREE.CylinderGeometry(0.7, 0.8, 0.4, 18),
        new THREE.MeshStandardMaterial({ color: 0x202020, metalness: 0.4, roughness: 0.5 }),
      ));
      const ledMat = new THREE.MeshStandardMaterial({ color: 0xff3030, emissive: 0xff1020, emissiveIntensity: 1.2 });
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 10), ledMat);
      led.position.y = 0.3;
      group.add(led);
      group.userData.led = led;
    } else if (kind === 'oil') {
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(2.4, 28),
        new THREE.MeshStandardMaterial({ color: 0x0a0a0c, metalness: 0.85, roughness: 0.05, transparent: true, opacity: 0.85 }),
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.01;
      group.add(disc);
    } else if (kind === 'spikes') {
      for (let i = -2; i <= 2; i++) {
        const spike = new THREE.Mesh(
          new THREE.ConeGeometry(0.18, 0.55, 5),
          new THREE.MeshStandardMaterial({ color: 0xb0b8c4, metalness: 0.7, roughness: 0.3 }),
        );
        spike.position.set(i * 0.35, 0.27, 0);
        group.add(spike);
      }
    }
    return group;
  }

  // ---- Particles (sparks) — 0.18m cubes that arc with gravity (m/s²).
  emitParticle(x, y, vx, vy, life, color) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.18, 0.18),
      new THREE.MeshBasicMaterial({ color, transparent: true }),
    );
    mesh.position.set(x, 0.8, y);
    this.scene.add(mesh);
    this.particles.push({ mesh, vx, vy, vyW: 6 + Math.random() * 6, life, maxLife: life });
  }

  emitBurst(x, y, count, color = 0xff8040, speed = 18, life = 0.5) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.8);
      this.emitParticle(x, y, Math.cos(a) * s, Math.sin(a) * s, life, color);
    }
  }

  // ---- Minimap
  drawMinimap(state, myId) {
    const ctx = this.minimapCtx;
    const ring = this._minimapRing;
    if (!ctx || !this._currentTrack || !ring) return;
    const W = this.minimapCanvas.width;
    const H = this.minimapCanvas.height;
    ctx.clearRect(0, 0, W, H);
    const b = this._currentTrack.bounds;
    const bw = b.maxX - b.minX, bh = b.maxY - b.minY;
    const pad = 10;
    const scale = Math.min((W - pad * 2) / bw, (H - pad * 2) / bh);
    const dx = (W - bw * scale) / 2 - b.minX * scale;
    const dy = (H - bh * scale) / 2 - b.minY * scale;
    ctx.fillStyle = '#2a2f3a';
    ctx.beginPath();
    ctx.moveTo(dx + ring[0].left.x * scale, dy + ring[0].left.y * scale);
    for (let i = 1; i < ring.length; i++) ctx.lineTo(dx + ring[i].left.x * scale, dy + ring[i].left.y * scale);
    ctx.closePath();
    for (let i = ring.length - 1; i >= 0; i--) ctx.lineTo(dx + ring[i].right.x * scale, dy + ring[i].right.y * scale);
    ctx.fill('evenodd');
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
