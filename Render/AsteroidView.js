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

// A blazing star: white-hot core fading through gold to a soft transparent edge (it blooms).
function starTexture(rnd) {
  const h = 38 + rnd() * 18; // gold→amber
  return makeTex(
    (ctx, s) => {
      const g = ctx.createRadialGradient(
        s / 2,
        s / 2,
        s * 0.04,
        s / 2,
        s / 2,
        s / 2,
      );
      g.addColorStop(0, "#ffffff");
      g.addColorStop(0.4, hsl(h, 100, 75));
      g.addColorStop(0.75, hsl(h - 12, 95, 55));
      g.addColorStop(1, hsl(h - 18, 90, 38));
      ctx.fillStyle = g;
      disc(ctx, s);
      ctx.fill();
    },
    ["#ffffff", hsl(h, 100, 72), hsl(h - 12, 95, 52), hsl(h - 20, 90, 36)],
  );
}

// A black hole: dark void core ringed by a bright accretion glow (the ring blooms).
function blackholeTexture() {
  const s = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d");
  const g = ctx.createRadialGradient(
    s / 2,
    s / 2,
    s * 0.18,
    s / 2,
    s / 2,
    s / 2,
  );
  g.addColorStop(0, "#000000");
  g.addColorStop(0.5, "#05060a");
  g.addColorStop(0.74, "#0a0b12");
  g.addColorStop(0.82, "#7a5cff");
  g.addColorStop(0.9, "#ff8a3d");
  g.addColorStop(1, "rgba(255,150,80,0)");
  ctx.fillStyle = g;
  disc(ctx, s);
  ctx.fill();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Soft radial falloff (white core → transparent) for additive glow halos. Cached module-wide.
let _glowTex = null;
function radialGlowTexture() {
  if (_glowTex) return _glowTex;
  const s = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d");
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.5, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  disc(ctx, s);
  ctx.fill();
  _glowTex = new THREE.CanvasTexture(cv);
  _glowTex.colorSpace = THREE.SRGBColorSpace;
  return _glowTex;
}

// Textures deliberately cached at module scope and shared across matches — match teardown
// (Game.disposeSceneGraph) must NOT dispose these, or the next match gets a dead texture.
export function sharedTextures() {
  return _glowTex ? [_glowTex] : [];
}

export function createAsteroidView(scene, world, camCtl) {
  const rocks = world.asteroids;
  const n = rocks.length;
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  const lastOwner = new Int32Array(n).fill(-99);

  // Bodies that move each frame (moons, asteroid satellites, binary members) need their
  // instanced body/rim + the network edges rewritten every tick.
  const movingIds = [];
  for (let i = 0; i < n; i++) if (rocks[i].orbiting) movingIds.push(i);
  const hasMoving = movingIds.length > 0;

  // --- Bodies: all ASTEROIDS (incl. moons/satellites/binaries) in one instanced rock mesh;
  //     planets and the star/black hole each get their own mesh. ---
  const rockIds = [];
  for (let i = 0; i < n; i++) if (rocks[i].kind === "asteroid") rockIds.push(i);
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
    const rnd = rngFrom(a.seed || a.id + 1);
    if (a.kind === "planet") {
      const tex = a.ptype === "terran" ? terranTexture(rnd) : gasTexture(rnd);
      const pm = new THREE.Mesh(
        new THREE.CircleGeometry(1, 48),
        new THREE.MeshBasicMaterial({ map: tex, color: 0x8c8c8c }),
      );
      pm.position.set(a.x, a.y, -2);
      pm.scale.set(a.radius, a.radius, 1);
      scene.add(pm);
    } else if (a.kind === "star" || a.kind === "blackhole") {
      const isHole = a.kind === "blackhole";
      const body = new THREE.Mesh(
        new THREE.CircleGeometry(1, 56),
        new THREE.MeshBasicMaterial({
          map: isHole ? blackholeTexture() : starTexture(rnd),
          color: 0xffffff, // bright → the star/accretion ring blooms
          transparent: isHole,
        }),
      );
      body.position.set(a.x, a.y, -2);
      body.scale.set(a.radius, a.radius, 1);
      scene.add(body);
      // Soft additive halo so a star reads as a light source (smaller, dimmer for a hole).
      const halo = new THREE.Mesh(
        new THREE.CircleGeometry(1, 40),
        new THREE.MeshBasicMaterial({
          map: radialGlowTexture(),
          color: isHole ? 0x6a4cff : 0xffd27a,
          transparent: true,
          opacity: isHole ? 0.35 : 0.6,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      const hs = a.radius * (isHole ? 1.5 : 2.1);
      halo.position.set(a.x, a.y, -1.7);
      halo.scale.set(hs, hs, 1);
      scene.add(halo);
    }
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
      opacity: 0.16,
    }),
  );
  net.frustumCulled = false;
  scene.add(net);

  // --- Manual player-built connections (world.links): a brighter, distinct line layer that
  //     rebuilds when links are added (their endpoints may be moving bodies). ---
  const linkGeo = new THREE.BufferGeometry();
  let linkPos = new Float32Array(0);
  let linkCount = -1;
  const linkNet = new THREE.LineSegments(
    linkGeo,
    new THREE.LineBasicMaterial({
      color: 0x66ffc8,
      transparent: true,
      opacity: 0.6,
    }),
  );
  linkNet.frustumCulled = false;
  scene.add(linkNet);
  function writeLinks() {
    const links = world.links || [];
    if (links.length !== linkCount) {
      linkCount = links.length;
      linkPos = new Float32Array(links.length * 6);
      linkGeo.setAttribute("position", new THREE.BufferAttribute(linkPos, 3));
    }
    for (let e = 0; e < links.length; e++) {
      const a = rocks[links[e][0]];
      const b = rocks[links[e][1]];
      const o = e * 6;
      linkPos[o] = a.x;
      linkPos[o + 1] = a.y;
      linkPos[o + 2] = -2.1;
      linkPos[o + 3] = b.x;
      linkPos[o + 4] = b.y;
      linkPos[o + 5] = -2.1;
    }
    linkGeo.setDrawRange(0, links.length * 2);
    if (links.length) linkGeo.attributes.position.needsUpdate = true;
  }
  writeLinks();

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
  let showInbound = false; // false = show selected body's OUTBOUND rally; true = INBOUND rallies

  // --- Rally routes: shown ONLY for the selected body (outbound by default, or the inverse
  //     "who rallies here" set when showInbound is toggled on). Bright line + flag ring. ---
  const rallySegGeo = new THREE.BufferGeometry();
  let rallySegPos = new Float32Array(0);
  let rallySegCap = -1;
  const rallyLine = new THREE.LineSegments(
    rallySegGeo,
    new THREE.LineBasicMaterial({
      color: 0x46ffd2,
      transparent: true,
      opacity: 0.7,
    }),
  );
  rallyLine.visible = false;
  rallyLine.position.z = -1;
  rallyLine.frustumCulled = false;
  scene.add(rallyLine);
  const rallyFlags = new THREE.InstancedMesh(
    new THREE.RingGeometry(0.84, 1.0, 28),
    new THREE.MeshBasicMaterial({
      color: 0x46ffd2,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
    }),
    Math.max(1, n),
  );
  rallyFlags.frustumCulled = false;
  rallyFlags.count = 0;
  rallyFlags.position.z = -1;
  scene.add(rallyFlags);

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

    // moving bodies (moons / satellites / binaries): update body + rim, and the network edges
    if (hasMoving) {
      for (const id of movingIds) {
        const a = rocks[id];
        dummy.position.set(a.x, a.y, -2);
        dummy.scale.set(a.radius, a.radius, 1);
        dummy.updateMatrix();
        if (rockLi[id] >= 0) rockMesh.setMatrixAt(rockLi[id], dummy.matrix);
        dummy.position.set(a.x, a.y, -1.9);
        dummy.updateMatrix();
        rims.setMatrixAt(id, dummy.matrix);
      }
      rockMesh.instanceMatrix.needsUpdate = true;
      rims.instanceMatrix.needsUpdate = true;
      writeNet();
      netGeo.attributes.position.needsUpdate = true;
    }
    writeLinks();

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
    // Rally lines show ONLY for the selected body. Default = OUTBOUND (this body → its rally
    // target). When showInbound is on = INVERSE (every body that rallies TO this one → here).
    const sel = selectedId >= 0 ? rocks[selectedId] : null;
    if (!sel) {
      rallyLine.visible = false;
      rallyFlags.count = 0;
      return;
    }
    // pairs: [fromRock, toRock, flagRock] — the flag marks the "other end".
    const pairs = [];
    if (showInbound) {
      for (let i = 0; i < n; i++) {
        const r = rocks[i];
        if (r.rally === sel.id && r.id !== sel.id) pairs.push([r, sel, r]);
      }
    } else if (sel.rally >= 0 && rocks[sel.rally]) {
      pairs.push([sel, rocks[sel.rally], rocks[sel.rally]]);
    }
    if (pairs.length === 0) {
      rallyLine.visible = false;
      rallyFlags.count = 0;
      return;
    }
    if (pairs.length * 2 !== rallySegCap) {
      rallySegCap = pairs.length * 2;
      rallySegPos = new Float32Array(pairs.length * 6);
      rallySegGeo.setAttribute(
        "position",
        new THREE.BufferAttribute(rallySegPos, 3),
      );
    }
    for (let k = 0; k < pairs.length; k++) {
      const [a, b, flag] = pairs[k];
      const o = k * 6;
      rallySegPos[o] = a.x;
      rallySegPos[o + 1] = a.y;
      rallySegPos[o + 2] = -1;
      rallySegPos[o + 3] = b.x;
      rallySegPos[o + 4] = b.y;
      rallySegPos[o + 5] = -1;
      const fr = flag.radius + 8;
      dummy.position.set(flag.x, flag.y, -1);
      dummy.scale.set(fr, fr, 1);
      dummy.updateMatrix();
      rallyFlags.setMatrixAt(k, dummy.matrix);
    }
    // Inbound view tinted distinctly (gold) from the default outbound (teal).
    rallyLine.material.color.setHex(showInbound ? 0xffcf5a : 0x46ffd2);
    rallyFlags.material.color.setHex(showInbound ? 0xffcf5a : 0x46ffd2);
    rallySegGeo.setDrawRange(0, pairs.length * 2);
    rallySegGeo.attributes.position.needsUpdate = true;
    rallyLine.visible = true;
    rallyFlags.count = pairs.length;
    rallyFlags.instanceMatrix.needsUpdate = true;
  }

  update();

  return {
    rims,
    glow,
    setSelected,
    clearSelected,
    selected: () => selectedId,
    toggleInbound: () => {
      showInbound = !showInbound;
      return showInbound;
    },
    setShowInbound: (on) => {
      showInbound = !!on;
    },
    isInbound: () => showInbound,
    update,
  };
}
