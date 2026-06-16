// Render/AsteroidView.js — asteroid bodies (one InstancedMesh, scaled per radius,
// tinted by owner) + an in-world stat "flower" ring per rock (Energy/Strength/Speed as
// three concentric arc segments) + a selection highlight ring.
// Asteroid count is small (dozens) and `id === index` and rocks are never removed, so
// per-rock ring meshes are fine; bodies stay instanced. Re-tints each frame on owner flip.
import * as THREE from "three";
import { ownerColor } from "./Palette.js";

const TAU = Math.PI * 2;

// Three concentric arcs around the rock, each a fraction (stat/100) of the circle.
const RING_GAP = 10; // distance from rock edge to first ring
const RING_SPACING = 7; // gap between the three stat rings
const RING_WIDTH = 3.5; // radial thickness of each arc
const STAT_COLORS = [0xffd24b, 0xff6b6b, 0x5ad1ff]; // energy, strength, speed

export function createAsteroidView(scene, world) {
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

  // update — re-tint bodies on ownership change (owners flip during play).
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
  }
  update();

  // selected() lets T7's input loop query the current selection.
  return {
    bodies,
    ringGroup,
    setSelected,
    clearSelected,
    selected: () => selectedId,
    update,
  };
}
