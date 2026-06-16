// Render/SeedlingView.js — instanced seedlings drawn straight from the SoA arrays,
// interpolated between sim ticks. Tinted by owner (shared palette); COMBAT seedlings
// run hotter. Teleport guard: when a seedling re-homes/colonizes the sim snaps it far in
// one tick — lerping would streak, so we draw at x/y when dist(px..x) is large.
//
// Perf (T8): viewport culling + LOD. We only push instances whose interpolated world
// position is inside the camera frustum + margin, packed into low indices, and set
// mesh.count to that visible total. Below LOD_ZOOM (zoomed far out) we draw NO individual
// seedlings (mesh.count = 0) — AsteroidView shows owner-colored aggregate glow instead.
// A render-only cap (setCap) hard-limits drawn instances for low-end devices.
import * as THREE from "three";
import { STATE } from "../Sim/World.js";
import { ownerColor } from "./Palette.js";

const lerp = (a, b, t) => a + (b - a) * t;
// A few asteroid radii — re-homes jump much farther than one tick of normal motion.
const SNAP_THRESHOLD = 140;
const SNAP_SQ = SNAP_THRESHOLD * SNAP_THRESHOLD;
const COMBAT_TINT = 0xff7a3c; // hotter color for fighting seedlings
const CULL_MARGIN = 40; // world units of slack around the frustum
// Below this zoom factor (1 = fit-all), individual seedlings collapse into rock glow.
const LOD_ZOOM = 1.6;

// camCtl is the scene controller from createScene (getZoom + camera frustum). Optional so
// the view still constructs in a bare-scene test, falling back to "draw everything".
export function createSeedlingView(scene, world, camCtl) {
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
  // We pack visible instances into low indices, so frustum culling on the mesh AABB would
  // be wrong (the AABB no longer reflects all instances). Cull per-instance ourselves.
  mesh.frustumCulled = false;
  scene.add(mesh);

  const dummy = new THREE.Object3D();
  const col = new THREE.Color();

  // Render-only seedling cap (escape hatch). Infinity = draw all visible.
  let cap = Infinity;
  function setCap(n) {
    cap = n == null || n <= 0 ? Infinity : n;
  }

  function update(alpha) {
    const s = world.seed;
    const zoom = camCtl ? camCtl.getZoom() : 1;

    // LOD far tier: skip individual seedlings entirely; AsteroidView aggregates.
    if (camCtl && zoom < LOD_ZOOM) {
      mesh.count = 0;
      return;
    }

    // Frustum bounds in world space (ortho camera: left/right/bottom/top are world units).
    let minX = -Infinity,
      maxX = Infinity,
      minY = -Infinity,
      maxY = Infinity;
    if (camCtl) {
      const c = camCtl.camera;
      minX = c.left - CULL_MARGIN;
      maxX = c.right + CULL_MARGIN;
      minY = c.bottom - CULL_MARGIN;
      maxY = c.top + CULL_MARGIN;
    }

    let vis = 0;
    for (let i = 0; i < s.count; i++) {
      if (vis >= cap) break;
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
      // Cull off-screen seedlings.
      if (x < minX || x > maxX || y < minY || y > maxY) continue;

      dummy.position.set(x, y, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(vis, dummy.matrix);

      if (s.state[i] === STATE.COMBAT) col.setHex(COMBAT_TINT);
      else ownerColor(col, s.owner[i]);
      mesh.setColorAt(vis, col);
      vis++;
    }
    mesh.count = vis;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  return { mesh, update, setCap, LOD_ZOOM };
}

export { LOD_ZOOM };
