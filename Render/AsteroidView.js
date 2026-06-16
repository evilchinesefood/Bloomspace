// Render/AsteroidView.js — bodies drawn as shaded spheres with three looks (rocky asteroid,
// gas giant, terran planet), grouped into one instanced mesh per texture. A bright owner rim
// shows ownership (and glows), plus the neighbor-network lines, LOD aggregate glow, selection
// ring, and the rally route polyline. Asteroid count is small and `id === index`.
import * as THREE from "three";
import { ownerColor, ownerColorHex } from "./Palette.js";
import { lodActive } from "./SeedlingView.js";

// --- Body textures: a lit sphere gradient + per-type surface detail, drawn once. ----------
function disc(ctx, s) {
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
}
function radialBase(ctx, s, stops) {
  const g = ctx.createRadialGradient(
    s * 0.38,
    s * 0.36,
    s * 0.04,
    s * 0.5,
    s * 0.5,
    s * 0.52,
  );
  g.addColorStop(0, stops[0]);
  g.addColorStop(0.45, stops[1]);
  g.addColorStop(0.8, stops[2]);
  g.addColorStop(1, stops[3]);
  ctx.fillStyle = g;
  disc(ctx, s);
  ctx.fill();
}
function rimShade(ctx, s) {
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
  disc(ctx, s);
  ctx.fill();
}
function makeTex(detail, stops) {
  const s = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d");
  radialBase(ctx, s, stops);
  ctx.save();
  disc(ctx, s);
  ctx.clip();
  detail(ctx, s);
  ctx.restore();
  rimShade(ctx, s);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function rockTexture() {
  return makeTex(
    (ctx, s) => {
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
    },
    ["#e9edf3", "#b4b9c2", "#777c87", "#3a3e46"],
  );
}
function gasTexture() {
  return makeTex(
    (ctx, s) => {
      ctx.globalAlpha = 0.18;
      for (let b = 0; b < 7; b++) {
        const y = ((b + 0.5) / 7) * s;
        const h = (s / 7) * 0.6;
        ctx.fillStyle = b % 2 ? "#7a3e10" : "#ffd9a0";
        ctx.fillRect(0, y - h / 2, s, h);
      }
      ctx.globalAlpha = 0.5; // a storm oval
      ctx.fillStyle = "#d65a2a";
      ctx.beginPath();
      ctx.ellipse(s * 0.6, s * 0.58, s * 0.1, s * 0.06, 0, 0, Math.PI * 2);
      ctx.fill();
    },
    ["#ffe6b8", "#f0b46a", "#c87a3a", "#5e3618"],
  );
}
function terranTexture() {
  return makeTex(
    (ctx, s) => {
      const greens = ["#3f8f4e", "#5fae5a", "#7a6a3a"];
      ctx.globalAlpha = 0.85;
      for (let i = 0; i < 6; i++) {
        const a = i * 2.39996;
        const px = s / 2 + Math.cos(a) * s * 0.2 * (0.4 + i / 10);
        const py = s / 2 + Math.sin(a * 1.3) * s * 0.2;
        ctx.fillStyle = greens[i % 3];
        ctx.beginPath();
        ctx.ellipse(
          px,
          py,
          s * 0.14 * (0.6 + (i % 3) / 4),
          s * 0.1 * (0.6 + (i % 4) / 5),
          a,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.globalAlpha = 0.5; // polar caps
      ctx.fillStyle = "#eaf6ff";
      ctx.beginPath();
      ctx.ellipse(s / 2, s * 0.12, s * 0.18, s * 0.06, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(s / 2, s * 0.88, s * 0.18, s * 0.06, 0, 0, Math.PI * 2);
      ctx.fill();
    },
    ["#dff0ff", "#79b6e6", "#2f6fae", "#143a5e"],
  );
}

export function createAsteroidView(scene, world, camCtl) {
  const rocks = world.asteroids;
  const n = rocks.length;
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  const lastOwner = new Int32Array(n).fill(-99);

  // --- Bodies: one instanced mesh per texture (rock / gas giant / terran planet) ---
  const texFor = {
    asteroid: rockTexture(),
    gas: gasTexture(),
    terran: terranTexture(),
  };
  const groups = { asteroid: [], gas: [], terran: [] };
  for (let i = 0; i < n; i++) {
    const a = rocks[i];
    (
      groups[a.kind === "planet" ? a.ptype : "asteroid"] || groups.asteroid
    ).push(i);
  }
  for (const key of Object.keys(groups)) {
    const ids = groups[key];
    if (ids.length === 0) continue;
    const mesh = new THREE.InstancedMesh(
      new THREE.CircleGeometry(1, 40),
      // Darkened so the lit highlight stays under the bloom threshold (no white "suns").
      new THREE.MeshBasicMaterial({ map: texFor[key], color: 0x8c8c8c }),
      ids.length,
    );
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    for (let k = 0; k < ids.length; k++) {
      const a = rocks[ids[k]];
      dummy.position.set(a.x, a.y, -2);
      dummy.scale.set(a.radius, a.radius, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(k, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);
  }

  // --- Rims: bright owner-colored ring hugging each rock edge (this is what glows) ---
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
  for (let i = 0; i < n; i++) {
    const a = rocks[i];
    dummy.position.set(a.x, a.y, -1.9);
    dummy.scale.set(a.radius, a.radius, 1);
    dummy.updateMatrix();
    rims.setMatrixAt(i, dummy.matrix);
  }
  rims.instanceMatrix.needsUpdate = true;
  scene.add(rims);

  // --- Neighbor network: faint static lines between connected asteroids (travel routes) ---
  const edgePts = [];
  for (let i = 0; i < n; i++) {
    for (const j of rocks[i].neighbors || []) {
      if (j <= i) continue;
      edgePts.push(rocks[i].x, rocks[i].y, -2.2, rocks[j].x, rocks[j].y, -2.2);
    }
  }
  const net = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute(
      "position",
      new THREE.Float32BufferAttribute(edgePts, 3),
    ),
    new THREE.LineBasicMaterial({
      color: 0x2b3a5c,
      transparent: true,
      opacity: 0.4,
    }),
  );
  net.frustumCulled = false;
  scene.add(net);

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
  glow.count = 0;
  glow.position.z = -1.8;
  scene.add(glow);
  const glowCol = new THREE.Color();
  const orbitCount = new Int32Array(n);

  // --- Selection highlight ---
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

  // --- Rally route polyline (through the network) + target marker ---
  const rallyGeo = new THREE.BufferGeometry();
  rallyGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array((n + 1) * 3), 3),
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

  function update() {
    let dirty = false;
    for (let i = 0; i < n; i++) {
      const o = rocks[i].owner;
      if (o !== lastOwner[i]) {
        ownerColor(col, o);
        rims.setColorAt(i, col);
        lastOwner[i] = o;
        dirty = true;
      }
    }
    if (dirty && rims.instanceColor) rims.instanceColor.needsUpdate = true;
    updateGlow();
    updateRally();
  }

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
    const nav = world.nav;
    let idx = 0,
      node = rock.id,
      steps = 0;
    p[idx++] = rock.x;
    p[idx++] = rock.y;
    p[idx++] = -1;
    while (node !== tgt.id && steps < n) {
      const hop = nav && nav[node] ? nav[node][tgt.id] : tgt.id;
      if (hop < 0 || hop === node) break;
      node = hop;
      p[idx++] = rocks[node].x;
      p[idx++] = rocks[node].y;
      p[idx++] = -1;
      steps++;
    }
    rallyGeo.setDrawRange(0, idx / 3);
    rallyGeo.attributes.position.needsUpdate = true;
    rallyGeo.computeBoundingSphere();
    rallyLine.material.color.setHex(hex);
    rallyLine.visible = true;
    const fr = tgt.radius + 6;
    rallyFlag.position.set(tgt.x, tgt.y, -1);
    rallyFlag.scale.set(fr, fr, 1);
    rallyFlag.material.color.setHex(hex);
    rallyFlag.visible = true;
  }

  update();

  return {
    rims,
    glow,
    setSelected,
    clearSelected,
    selected: () => selectedId,
    update,
  };
}
