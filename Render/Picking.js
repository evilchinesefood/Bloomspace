// Render/Picking.js — screen→world mapping (ortho unproject), asteroid hit-testing vs
// discs, and an in-world drag indicator (a line from a source point to the cursor world
// position). This is what T7's input loop drives: click-select → drag-to-target → release.
import * as THREE from "three";

export function createPicking(scene, camera, canvas, world) {
  const ndc = new THREE.Vector3();
  const hit = new THREE.Vector3();

  // clientX/Y (page coords) → world (x,y). Ortho camera: unproject is exact.
  function screenToWorld(clientX, clientY, out) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
      0,
    );
    ndc.unproject(camera);
    if (out) {
      out.x = ndc.x;
      out.y = ndc.y;
      return out;
    }
    return { x: ndc.x, y: ndc.y };
  }

  // Asteroid id under the cursor, or -1. Disc hit-test (id === index).
  function asteroidAt(clientX, clientY, w = world) {
    screenToWorld(clientX, clientY, hit);
    let bestId = -1;
    let bestD2 = Infinity;
    for (const a of w.asteroids) {
      if (a.dead) continue; // destroyed body — can't be selected/targeted/dragged
      const dx = hit.x - a.x;
      const dy = hit.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= a.radius * a.radius && d2 < bestD2) {
        bestD2 = d2;
        bestId = a.id;
      }
    }
    return bestId;
  }

  // --- Drag indicator: source point → live cursor world pos ---
  const dragPos = new Float32Array(6); // 2 points × xyz
  const dragGeo = new THREE.BufferGeometry();
  dragGeo.setAttribute("position", new THREE.BufferAttribute(dragPos, 3));
  const dragMat = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.8,
  });
  const dragLine = new THREE.Line(dragGeo, dragMat);
  dragLine.frustumCulled = false;
  dragLine.visible = false;
  dragLine.position.z = 0.5;
  scene.add(dragLine);

  let dragFrom = -1;

  function beginDrag(fromId) {
    const a = world.asteroids[fromId];
    if (!a) return;
    dragFrom = fromId;
    dragPos[0] = a.x;
    dragPos[1] = a.y;
    dragPos[2] = 0;
    dragPos[3] = a.x;
    dragPos[4] = a.y;
    dragPos[5] = 0;
    dragLine.visible = true;
    dragGeo.attributes.position.needsUpdate = true;
  }

  function updateDrag(clientX, clientY) {
    if (dragFrom < 0) return;
    screenToWorld(clientX, clientY, hit);
    dragPos[3] = hit.x;
    dragPos[4] = hit.y;
    dragGeo.attributes.position.needsUpdate = true;
  }

  function endDrag() {
    dragFrom = -1;
    dragLine.visible = false;
  }

  // Keep the source anchored if the world moved (rocks are static now; future-proof).
  function update() {
    if (dragFrom < 0) return;
    const a = world.asteroids[dragFrom];
    if (!a) return;
    dragPos[0] = a.x;
    dragPos[1] = a.y;
    dragGeo.attributes.position.needsUpdate = true;
  }

  return {
    screenToWorld,
    asteroidAt,
    beginDrag,
    updateDrag,
    endDrag,
    update,
    dragLine,
    get dragFrom() {
      return dragFrom;
    },
  };
}
