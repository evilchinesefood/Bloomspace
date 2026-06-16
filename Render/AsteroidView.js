// Render/AsteroidView.js — asteroid bodies (one InstancedMesh, scaled per radius,
// tinted by owner) + an in-world stat "flower" ring per rock (Energy/Strength/Speed as
// three concentric arc segments) + a selection highlight ring + an LOD aggregate glow.
// Asteroid count is small (dozens) and `id === index` and rocks are never removed, so
// per-rock ring meshes are fine; bodies stay instanced. Re-tints each frame on owner flip.
//
// LOD aggregate glow (T8): when zoomed far out (zoom < LOD_ZOOM), SeedlingView stops
// drawing individual seedlings. To keep the map readable, each rock gets an owner-colored
// glow disc that brightens + scales with the count of seedlings orbiting it. Above the
// threshold the glow is hidden and individual seedlings carry the look.
import * as THREE from "three";
import { ownerColor, ownerColorHex } from "./Palette.js";
import { LOD_ZOOM } from "./SeedlingView.js";

const TAU = Math.PI * 2;

// Three concentric arcs around the rock, each a fraction (stat/100) of the circle.
const RING_GAP = 10; // distance from rock edge to first ring
const RING_SPACING = 7; // gap between the three stat rings
const RING_WIDTH = 3.5; // radial thickness of each arc
const STAT_COLORS = [0xffd24b, 0xff6b6b, 0x5ad1ff]; // energy, strength, speed

export function createAsteroidView(scene, world, camCtl) {
  const rocks = world.asteroids;
  const n = rocks.length;

  // --- Bodies: one InstancedMesh, unit circle scaled to each radius ---
  const geo = new THREE.CircleGeometry(1, 28);
  const mat = new THREE.MeshBasicMaterial({ vertexColors: false });
  const bodies = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
  bodies.count = n;
  bodies.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  const colorAttr = new THREE.InstancedBufferAttribute(
    new Float32Array(Math.max(1, n) * 3),
    3,
  );
  bodies.instanceColor = colorAttr;
  scene.add(bodies);

  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  const lastOwner = new Int32Array(n).fill(-99);

  for (let i = 0; i < n; i++) {
    const a = rocks[i];
    dummy.position.set(a.x, a.y, -2);
    dummy.scale.set(a.radius, a.radius, 1);
    dummy.updateMatrix();
    bodies.setMatrixAt(i, dummy.matrix);
  }
  bodies.instanceMatrix.needsUpdate = true;

  // --- LOD aggregate glow: one additive disc per rock, scaled/tinted by orbiter count ---
  const glowGeo = new THREE.CircleGeometry(1, 20);
  const glowMat = new THREE.MeshBasicMaterial({
    vertexColors: false,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const glow = new THREE.InstancedMesh(glowGeo, glowMat, Math.max(1, n));
  glow.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(Math.max(1, n) * 3),
    3,
  );
  glow.frustumCulled = false;
  glow.count = 0; // hidden until LOD kicks in
  glow.position.z = -1.8; // behind seedlings/rings, above bodies
  scene.add(glow);
  const glowCol = new THREE.Color();
  const orbitCount = new Int32Array(n);

  // --- Stat flower rings: per-rock, three concentric arc meshes (static geometry) ---
  // Rings read dim (rocks bloom less than seedlings); owner-tint is on the body.
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
          opacity: 0.85,
          side: THREE.DoubleSide,
        }),
      );
      ring.position.set(a.x, a.y, -1.5);
      ringGroup.add(ring);
    }
  }

  // --- Selection highlight: a single ring we reposition over the selected rock ---
  const selMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
  });
  const selRing = new THREE.Mesh(new THREE.RingGeometry(1, 1.06, 64), selMat);
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

  // update — re-tint bodies on ownership change (owners flip during play) + drive LOD glow.
  function update() {
    let dirty = false;
    for (let i = 0; i < n; i++) {
      const o = rocks[i].owner;
      if (o !== lastOwner[i]) {
        ownerColor(col, o);
        bodies.setColorAt(i, col);
        lastOwner[i] = o;
        dirty = true;
      }
    }
    if (dirty && bodies.instanceColor) bodies.instanceColor.needsUpdate = true;

    updateGlow();
  }

  // LOD glow: only active (and only paying the per-seedling tally) when zoomed far out.
  function updateGlow() {
    const zoom = camCtl ? camCtl.getZoom() : 1;
    if (!camCtl || zoom >= LOD_ZOOM) {
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
      const c = orbitCount[i];
      // Scale a halo from the rock edge outward; saturate by ~30 orbiters.
      const k = Math.min(1, c / 30);
      const rr = a.radius * (1.4 + k * 2.6);
      dummy.position.set(a.x, a.y, 0);
      dummy.scale.set(rr, rr, 1);
      dummy.updateMatrix();
      glow.setMatrixAt(i, dummy.matrix);
      // Owner color, dimmed when few orbiters so empty rocks don't glare.
      const f = 0.25 + k * 0.75;
      glowCol.setHex(ownerColorHex(a.owner));
      glowCol.multiplyScalar(f);
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
    glow,
    ringGroup,
    setSelected,
    clearSelected,
    selected: () => selectedId,
    update,
  };
}
