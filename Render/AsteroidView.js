// Render/AsteroidView.js — bodies as shaded spheres. Asteroids + moons share one instanced
// rock mesh; each PLANET is its own mesh with a UNIQUE procedural texture (seeded per planet,
// gas giant or terran — no two alike). Moons orbit their planet, so their body/rim/edge update
// every frame. A bright owner rim shows ownership; plus the neighbor network, LOD glow,
// selection ring, and rally route. `id === index`.
import * as THREE from "three";
import { ownerColor, ownerColorHex } from "./Palette.js";
import { lodActive } from "./SeedlingView.js";

// Small seeded PRNG so each planet's look is unique but stable.
function rngFrom(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
const hsl = (h, sa, l) => `hsl(${h},${sa}%,${l}%)`;
function sphereStops(h, sa, l) {
  return [
    hsl(h, sa, l),
    hsl(h, sa, l - 22),
    hsl(h, sa, l - 42),
    hsl(h, sa, l - 58),
  ];
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

// Unique gas giant: warm hue, varied band count/lightness + a storm oval.
function gasTexture(rnd) {
  const h = 8 + rnd() * 50; // red→yellow
  const sa = 52 + rnd() * 22;
  const l = 68 + rnd() * 12;
  const bands = 5 + Math.floor(rnd() * 5);
  return makeTex(
    (ctx, s) => {
      for (let b = 0; b < bands; b++) {
        const y = ((b + 0.5) / bands) * s;
        const hgt = (s / bands) * (0.5 + rnd() * 0.5);
        ctx.globalAlpha = 0.16 + rnd() * 0.14;
        ctx.fillStyle = hsl(h + (rnd() * 16 - 8), sa, b % 2 ? l - 18 : l + 8);
        ctx.fillRect(0, y - hgt / 2, s, hgt);
      }
      ctx.globalAlpha = 0.55; // storm
      ctx.fillStyle = hsl((h + 18) % 360, sa + 10, l - 28);
      ctx.beginPath();
      ctx.ellipse(
        s * (0.35 + rnd() * 0.4),
        s * (0.4 + rnd() * 0.35),
        s * (0.07 + rnd() * 0.06),
        s * (0.045 + rnd() * 0.04),
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    },
    sphereStops(h, sa, l),
  );
}

// Unique terran world: varied ocean hue + scattered continents + polar caps.
function terranTexture(rnd) {
  const oceanH = 190 + rnd() * 70; // blue→cyan→violet
  const sa = 48 + rnd() * 26;
  const l = 62 + rnd() * 12;
  const landH = 80 + rnd() * 60; // green→olive
  const blobs = 4 + Math.floor(rnd() * 4);
  return makeTex(
    (ctx, s) => {
      ctx.globalAlpha = 0.85;
      for (let i = 0; i < blobs; i++) {
        const a = rnd() * Math.PI * 2;
        const rad = (0.12 + rnd() * 0.28) * s;
        ctx.fillStyle = hsl(
          landH + (rnd() * 30 - 15),
          45 + rnd() * 20,
          38 + rnd() * 18,
        );
        ctx.beginPath();
        ctx.ellipse(
          s / 2 + Math.cos(a) * rad,
          s / 2 + Math.sin(a) * rad,
          s * (0.1 + rnd() * 0.1),
          s * (0.07 + rnd() * 0.09),
          a,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.globalAlpha = 0.5; // polar caps
      ctx.fillStyle = "#eaf6ff";
      ctx.beginPath();
      ctx.ellipse(s / 2, s * 0.11, s * 0.18, s * 0.06, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(s / 2, s * 0.89, s * 0.18, s * 0.06, 0, 0, Math.PI * 2);
      ctx.fill();
      void oceanH;
    },
    sphereStops(oceanH, sa, l),
  );
}

export function createAsteroidView(scene, world, camCtl) {
  const rocks = world.asteroids;
  const n = rocks.length;
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  const lastOwner = new Int32Array(n).fill(-99);

  const moonIds = [];
  for (let i = 0; i < n; i++) if (rocks[i].moon) moonIds.push(i);
  const hasMoons = moonIds.length > 0;

  // --- Bodies: asteroids + moons in one instanced rock mesh; planets each their own mesh ---
  const rockIds = [];
  for (let i = 0; i < n; i++) if (rocks[i].kind !== "planet") rockIds.push(i);
  const rockLi = new Int32Array(n).fill(-1); // asteroid id -> local index in rock mesh
  const rockMesh = new THREE.InstancedMesh(
    new THREE.CircleGeometry(1, 40),
    new THREE.MeshBasicMaterial({ map: rockTexture(), color: 0x8c8c8c }),
    Math.max(1, rockIds.length),
  );
  rockMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let k = 0; k < rockIds.length; k++) {
    const a = rocks[rockIds[k]];
    rockLi[rockIds[k]] = k;
    dummy.position.set(a.x, a.y, -2);
    dummy.scale.set(a.radius, a.radius, 1);
    dummy.updateMatrix();
    rockMesh.setMatrixAt(k, dummy.matrix);
  }
  rockMesh.count = rockIds.length;
  rockMesh.instanceMatrix.needsUpdate = true;
  scene.add(rockMesh);

  for (let i = 0; i < n; i++) {
    const a = rocks[i];
    if (a.kind !== "planet") continue;
    const rnd = rngFrom(a.seed || a.id + 1);
    const tex = a.ptype === "terran" ? terranTexture(rnd) : gasTexture(rnd);
    const pm = new THREE.Mesh(
      new THREE.CircleGeometry(1, 48),
      new THREE.MeshBasicMaterial({ map: tex, color: 0x8c8c8c }),
    );
    pm.position.set(a.x, a.y, -2);
    pm.scale.set(a.radius, a.radius, 1);
    scene.add(pm);
  }

  // --- Rims (owner-colored, one per body; moon rims update each frame) ---
  const rims = new THREE.InstancedMesh(
    new THREE.RingGeometry(0.9, 1.02, 44),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    Math.max(1, n),
  );
  rims.count = n;
  rims.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
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

  // --- Neighbor network (faint; moon edges move so rebuild positions when there are moons) ---
  const edgePairs = [];
  for (let i = 0; i < n; i++)
    for (const j of rocks[i].neighbors || []) if (j > i) edgePairs.push([i, j]);
  const netGeo = new THREE.BufferGeometry();
  const netPos = new Float32Array(edgePairs.length * 6);
  function writeNet() {
    for (let e = 0; e < edgePairs.length; e++) {
      const a = rocks[edgePairs[e][0]];
      const b = rocks[edgePairs[e][1]];
      const o = e * 6;
      netPos[o] = a.x;
      netPos[o + 1] = a.y;
      netPos[o + 2] = -2.2;
      netPos[o + 3] = b.x;
      netPos[o + 4] = b.y;
      netPos[o + 5] = -2.2;
    }
  }
  writeNet();
  netGeo.setAttribute("position", new THREE.BufferAttribute(netPos, 3));
  const net = new THREE.LineSegments(
    netGeo,
    new THREE.LineBasicMaterial({
      color: 0x5878b4,
      transparent: true,
      opacity: 0.35,
    }),
  );
  net.frustumCulled = false;
  scene.add(net);

  // --- LOD aggregate glow ---
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

  // --- Selection highlight (repositioned each frame so it tracks moving moons) ---
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

  // --- Rally route polyline + target marker ---
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
    selRing.visible = !!rocks[id];
  }
  function clearSelected() {
    selectedId = -1;
    selRing.visible = false;
  }

  function update() {
    // owner-tint rims on change
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

    // moving moons: update their rock body + rim, and the network edges
    if (hasMoons) {
      for (const id of moonIds) {
        const a = rocks[id];
        dummy.position.set(a.x, a.y, -2);
        dummy.scale.set(a.radius, a.radius, 1);
        dummy.updateMatrix();
        rockMesh.setMatrixAt(rockLi[id], dummy.matrix);
        dummy.position.set(a.x, a.y, -1.9);
        dummy.updateMatrix();
        rims.setMatrixAt(id, dummy.matrix);
      }
      rockMesh.instanceMatrix.needsUpdate = true;
      rims.instanceMatrix.needsUpdate = true;
      writeNet();
      netGeo.attributes.position.needsUpdate = true;
    }

    // selection ring tracks the (possibly moving) selected rock
    const sel = selectedId >= 0 ? rocks[selectedId] : null;
    if (sel) {
      const rr = sel.radius + 9;
      selRing.scale.set(rr, rr, 1);
      selRing.position.set(sel.x, sel.y, -1);
    }

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
