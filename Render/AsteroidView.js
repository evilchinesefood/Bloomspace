// Render/AsteroidView.js — asteroids drawn as solid, dark rock bodies (one InstancedMesh)
// with a bright owner-colored RIM ring (one InstancedMesh) so ownership reads clearly and
// only the thin rim glows under bloom — the body stays dark so rocks don't bloom into
// "suns". A dim per-rock stat "flower" ring (Energy/Strength/Speed) sits just outside, plus
// a selection highlight and the LOD aggregate glow. Asteroid count is small (dozens) and
// `id === index` (rocks are never removed), so per-rock ring meshes are fine.
import * as THREE from "three";
import { ownerColor, ownerColorHex } from "./Palette.js";
import { lodActive } from "./SeedlingView.js";

const TAU = Math.PI * 2;

// Stat flower ring: three thin concentric arcs, each a fraction (stat/100) of the circle.
const RING_GAP = 7; // distance from rock edge to first stat arc
const RING_SPACING = 5; // gap between the three stat arcs
const RING_WIDTH = 2.5; // radial thickness of each arc
const STAT_COLORS = [0xffd24b, 0xff6b6b, 0x5ad1ff]; // energy, strength, speed

// Dark rock body: owner hue pulled hard toward neutral slate and darkened so its luminance
// stays under the bloom threshold (it reads as a solid rock, not a glowing orb).
const SLATE = new THREE.Color(0x2a3442);
function rockColor(out, owner) {
  ownerColor(out, owner);
  out.lerp(SLATE, 0.6);
  out.multiplyScalar(0.7);
  return out;
}

export function createAsteroidView(scene, world, camCtl) {
  const rocks = world.asteroids;
  const n = rocks.length;
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  const lastOwner = new Int32Array(n).fill(-99);

  // --- Bodies: one InstancedMesh, unit circle scaled to each radius (dark rock) ---
  const bodies = new THREE.InstancedMesh(
    new THREE.CircleGeometry(1, 28),
    new THREE.MeshBasicMaterial(),
    Math.max(1, n),
  );
  bodies.count = n;
  bodies.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  bodies.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(Math.max(1, n) * 3),
    3,
  );
  scene.add(bodies);

  // --- Rims: a bright owner-colored ring hugging each rock edge (this is what glows) ---
  const rims = new THREE.InstancedMesh(
    new THREE.RingGeometry(0.85, 1.0, 40),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    Math.max(1, n),
  );
  rims.count = n;
  rims.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  rims.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(Math.max(1, n) * 3),
    3,
  );
  scene.add(rims);

  // Bodies + rims share the same per-rock position/scale; only the radius differs.
  for (let i = 0; i < n; i++) {
    const a = rocks[i];
    dummy.position.set(a.x, a.y, -2);
    dummy.scale.set(a.radius, a.radius, 1);
    dummy.updateMatrix();
    bodies.setMatrixAt(i, dummy.matrix);
    dummy.position.set(a.x, a.y, -1.9);
    dummy.updateMatrix();
    rims.setMatrixAt(i, dummy.matrix);
  }
  bodies.instanceMatrix.needsUpdate = true;
  rims.instanceMatrix.needsUpdate = true;

  // --- LOD aggregate glow: one additive disc per rock, scaled/tinted by orbiter count ---
  const glow = new THREE.InstancedMesh(
    new THREE.CircleGeometry(1, 20),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
    Math.max(1, n),
  );
  glow.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(Math.max(1, n) * 3),
    3,
  );
  glow.frustumCulled = false;
  glow.count = 0; // hidden until LOD kicks in
  glow.position.z = -1.8;
  scene.add(glow);
  const glowCol = new THREE.Color();
  const orbitCount = new Int32Array(n);

  // --- Stat flower rings: per-rock, three dim concentric arcs (static geometry) ---
  const ringGroup = new THREE.Group();
  scene.add(ringGroup);
  for (let i = 0; i < n; i++) {
    const a = rocks[i];
    const stats = [a.energyStat, a.strengthStat, a.speedStat];
    for (let r = 0; r < 3; r++) {
      const inner = a.radius + RING_GAP + r * RING_SPACING;
      const outer = inner + RING_WIDTH;
      const frac = Math.max(0, Math.min(100, stats[r])) / 100;
      if (frac <= 0) continue;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(inner, outer, 48, 1, -Math.PI / 2, frac * TAU),
        new THREE.MeshBasicMaterial({
          color: STAT_COLORS[r],
          transparent: true,
          opacity: 0.5,
          side: THREE.DoubleSide,
        }),
      );
      ring.position.set(a.x, a.y, -1.5);
      ringGroup.add(ring);
    }
  }

  // --- Selection highlight: a single ring we reposition over the selected rock ---
  const selRing = new THREE.Mesh(
    new THREE.RingGeometry(1, 1.05, 64),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
    }),
  );
  selRing.visible = false;
  selRing.position.z = -1;
  scene.add(selRing);
  let selectedId = -1;

  function setSelected(id) {
    selectedId = id;
    const a = rocks[id];
    if (!a) {
      selRing.visible = false;
      return;
    }
    const rr = a.radius + RING_GAP + 3 * RING_SPACING + 4;
    selRing.scale.set(rr, rr, 1);
    selRing.position.set(a.x, a.y, -1);
    selRing.visible = true;
  }
  function clearSelected() {
    selectedId = -1;
    selRing.visible = false;
  }

  // update — re-tint body + rim on ownership change (owners flip during play) + LOD glow.
  function update() {
    let dirty = false;
    for (let i = 0; i < n; i++) {
      const o = rocks[i].owner;
      if (o !== lastOwner[i]) {
        rockColor(col, o);
        bodies.setColorAt(i, col);
        ownerColor(col, o);
        rims.setColorAt(i, col);
        lastOwner[i] = o;
        dirty = true;
      }
    }
    if (dirty) {
      if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
      if (rims.instanceColor) rims.instanceColor.needsUpdate = true;
    }
    updateGlow();
  }

  // LOD glow: only active (and only paying the per-seedling tally) when seedlings are
  // sub-pixel (apparent-size LOD, shared with SeedlingView).
  function updateGlow() {
    if (!lodActive(camCtl)) {
      if (glow.count !== 0) glow.count = 0;
      return;
    }
    orbitCount.fill(0);
    const s = world.seed;
    for (let i = 0; i < s.count; i++) {
      const h = s.home[i];
      if (h >= 0 && h < n) orbitCount[h]++;
    }
    for (let i = 0; i < n; i++) {
      const a = rocks[i];
      const k = Math.min(1, orbitCount[i] / 30);
      const rr = a.radius * (1.4 + k * 2.6);
      dummy.position.set(a.x, a.y, 0);
      dummy.scale.set(rr, rr, 1);
      dummy.updateMatrix();
      glow.setMatrixAt(i, dummy.matrix);
      glowCol.setHex(ownerColorHex(a.owner)).multiplyScalar(0.25 + k * 0.75);
      glow.setColorAt(i, glowCol);
    }
    glow.count = n;
    glow.instanceMatrix.needsUpdate = true;
    if (glow.instanceColor) glow.instanceColor.needsUpdate = true;
  }

  update();

  // selected() lets the input loop query the current selection.
  return {
    bodies,
    rims,
    glow,
    ringGroup,
    setSelected,
    clearSelected,
    selected: () => selectedId,
    update,
  };
}
