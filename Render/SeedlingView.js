// Render/SeedlingView.js — seedlings drawn as Font Awesome ship sprites: fighters
// (jet-fighter-up) and defenders (shuttle-space), tinted by owner and oriented along their
// heading. Two instanced meshes (one texture each) are filled from the SoA each frame with
// viewport culling, apparent-size LOD (collapse to AsteroidView's aggregate glow when ships
// would be sub-pixel), a render-only cap, and a teleport snap on re-home.
import * as THREE from "three";
import { STATE, KIND } from "../Sim/World.js";
import { ownerColor } from "./Palette.js";
import { glyphTexture, ICON } from "./Glyphs.js";

const lerp = (a, b, t) => a + (b - a) * t;
const SHIP = 13; // ship sprite size (world units)
const SNAP_THRESHOLD = 140;
const SNAP_SQ = SNAP_THRESHOLD * SNAP_THRESHOLD;
const COMBAT_TINT = 0xff7a3c; // fighting ships run hot
const CULL_MARGIN = 40;
const SEED_RADIUS = 6; // apparent-size reference for LOD
const MIN_SEED_PX = 3;
const HALF_PI = Math.PI / 2;

// LOD keyed on apparent on-screen size (shared with AsteroidView).
export function lodActive(camCtl) {
  if (!camCtl || !camCtl.getWorldPerPixel) return false;
  const wpp = camCtl.getWorldPerPixel();
  return wpp > 0 && (SEED_RADIUS * 2) / wpp < MIN_SEED_PX;
}

function makeShipMesh(scene, capacity, code) {
  const mat = new THREE.MeshBasicMaterial({
    map: glyphTexture(code),
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(SHIP, SHIP),
    mat,
    capacity,
  );
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(capacity * 3),
    3,
  );
  mesh.frustumCulled = false;
  mesh.count = 0;
  scene.add(mesh);
  return mesh;
}

export function createSeedlingView(scene, world, camCtl) {
  const capacity = world.seed.capacity;
  const fighters = makeShipMesh(scene, capacity, ICON.fighter);
  const defenders = makeShipMesh(scene, capacity, ICON.defender);
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();

  let cap = Infinity;
  function setCap(n) {
    cap = n == null || n <= 0 ? Infinity : n;
  }

  function update(alpha) {
    const s = world.seed;
    if (lodActive(camCtl)) {
      fighters.count = 0;
      defenders.count = 0;
      return;
    }
    let minX = -Infinity,
      maxX = Infinity,
      minY = -Infinity,
      maxY = Infinity;
    if (camCtl) {
      const c = camCtl.camera;
      minX = c.position.x + c.left - CULL_MARGIN;
      maxX = c.position.x + c.right + CULL_MARGIN;
      minY = c.position.y + c.bottom - CULL_MARGIN;
      maxY = c.position.y + c.top + CULL_MARGIN;
    }
    let vf = 0,
      vd = 0,
      total = 0;
    for (let i = 0; i < s.count; i++) {
      if (total >= cap) break;
      const ddx = s.x[i] - s.px[i];
      const ddy = s.y[i] - s.py[i];
      const teleport = ddx * ddx + ddy * ddy > SNAP_SQ;
      let x, y;
      if (teleport) {
        x = s.x[i];
        y = s.y[i];
      } else {
        x = lerp(s.px[i], s.x[i], alpha);
        y = lerp(s.py[i], s.y[i], alpha);
      }
      if (x < minX || x > maxX || y < minY || y > maxY) continue;
      // Fog of war: hide ENEMY (non-human) seedlings the human can't currently see. A ship is
      // "seen" if its home rock is currently seen by player 0 (the rock-based vision model). Own
      // ships (owner 0) always show; with fog off this whole branch is skipped.
      if (world.fogOn && world.fog && s.owner[i] !== 0) {
        const h = s.home[i];
        if (h < 0 || h >= world.fog.seen[0].length || !world.fog.seen[0][h])
          continue;
      }
      // Orient along motion (orbit tangent or transit heading); idle ships point up.
      let rot = 0;
      if (!teleport && ddx * ddx + ddy * ddy > 0.0004)
        rot = Math.atan2(ddy, ddx) - HALF_PI;
      dummy.position.set(x, y, 0);
      dummy.rotation.set(0, 0, rot);
      dummy.updateMatrix();
      if (s.state[i] === STATE.COMBAT) col.setHex(COMBAT_TINT);
      else ownerColor(col, s.owner[i]);
      if (s.kind[i] === KIND.DEFENDER) {
        defenders.setMatrixAt(vd, dummy.matrix);
        defenders.setColorAt(vd, col);
        vd++;
      } else {
        fighters.setMatrixAt(vf, dummy.matrix);
        fighters.setColorAt(vf, col);
        vf++;
      }
      total++;
    }
    fighters.count = vf;
    defenders.count = vd;
    fighters.instanceMatrix.needsUpdate = true;
    defenders.instanceMatrix.needsUpdate = true;
    if (fighters.instanceColor) fighters.instanceColor.needsUpdate = true;
    if (defenders.instanceColor) defenders.instanceColor.needsUpdate = true;
  }

  return { fighters, defenders, update, setCap };
}
