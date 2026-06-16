// Render/TreeView.js — minimal stub. Asteroids carry trees:[] (empty until T5). For now
// update() draws nothing (or a tiny marker per tree if any exist), leaving a clean seam
// for T5 to grow real tree meshes + flower FX.
import * as THREE from "three";

const MARKER_R = 5;
const MAX_MARKERS = 256;

export function createTreeView(scene, world) {
  const geo = new THREE.CircleGeometry(MARKER_R, 6);
  const mat = new THREE.MeshBasicMaterial({ color: 0x9bff7a });
  const mesh = new THREE.InstancedMesh(geo, mat, MAX_MARKERS);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  scene.add(mesh);

  const dummy = new THREE.Object3D();

  // Tiny markers around a rock for any trees it holds. No-op while trees are empty.
  function update() {
    let m = 0;
    for (const a of world.asteroids) {
      const trees = a.trees;
      if (!trees || trees.length === 0) continue;
      for (let t = 0; t < trees.length && m < MAX_MARKERS; t++) {
        const ang = (t / Math.max(1, trees.length)) * Math.PI * 2;
        dummy.position.set(
          a.x + Math.cos(ang) * a.radius * 0.5,
          a.y + Math.sin(ang) * a.radius * 0.5,
          0.5,
        );
        dummy.updateMatrix();
        mesh.setMatrixAt(m++, dummy.matrix);
      }
    }
    mesh.count = m;
    if (m > 0) mesh.instanceMatrix.needsUpdate = true;
  }
  update();

  return { mesh, update };
}
