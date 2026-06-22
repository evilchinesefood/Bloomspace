// Render/EdgeLayer.js — reusable LineSegments layer for edge sets (world.links, conduits, etc.).
import * as THREE from "three";

export function createEdgeLayer(scene, opts = {}) {
  const { color = 0x66ffc8, opacity = 0.6, z = -2.1, getList, getPoint } = opts;

  const geo = new THREE.BufferGeometry();
  let pos = new Float32Array(0);
  let count = -1;
  const obj = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
  );
  obj.frustumCulled = false;
  scene.add(obj);

  function update(hasMoving, isMoving) {
    const links = getList();
    const countChanged = links.length !== count;
    if (countChanged) {
      count = links.length;
      pos = new Float32Array(links.length * 6);
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setDrawRange(0, links.length * 2);
    }
    let endpointMoving = false;
    if (hasMoving)
      for (let e = 0; e < links.length; e++)
        if (isMoving(links[e][0]) || isMoving(links[e][1])) {
          endpointMoving = true;
          break;
        }
    if (!countChanged && !endpointMoving) return;
    for (let e = 0; e < links.length; e++) {
      const a = getPoint(links[e][0]);
      const b = getPoint(links[e][1]);
      const o = e * 6;
      pos[o] = a.x;
      pos[o + 1] = a.y;
      pos[o + 2] = z;
      pos[o + 3] = b.x;
      pos[o + 4] = b.y;
      pos[o + 5] = z;
    }
    if (links.length) geo.attributes.position.needsUpdate = true;
  }

  function dispose() {
    scene.remove(obj);
    geo.dispose();
    obj.material.dispose();
  }

  return { object: obj, update, dispose };
}
