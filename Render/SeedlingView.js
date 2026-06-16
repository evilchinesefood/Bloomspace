// Render/SeedlingView.js — instanced seedlings drawn straight from the SoA arrays,
// interpolated between sim ticks. Tinted by owner (shared palette); COMBAT seedlings
// run hotter. Teleport guard: when a seedling re-homes/colonizes the sim snaps it far in
// one tick — lerping would streak, so we draw at x/y when dist(px..x) is large.
import * as THREE from "three";
import { STATE } from "../Sim/World.js";
import { ownerColor } from "./Palette.js";

const lerp = (a, b, t) => a + (b - a) * t;
// A few asteroid radii — re-homes jump much farther than one tick of normal motion.
const SNAP_THRESHOLD = 140;
const SNAP_SQ = SNAP_THRESHOLD * SNAP_THRESHOLD;
const COMBAT_TINT = 0xff7a3c; // hotter color for fighting seedlings

export function createSeedlingView(scene, world) {
  const capacity = world.seed.capacity;
  const geo = new THREE.CircleGeometry(6, 12);
  const mat = new THREE.MeshBasicMaterial({ vertexColors: false });
  const mesh = new THREE.InstancedMesh(geo, mat, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(capacity * 3),
    3,
  );
  mesh.count = 0;
  scene.add(mesh);

  const dummy = new THREE.Object3D();
  const col = new THREE.Color();

  function update(alpha) {
    const s = world.seed;
    mesh.count = s.count;
    for (let i = 0; i < s.count; i++) {
      const dx = s.x[i] - s.px[i];
      const dy = s.y[i] - s.py[i];
      let x, y;
      if (dx * dx + dy * dy > SNAP_SQ) {
        // Teleport this tick (re-home/colonize) — snap, don't streak.
        x = s.x[i];
        y = s.y[i];
      } else {
        x = lerp(s.px[i], s.x[i], alpha);
        y = lerp(s.py[i], s.y[i], alpha);
      }
      dummy.position.set(x, y, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      if (s.state[i] === STATE.COMBAT) col.setHex(COMBAT_TINT);
      else ownerColor(col, s.owner[i]);
      mesh.setColorAt(i, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  return { mesh, update };
}
