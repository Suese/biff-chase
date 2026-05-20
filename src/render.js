// Three.js renderer with a proper 3D chase camera and a continuous track
// mesh (no per-tile seams). Game logic stays 2D — coordinates (x, y) map
// to world (x, 0, y); rotation around game's Z axis becomes rotation about
// world Y.
//
// Design notes:
//
//  * Track surface and walls are built from a single "edge ring": for each
//    centerline vertex we compute a miter-limited offset that flows
//    smoothly into both neighbouring segments. That ring drives ONE
//    BufferGeometry triangle strip for the road and two more for the
//    left/right walls — no per-segment quads, no seams, no gaps.
//
//  * Camera is a PerspectiveCamera that chases the local player's car. It
//    rotates lazily (low damping) so a sharp steer doesn't whip the world
//    around, but you still get an over-the-shoulder feel as the car turns.
//
//  * Each visual element (road, walls, cars, pickups, hazards, particles)
//    is a Three.js Object3D living in this.scene; per-frame we just update
//    transforms and material colours.

import * as THREE from 'three';
import { PLAYER_COLORS } from './colors.js';
import { ITEMS } from './items.js';

function lerpColor(a, b, t) {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  return ((ar + (br - ar) * t) | 0) << 16 | ((ag + (bg - ag) * t) | 0) << 8 | ((ab + (bb - ab) * t) | 0);
}

function shortestAngleDelta(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// Build a closed ring of {left, right} world-space points from a centerline
// + widths array. Each vertex uses the BISECTOR of its incoming/outgoing
// tangents, scaled by 1/cos(half-angle) to keep perpendicular distance from
// the centerline constant on bends — with a miter limit so sharp corners
// don't blow up to infinity. This is the standard polyline-offset construction.
function buildEdgeRing(centerline, widths, miterLimit = 2.8) {
  const N = centerline.length;
  const ring = new Array(N);
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
    let perpX, perpY;
    const bl = Math.hypot(bx, by);
    if (bl < 1e-3) {
      // 180° reversal — bisector undefined; use incoming-tangent perpendicular.
      perpX = -iy; perpY = ix;
    } else {
      bx /= bl; by /= bl;
      perpX = -by; perpY = bx;
    }
    const inPerpX = -iy, inPerpY = ix;
    const dot = Math.abs(perpX * inPerpX + perpY * inPerpY);
    let scale = 1 / Math.max(0.001, dot);
    if (scale > miterLimit) scale = miterLimit;
    const halfW = widths[i] * 0.5 * scale;
    ring[i] = {
      left:  { x: cur.x + perpX * halfW, y: cur.y + perpY * halfW },
      right: { x: cur.x - perpX * halfW, y: cur.y - perpY * halfW },
    };
  }
  return ring;
}

export class RallyScene {
  constructor(rootEl) {
    this.rootEl = rootEl;
    this.renderer = null;
    this.scene = null;
    this.camera = null;

    // Camera follow state. Position lerps to the local player; angle lerps
    // lazily so the world doesn't spin under the player's hand.
    this.cameraPos = { x: 0, z: 0 };
    this.cameraAngle = 0;
    this.cameraZoom = 1.0;
    this.targetZoom = 1.0;
    this._cameraTarget = null;     // { x, y, angle }
    this._cameraSet = false;

    this.tickCbs = [];
    this.trackGroup = null;
    this.carMeshes = new Map();      // id -> Group
    this.carFlashUntil = new Map();
    this.pickupMeshes = new Map();   // slotIndex -> Mesh
    this.hazardMeshes = new Map();   // id -> Mesh
    this.particles = [];

    this.minimapCanvas = null;
    this.minimapCtx = null;
    this._minimapRing = null;        // cached for fast redraw

    this._currentTrack = null;
  }

