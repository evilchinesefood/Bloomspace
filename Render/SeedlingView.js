// Render/SeedlingView.js — instanced seedlings drawn straight from the SoA arrays,
// interpolated between sim ticks. T1 proof-of-life: a single glowing instance so the
// UnrealBloomPass visibly blooms. T3 expands this to thousands.
import * as THREE from "three";

const lerp = (a, b, t) => a + (b - a) * t;

export function createSeedlingView(scene, world) {
  const capacity = world.seed.capacity;
  // Small emissive disc; bright color so it blooms.
  const geo = new THREE.CircleGeometry(6, 16);
  const mat = new THREE.MeshBasicMaterial({ color: 0x66ffd9 });
  const mesh = new THREE.InstancedMesh(geo, mat, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  scene.add(mesh);

  const dummy = new THREE.Object3D();

  function update(alpha) {
    const s = world.seed;
    mesh.count = s.count;
    for (let i = 0; i < s.count; i++) {
      const x = lerp(s.px[i], s.x[i], alpha);
      const y = lerp(s.py[i], s.y[i], alpha);
      dummy.position.set(x, y, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  return { mesh, update };
}
