// Render/AsteroidView.js — asteroids drawn as shaded planet bodies (one InstancedMesh with
// a shared radial-gradient "sphere" texture, tinted per-owner) plus a bright owner-colored
// RIM ring so ownership reads clearly and only the thin rim glows under bloom. A selection
// highlight ring + the LOD aggregate glow round it out. Asteroid count is small (dozens) and
// `id === index` (rocks are never removed). Per-rock stats are NOT drawn here — they show in
// the HUD panel when a rock is selected.
import * as THREE from "three";
import { ownerColor, ownerColorHex } from "./Palette.js";
import { lodActive } from "./SeedlingView.js";

// Dark rock body: owner hue pulled toward neutral slate and darkened so its lit center stays
// under the bloom threshold (reads as a solid planet, not a glowing orb).
const SLATE = new THREE.Color(0x2a3442);
function rockColor(out, owner) {
  ownerColor(out, owner);
  out.lerp(SLATE, 0.5);
  out.multiplyScalar(0.8);
  return out;
}

// A grayscale "sphere" texture: bright spot offset to the top-left (lit from above), falling
// off to a dark rim — multiplied by each rock's owner tint to fake a 3D planet on a flat disc.
function makePlanetTexture() {
  const s = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d");
  const g = ctx.createRadialGradient(
    s * 0.38,
    s * 0.36,
    s * 0.04,
    s * 0.5,
    s * 0.5,
    s * 0.52,
  );
  g.addColorStop(0, "#e9edf3");
  g.addColorStop(0.45, "#b4b9c2");
  g.addColorStop(0.8, "#777c87");
  g.addColorStop(1, "#3a3e46");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
  ctx.fill();
  // Faint surface mottling for a bit of planet texture.
  ctx.globalAlpha = 0.12;
  for (let i = 0; i < 14; i++) {
    const a = (i * 2.39996) % (Math.PI * 2);
    const rr = (0.12 + ((i * 7) % 30) / 100) * s * 0.42;
    const px = s / 2 + Math.cos(a) * s * 0.22;
    const py = s / 2 + Math.sin(a) * s * 0.22;
    ctx.fillStyle = i % 2 ? "#2a2e36" : "#cfd4dd";
    ctx.beginPath();
    ctx.arc(px, py, rr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // Darken the rim for a spherical edge.
  const rim = ctx.createRadialGradient(
    s / 2,
    s / 2,
    s * 0.34,
    s / 2,
    s / 2,
    s * 0.5,
  );
  rim.addColorStop(0, "rgba(0,0,0,0)");
  rim.addColorStop(1, "rgba(0,0,0,0.5)");
  ctx.fillStyle = rim;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createAsteroidView(scene, world, camCtl) {
  const rocks = world.asteroids;
  const n = rocks.length;
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  const lastOwner = new Int32Array(n).fill(-99);

  // --- Bodies: one InstancedMesh, unit circle scaled to each radius, shaded by the texture.
  const bodies = new THREE.InstancedMesh(
    new THREE.CircleGeometry(1, 36),
    new THREE.MeshBasicMaterial({ map: makePlanetTexture() }),
    Math.max(1, n),
  );
  bodies.count = n;
  bodies.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  bodies.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(Math.max(1, n) * 3),
    3,
  );
  scene.add(bodies);

  // --- Rims: a bright owner-colored ring hugging each rock edge (this is what glows) ---
  const rims = new THREE.InstancedMesh(
    new THREE.RingGeometry(0.9, 1.02, 44),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    Math.max(1, n),
  );
  rims.count = n;
  rims.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  rims.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(Math.max(1, n) * 3),
    3,
  );
  scene.add(rims);

  for (let i = 0; i < n; i++) {
    const a = rocks[i];
    dummy.position.set(a.x, a.y, -2);
    dummy.scale.set(a.radius, a.radius, 1);
    dummy.updateMatrix();
    bodies.setMatrixAt(i, dummy.matrix);
    dummy.position.set(a.x, a.y, -1.9);
    dummy.updateMatrix();
    rims.setMatrixAt(i, dummy.matrix);
  }
  bodies.instanceMatrix.needsUpdate = true;
  rims.instanceMatrix.needsUpdate = true;

  // --- LOD aggregate glow: one additive disc per rock, scaled/tinted by orbiter count ---
  const glow = new THREE.InstancedMesh(
    new THREE.CircleGeometry(1, 20),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
    Math.max(1, n),
  );
  glow.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(Math.max(1, n) * 3),
    3,
  );
  glow.frustumCulled = false;
  glow.count = 0; // hidden until LOD kicks in
  glow.position.z = -1.8;
  scene.add(glow);
  const glowCol = new THREE.Color();
  const orbitCount = new Int32Array(n);

  // --- Selection highlight: a single ring we reposition over the selected rock ---
  const selRing = new THREE.Mesh(
    new THREE.RingGeometry(1, 1.04, 64),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
    }),
  );
  selRing.visible = false;
  selRing.position.z = -1;
  scene.add(selRing);
  let selectedId = -1;

  // --- Rally indicator: a line from the selected rock to its anchor + a target marker ---
  const rallyGeo = new THREE.BufferGeometry();
  rallyGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(6), 3),
  );
  const rallyLine = new THREE.Line(
    rallyGeo,
    new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55 }),
  );
  rallyLine.visible = false;
  rallyLine.position.z = -1;
  rallyLine.frustumCulled = false;
  scene.add(rallyLine);
  const rallyFlag = new THREE.Mesh(
    new THREE.RingGeometry(1, 1.22, 24),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
    }),
  );
  rallyFlag.visible = false;
  rallyFlag.position.z = -1;
  scene.add(rallyFlag);

  function setSelected(id) {
    selectedId = id;
    const a = rocks[id];
    if (!a) {
      selRing.visible = false;
      return;
    }
    const rr = a.radius + 9;
    selRing.scale.set(rr, rr, 1);
    selRing.position.set(a.x, a.y, -1);
    selRing.visible = true;
  }
  function clearSelected() {
    selectedId = -1;
    selRing.visible = false;
  }

  // update — re-tint body + rim on ownership change (owners flip during play) + LOD glow.
  function update() {
    let dirty = false;
    for (let i = 0; i < n; i++) {
      const o = rocks[i].owner;
      if (o !== lastOwner[i]) {
        rockColor(col, o);
        bodies.setColorAt(i, col);
        ownerColor(col, o);
        rims.setColorAt(i, col);
        lastOwner[i] = o;
        dirty = true;
      }
    }
    if (dirty) {
      if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
      if (rims.instanceColor) rims.instanceColor.needsUpdate = true;
    }
    updateGlow();
    updateRally();
  }

  // Show the selected rock's rally line + target marker (owner-colored). Hidden otherwise.
  function updateRally() {
    const rock = selectedId >= 0 ? rocks[selectedId] : null;
    const tgt = rock && rock.rally >= 0 ? rocks[rock.rally] : null;
    if (!rock || !tgt) {
      rallyLine.visible = false;
      rallyFlag.visible = false;
      return;
    }
    const hex = ownerColorHex(rock.owner);
    const p = rallyGeo.attributes.position.array;
    p[0] = rock.x;
    p[1] = rock.y;
    p[2] = 0;
    p[3] = tgt.x;
    p[4] = tgt.y;
    p[5] = 0;
    rallyGeo.attributes.position.needsUpdate = true;
    rallyLine.material.color.setHex(hex);
    rallyLine.visible = true;
    const fr = tgt.radius + 6;
    rallyFlag.position.set(tgt.x, tgt.y, -1);
    rallyFlag.scale.set(fr, fr, 1);
    rallyFlag.material.color.setHex(hex);
    rallyFlag.visible = true;
  }

  // LOD glow: only active (and only paying the per-seedling tally) when seedlings are
  // sub-pixel (apparent-size LOD, shared with SeedlingView).
  function updateGlow() {
    if (!lodActive(camCtl)) {
      if (glow.count !== 0) glow.count = 0;
      return;
    }
    orbitCount.fill(0);
    const s = world.seed;
    for (let i = 0; i < s.count; i++) {
      const h = s.home[i];
      if (h >= 0 && h < n) orbitCount[h]++;
    }
    for (let i = 0; i < n; i++) {
      const a = rocks[i];
      const k = Math.min(1, orbitCount[i] / 30);
      const rr = a.radius * (1.4 + k * 2.6);
      dummy.position.set(a.x, a.y, 0);
      dummy.scale.set(rr, rr, 1);
      dummy.updateMatrix();
      glow.setMatrixAt(i, dummy.matrix);
      glowCol.setHex(ownerColorHex(a.owner)).multiplyScalar(0.25 + k * 0.75);
      glow.setColorAt(i, glowCol);
    }
    glow.count = n;
    glow.instanceMatrix.needsUpdate = true;
    if (glow.instanceColor) glow.instanceColor.needsUpdate = true;
  }

  update();

  // selected() lets the input loop query the current selection.
  return {
    bodies,
    rims,
    glow,
    setSelected,
    clearSelected,
    selected: () => selectedId,
    update,
  };
}