  async init() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x05070a);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.rootEl.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    // Subtle distance fog — sells depth + hides the world's edge.
    this.scene.fog = new THREE.Fog(0x05070a, 900, 2400);

    // PerspectiveCamera — chase cam. FOV tuned wide enough for arcade feel
    // without too much fish-eye.
    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 1, 5000);
    this.camera.position.set(0, 250, 250);
    this.camera.lookAt(0, 0, 0);

    // Lighting: directional sun + warm ambient + a subtle hemisphere fill
    // so shadowed sides aren't pitch black.
    const sun = new THREE.DirectionalLight(0xfff0d8, 1.05);
    sun.position.set(400, 800, 200);
    this.scene.add(sun);
    const hemi = new THREE.HemisphereLight(0xa0c0ff, 0x202028, 0.45);
    this.scene.add(hemi);
    const ambient = new THREE.AmbientLight(0xffffff, 0.18);
    this.scene.add(ambient);

    // Ground — large dark plane below everything.
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(10000, 10000),
      new THREE.MeshLambertMaterial({ color: 0x0c1018 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -1;
    this.scene.add(this.ground);

    // Group for everything the track owns (road, walls, curbs, start line,
    // pickups, hazards). Rebuilt on track change.
    this.trackGroup = new THREE.Group();
    this.scene.add(this.trackGroup);

    // 2D minimap overlay.
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
  // setCameraTarget(x, y) or (x, y, angle) — angle in game-radians, see main.js.
  setCameraTarget(x, y, angle = null) { this._cameraTarget = { x, y, angle }; }
  setZoom(z) { this.targetZoom = z; }
  resetCamera() { this._cameraSet = false; }

  _driveTick(dt) {
    // ---- Camera follow (position only). World orientation stays fixed —
    // the car spins in place, the camera doesn't whip around behind it.
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

    // Tilted top-down. Camera high above the target, with a small +Z offset
    // so the view tilts forward by ~15° from vertical — enough to give 3D
    // depth without losing the top-down readability.
    const height  = 360 / this.cameraZoom;
    const offsetZ =  90 / this.cameraZoom;
    this.camera.position.set(
      this.cameraPos.x,
      height,
      this.cameraPos.z + offsetZ,
    );
    this.camera.lookAt(this.cameraPos.x, 0, this.cameraPos.z);

    // ---- Particles
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
      p.vyW -= 380 * dt;       // gravity for sparks
      p.mesh.material.opacity = Math.max(0, p.life / p.maxLife);
    }

    for (const cb of this.tickCbs) cb(dt);
    this.renderer.render(this.scene, this.camera);
  }

  // ---- Track build
  buildBackground(bounds) {
    if (!this.ground) return;
    const w = bounds.maxX - bounds.minX + 1200;
    const h = bounds.maxY - bounds.minY + 1200;
    this.ground.geometry.dispose();
    this.ground.geometry = new THREE.PlaneGeometry(w, h);
    this.ground.position.x = (bounds.minX + bounds.maxX) / 2;
    this.ground.position.z = (bounds.minY + bounds.maxY) / 2;
  }

  // Receives a full track (with centerline + widths) and rebuilds the road,
  // walls, curbs and start/finish. Renderer-side; ignores `track.tiles`
  // which are only used by host physics.
  buildTrack(track) {
    if (!track || !track.centerline || !track.widths) return;
    this._currentTrack = track;

    // Wipe previous race.
    while (this.trackGroup.children.length) {
      const obj = this.trackGroup.children.pop();
      this._disposeNode(obj);
    }
    // Clear pickup meshes too (different track → fresh pickups).
    for (const mesh of this.pickupMeshes.values()) {
      this.scene.remove(mesh);
      this._disposeNode(mesh);
    }
    this.pickupMeshes.clear();

    const ring = buildEdgeRing(track.centerline, track.widths);
    this._minimapRing = ring;

    // ---- Road surface — single closed triangle strip from the ring.
    const N = ring.length;
    const roadPos = new Float32Array(N * 2 * 3);
    for (let i = 0; i < N; i++) {
      roadPos[i * 6 + 0] = ring[i].left.x;
      roadPos[i * 6 + 1] = 0.5;
      roadPos[i * 6 + 2] = ring[i].left.y;
      roadPos[i * 6 + 3] = ring[i].right.x;
      roadPos[i * 6 + 4] = 0.5;
      roadPos[i * 6 + 5] = ring[i].right.y;
    }
    const roadIdx = [];
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const a = i * 2, b = i * 2 + 1, c = j * 2, d = j * 2 + 1;
      roadIdx.push(a, c, d, a, d, b);
    }
    const roadGeom = new THREE.BufferGeometry();
    roadGeom.setAttribute('position', new THREE.BufferAttribute(roadPos, 3));
    roadGeom.setIndex(roadIdx);
    roadGeom.computeVertexNormals();
    const road = new THREE.Mesh(
      roadGeom,
      new THREE.MeshLambertMaterial({ color: 0x2a2f3a }),
    );
    this.trackGroup.add(road);

    // ---- Continuous wall ribbons, left and right. Each ribbon is a vertical
    // strip following the ring with bottom on the road surface and top at
    // wall height. No gaps regardless of corner angle.
    const wallHeight = 28;
    this.trackGroup.add(this._buildWallRibbon(ring, 'left', wallHeight, 0x4a5161));
    this.trackGroup.add(this._buildWallRibbon(ring, 'right', wallHeight, 0x4a5161));

    // ---- Curbs — thin red/white strip just inside each wall on the ground.
    this.trackGroup.add(this._buildCurbRibbon(ring, 'left'));
    this.trackGroup.add(this._buildCurbRibbon(ring, 'right'));

    // ---- Centerline dashes — sparse white markings down the middle.
    const dashes = new THREE.Group();
    const dashMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    for (let i = 0; i < N; i += 4) {
      const a = track.centerline[i];
      const b = track.centerline[(i + 1) % N];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 0.5) continue;
      const dash = new THREE.Mesh(
        new THREE.BoxGeometry(Math.min(len * 0.55, 30), 0.4, 2.5),
        dashMat,
      );
      dash.position.set((a.x + b.x) / 2, 0.9, (a.y + b.y) / 2);
      dash.rotation.y = -Math.atan2(dy, dx);
      dashes.add(dash);
    }
    this.trackGroup.add(dashes);

    // ---- Start / finish checkered band.
    const s = track.start;
    const matLight = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const matDark  = new THREE.MeshLambertMaterial({ color: 0x111111 });
    for (let k = -5; k <= 5; k++) {
      const px = s.x + s.nx * (k * 22);
      const pz = s.y + s.ny * (k * 22);
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(18, 0.8, 22),
        (k % 2 === 0) ? matLight : matDark,
      );
      stripe.position.set(px, 1.0, pz);
      stripe.rotation.y = -Math.atan2(s.ty, s.tx);
      this.trackGroup.add(stripe);
    }
  }

  _buildWallRibbon(ring, side, height, color) {
    const N = ring.length;
    const positions = new Float32Array(N * 2 * 3);
    for (let i = 0; i < N; i++) {
      const p = ring[i][side];
      positions[i * 6 + 0] = p.x;
      positions[i * 6 + 1] = 0;
      positions[i * 6 + 2] = p.y;
      positions[i * 6 + 3] = p.x;
      positions[i * 6 + 4] = height;
      positions[i * 6 + 5] = p.y;
    }
    const indices = [];
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const a = i * 2, b = i * 2 + 1, c = j * 2, d = j * 2 + 1;
      // Wind so the outward-facing normal points OUT of the road. For left
      // ribbon, outward is toward +perp; for right, the reverse.
      if (side === 'left') indices.push(a, b, d, a, d, c);
      else                 indices.push(a, c, d, a, d, b);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    return new THREE.Mesh(geom, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
  }

  _buildCurbRibbon(ring, side) {
    const N = ring.length;
    // Build a thin strip just inside each wall edge — alternating red/white.
    const positions = [];
    const indices = [];
    const colors = [];
    const inset = 6;        // distance inside the wall, toward centerline
    for (let i = 0; i < N; i++) {
      const p = ring[i][side];
      const other = ring[i][side === 'left' ? 'right' : 'left'];
      const dx = other.x - p.x, dy = other.y - p.y;
      const dl = Math.hypot(dx, dy) || 1;
      const inX = dx / dl, inY = dy / dl;
      // Inner edge (toward road)
      positions.push(p.x + inX * inset, 1.1, p.y + inY * inset);
      // Outer edge (on the wall side)
      positions.push(p.x, 1.1, p.y);
      const col = ((i % 2 === 0) ? 0xff3a3a : 0xf3f3f3);
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
    return new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ vertexColors: true }));
  }

  // ---- Cars
  ensureCarMesh(id, colorIdx) {
    let g = this.carMeshes.get(id);
    if (g) return g;
    g = new THREE.Group();
    const colorHex = parseInt(PLAYER_COLORS[colorIdx % PLAYER_COLORS.length].replace('#', ''), 16);

    // Chassis — long axis along world X (= game-forward at angle 0).
    const bodyMat = new THREE.MeshLambertMaterial({ color: colorHex });
    const body = new THREE.Mesh(new THREE.BoxGeometry(56, 12, 32), bodyMat);
    body.position.y = 8;
    g.add(body);
    g.bodyMat = bodyMat;
    g.bodyColor = colorHex;

    // Cabin
    const cabinMat = new THREE.MeshLambertMaterial({ color: 0x14181f });
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(28, 10, 24), cabinMat);
    cabin.position.set(-4, 18, 0);
    g.add(cabin);

    // Hood scoop
    const scoop = new THREE.Mesh(
      new THREE.BoxGeometry(8, 4, 16),
      new THREE.MeshLambertMaterial({ color: 0x101418 }),
    );
    scoop.position.set(12, 16, 0);
    g.add(scoop);

    // Rear spoiler (small angled wing)
    const spoiler = new THREE.Mesh(
      new THREE.BoxGeometry(4, 4, 24),
      new THREE.MeshLambertMaterial({ color: 0x0a0c10 }),
    );
    spoiler.position.set(-26, 14, 0);
    g.add(spoiler);
    const spoilerLeg1 = new THREE.Mesh(
      new THREE.BoxGeometry(2, 6, 2),
      new THREE.MeshLambertMaterial({ color: 0x0a0c10 }),
    );
    spoilerLeg1.position.set(-26, 11, -10);
    g.add(spoilerLeg1);
    const spoilerLeg2 = spoilerLeg1.clone();
    spoilerLeg2.position.z = 10;
    g.add(spoilerLeg2);

    // Wheels — cylinders laid on their side.
    const wheelMat = new THREE.MeshLambertMaterial({ color: 0x000000 });
    const wheelGeom = new THREE.CylinderGeometry(5.5, 5.5, 5, 12);
    const wheels = [[-18, -16], [-18, 16], [18, -16], [18, 16]];
    for (const [wx, wz] of wheels) {
      const w = new THREE.Mesh(wheelGeom, wheelMat);
      w.rotation.x = Math.PI / 2;
      w.position.set(wx, 3.5, wz);
      g.add(w);
    }

    // Headlight glints — small bright cubes on the front of the chassis.
    const headlightMat = new THREE.MeshBasicMaterial({ color: 0xfff0a0 });
    for (const wz of [-10, 10]) {
      const hl = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 4), headlightMat);
      hl.position.set(27, 8, wz);
      g.add(hl);
    }
    // Tail lights
    const tailMat = new THREE.MeshBasicMaterial({ color: 0xff2030 });
    for (const wz of [-12, 12]) {
      const tl = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 4), tailMat);
      tl.position.set(-27, 8, wz);
      g.add(tl);
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
      // Game angle 0 = facing +X in world. Three.js rotation.y rotates about
      // world Y. For game angle θ, rotate world-X by -θ (right-hand rule).
      g.rotation.y = -car.a;

      // Damage flash
      const flashUntil = this.carFlashUntil.get(car.id) || 0;
      if (flashUntil > now) {
        const pct = (flashUntil - now) / 200;
        g.bodyMat.color.setHex(lerpColor(g.bodyColor, 0xff3a48, pct));
      } else if (!car.alive) {
        g.bodyMat.color.setHex(0x444444);
      } else {
        g.bodyMat.color.setHex(g.bodyColor);
      }

      // Boost trail
      if (car.boost > 0 && Math.random() < 0.7) {
        const ang = car.a;
        this.emitParticle(
          car.x - Math.cos(ang) * 28, car.y - Math.sin(ang) * 28,
          -car.vx * 0.18, -car.vy * 0.18, 0.45, 0xff8040,
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
      if (!mesh || mesh._kind !== p.kind) {
        if (mesh) {
          this.scene.remove(mesh);
          this._disposeNode(mesh);
        }
        mesh = this._buildPickupMesh(p.kind);
        mesh.position.set(p.x, 18, p.y);
        this.scene.add(mesh);
        this.pickupMeshes.set(p.slotIndex, mesh);
      }
      mesh.visible = !p.taken;
      if (!p.taken) {
        mesh.rotation.y = t * 2.4;
        mesh.position.y = 18 + Math.sin(t * 3 + p.slotIndex) * 3;
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
      case 'nitro':  geom = new THREE.ConeGeometry(9, 20, 6); break;
      case 'mine':   geom = new THREE.IcosahedronGeometry(11, 0); break;
      case 'oil':    geom = new THREE.CylinderGeometry(10, 10, 5, 12); break;
      case 'repair': geom = new THREE.OctahedronGeometry(11); break;
      case 'spikes': geom = new THREE.TetrahedronGeometry(12); break;
      default:       geom = new THREE.OctahedronGeometry(10);
    }
    const mesh = new THREE.Mesh(
      geom,
      new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.25 }),
    );
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
        mesh.position.set(h.x, 1, h.y);
        this.scene.add(mesh);
        this.hazardMeshes.set(h.id, mesh);
      }
      if (h.kind === 'mine' && mesh.userData.led) {
        const pulse = (Math.sin(t * 8) + 1) * 0.5;
        mesh.userData.led.scale.setScalar(0.8 + pulse * 0.5);
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
        new THREE.CylinderGeometry(10, 12, 6, 16),
        new THREE.MeshLambertMaterial({ color: 0x1a1a1a }),
      ));
      const led = new THREE.Mesh(
        new THREE.SphereGeometry(2.5, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0xff3030 }),
      );
      led.position.y = 4.5;
      group.add(led);
      group.userData.led = led;
    } else if (kind === 'oil') {
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(38, 24),
        new THREE.MeshBasicMaterial({ color: 0x101010, transparent: true, opacity: 0.78 }),
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.2;
      group.add(disc);
    } else if (kind === 'spikes') {
      for (let i = -2; i <= 2; i++) {
        const spike = new THREE.Mesh(
          new THREE.ConeGeometry(3, 9, 5),
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
      new THREE.BoxGeometry(3, 3, 3),
      new THREE.MeshBasicMaterial({ color, transparent: true }),
    );
    mesh.position.set(x, 10, y);
    this.scene.add(mesh);
    // Slight upward initial velocity sells the burst feel.
    this.particles.push({ mesh, vx, vy, vyW: 80 + Math.random() * 60, life, maxLife: life });
  }

  emitBurst(x, y, count, color = 0xff8040, speed = 240, life = 0.5) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.8);
      this.emitParticle(x, y, Math.cos(a) * s, Math.sin(a) * s, life, color);
    }
  }

  // ---- Minimap (2D canvas overlay)
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
    // Filled road from the ring.
    ctx.fillStyle = '#2a2f3a';
    ctx.beginPath();
    ctx.moveTo(dx + ring[0].left.x * scale, dy + ring[0].left.y * scale);
    for (let i = 1; i < ring.length; i++) {
      ctx.lineTo(dx + ring[i].left.x * scale, dy + ring[i].left.y * scale);
    }
    ctx.closePath();
    for (let i = ring.length - 1; i >= 0; i--) {
      ctx.lineTo(dx + ring[i].right.x * scale, dy + ring[i].right.y * scale);
    }
    ctx.fill('evenodd');
    // Cars.
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
