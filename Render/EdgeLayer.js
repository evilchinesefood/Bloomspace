// Render/EdgeLayer.js — reusable LineSegments layer for edge sets (world.links, conduits, etc.).
import * as THREE from "three";

export function createEdgeLayer(scene, opts = {}) {
  const {
    color = 0x66ffc8,
    opacity = 0.6,
    z = -2.1,
    getList,
    getPoint,
    dashed = false,
    dashSize = 18,
    gapSize = 12,
  } = opts;

  const geo = new THREE.BufferGeometry();
  let pos = new Float32Array(0);
  let count = -1;
  // Dashed mode (opt-in) uses LineDashedMaterial — directional "flow" read via an animated
  // dash offset (dashOffset). Solid mode is byte-identical to before (LineBasicMaterial).
  const material = dashed
    ? new THREE.LineDashedMaterial({
        color,
        transparent: true,
        opacity,
        dashSize,
        gapSize,
      })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  const obj = new THREE.LineSegments(geo, material);
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
    // LineDashedMaterial needs per-vertex line distances; recompute after each rebuild only.
    if (dashed && links.length) obj.computeLineDistances();
  }

  // Advance the dash offset to read as directional flow. Caller gates on reducedMotion()
  // (static when reduced). No-op in solid mode. dt in seconds.
  function animate(dt) {
    if (!dashed) return;
    material.dashOffset -= dt * (dashSize + gapSize) * 1.2;
  }

  function dispose() {
    scene.remove(obj);
    geo.dispose();
    obj.material.dispose();
  }

  return { object: obj, update, animate, dispose };
}
