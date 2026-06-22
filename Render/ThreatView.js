// Render/ThreatView.js — READ-ONLY tactical overlay (hold-Q): flow dashes along in-transit
// fleet routes + an approximate red/green contest tint per contested body. Reads `world`
// (seed SoA + asteroids) and renders; mutates NOTHING (no Sim/Save/EVENT writes).
//
// Owns its own buffers: a vertex-colored dashed LineSegments for flow, and an additive
// InstancedMesh of rings for contest tint. Inactive = objects hidden + zero per-frame work.
// The O(ships + bodies) snapshot is THROTTLED (recomputed every SNAP_TICKS ticks via
// world.tick, cached between), matching the FOG_TICKS precedent. Dash animation only runs
// when active and !reducedMotion().
//
// Approximations (glance overlay, not exact):
//   Flow edge  = seedling live position → its target body center, owner-colored, capped.
//   Contest    = for each non-dead habitable body, sum strength of in-transit seedlings
//                TARGETING it, split player-0 vs enemy; ratio r = own/(own+enemy) maps to
//                RED (r→0, viewer outnumbered) → neutral → GREEN (r→1, viewer dominates).
//                Bodies with no inbound fleet are skipped (no contest).
import * as THREE from "three";
import { STATE } from "../Sim/World.js";
import { ownerColorHex } from "./Palette.js";
import { reducedMotion } from "./Theme.js";

const SNAP_TICKS = 5; // recompute the derived snapshot every Nth tick (FOG_TICKS precedent)
const MAX_FLOW = 200; // cap rendered flow lines (glance overlay, not exhaustive)
const FLOW_Z = -1.5; // above links (-2.1) / glow (-1.8), below ships
const RING_Z = -1.6;
const DASH = 18,
  GAP = 12;
const CONTEST_R = 240; // ring radius around a contested body (world units, scaled by body)

export function createThreatView(scene, world) {
  // --- Flow dashes: vertex-colored dashed LineSegments, reallocated only on count change. ---
  const flowGeo = new THREE.BufferGeometry();
  let flowPos = new Float32Array(0);
  let flowCol = new Float32Array(0);
  let flowCount = -1;
  const flowMat = new THREE.LineDashedMaterial({
    transparent: true,
    opacity: 0.9,
    dashSize: DASH,
    gapSize: GAP,
    vertexColors: true,
  });
  const flow = new THREE.LineSegments(flowGeo, flowMat);
  flow.frustumCulled = false;
  flow.visible = false;
  scene.add(flow);

  // --- Contest rings: additive InstancedMesh, per-instance color + matrix. ---
  const nBodies = world.asteroids.length;
  const ringGeo = new THREE.RingGeometry(0.86, 1, 40);
  const ringMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
  });
  const rings = new THREE.InstancedMesh(ringGeo, ringMat, Math.max(1, nBodies));
  rings.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(Math.max(1, nBodies) * 3),
    3,
  );
  rings.frustumCulled = false;
  rings.position.z = RING_Z;
  rings.count = 0;
  rings.visible = false;
  scene.add(rings);

  const dummy = new THREE.Object3D();
  const tmpColor = new THREE.Color();

  let active = false;
  let lastSnapTick = -1;

  // recompute — derive flow segments + contest rings from the live world. Throttled by caller.
  function recompute() {
    const s = world.seed;
    const aa = world.asteroids;

    // Per-body inbound strength tallies (own = player 0, enemy = everyone else).
    const ownStr = new Float32Array(nBodies);
    const enemyStr = new Float32Array(nBodies);

    // --- Flow segments (capped) ---
    let lines = 0;
    if (flowCount !== MAX_FLOW) {
      flowCount = MAX_FLOW;
      flowPos = new Float32Array(MAX_FLOW * 6);
      flowCol = new Float32Array(MAX_FLOW * 6);
      flowGeo.setAttribute("position", new THREE.BufferAttribute(flowPos, 3));
      flowGeo.setAttribute("color", new THREE.BufferAttribute(flowCol, 3));
    }
    for (let i = 0; i < s.count; i++) {
      if (s.state[i] !== STATE.TRANSIT) continue;
      const t = s.target[i];
      if (t < 0 || t >= nBodies) continue;
      const b = aa[t];
      if (!b || b.dead) continue;
      // Contest tally: in-transit fleets pressuring this body.
      if (s.owner[i] === 0) ownStr[t] += s.strength[i];
      else enemyStr[t] += s.strength[i];
      if (lines >= MAX_FLOW) continue; // tally continues past the draw cap
      const hex = ownerColorHex(s.owner[i]);
      tmpColor.setHex(hex);
      const o = lines * 6;
      flowPos[o] = s.x[i];
      flowPos[o + 1] = s.y[i];
      flowPos[o + 2] = FLOW_Z;
      flowPos[o + 3] = b.x;
      flowPos[o + 4] = b.y;
      flowPos[o + 5] = FLOW_Z;
      flowCol[o] = flowCol[o + 3] = tmpColor.r;
      flowCol[o + 1] = flowCol[o + 4] = tmpColor.g;
      flowCol[o + 2] = flowCol[o + 5] = tmpColor.b;
      lines++;
    }
    flowGeo.setDrawRange(0, lines * 2);
    if (lines) {
      flowGeo.attributes.position.needsUpdate = true;
      flowGeo.attributes.color.needsUpdate = true;
      flow.computeLineDistances(); // required for LineDashedMaterial
    }

    // --- Contest rings (skip bodies with no inbound fleet) ---
    let ri = 0;
    for (let b = 0; b < nBodies; b++) {
      const total = ownStr[b] + enemyStr[b];
      if (total <= 0) continue; // no contest here
      const body = aa[b];
      if (!body || body.dead || !body.habitable) continue;
      const r = ownStr[b] / total; // 1 = player-0 dominates, 0 = outnumbered
      // RED (outnumbered) → amber (even) → GREEN (dominant).
      tmpColor.setRGB(1 - r, r, 0.12);
      rings.setColorAt(ri, tmpColor);
      const scale = Math.max(CONTEST_R, (body.radius || 40) * 3.2);
      dummy.position.set(body.x, body.y, 0);
      dummy.scale.set(scale, scale, 1);
      dummy.updateMatrix();
      rings.setMatrixAt(ri, dummy.matrix);
      ri++;
    }
    rings.count = ri;
    rings.instanceMatrix.needsUpdate = true;
    if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
  }

  function setActive(on) {
    on = !!on;
    if (on === active) return;
    active = on;
    flow.visible = on;
    rings.visible = on;
    if (on) {
      lastSnapTick = -1; // force a recompute on the activation frame
    }
  }

  // update(dt) — called every frame by Game.render. Cheap no-op while inactive.
  function update(dt) {
    if (!active) return;
    if (lastSnapTick < 0 || world.tick - lastSnapTick >= SNAP_TICKS) {
      lastSnapTick = world.tick;
      recompute();
    }
    if (!reducedMotion()) flowMat.dashOffset -= (dt || 0) * (DASH + GAP) * 1.2;
  }

  function dispose() {
    scene.remove(flow);
    scene.remove(rings);
    flowGeo.dispose();
    flowMat.dispose();
    ringGeo.dispose();
    ringMat.dispose();
    rings.dispose();
  }

  return { setActive, update, dispose };
}
