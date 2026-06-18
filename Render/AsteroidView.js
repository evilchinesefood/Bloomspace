// Render/AsteroidView.js — bodies as shaded spheres. Asteroids + moons share one instanced
// rock mesh; each PLANET is its own mesh with a UNIQUE procedural texture (seeded per planet,
// gas giant or terran — no two alike). Moons orbit their planet, so their body/rim/edge update
// every frame. A bright owner rim shows ownership; plus the neighbor network, LOD glow,
// selection ring, and rally route. `id === index`.
import * as THREE from "three";
import { ownerColor, ownerColorHex } from "./Palette.js";
import { lodActive } from "./SeedlingView.js";
import { CHARGE_TICKS } from "../Sim/Bombard.js";
import { STATE, MAX_PLAYERS } from "../Sim/World.js";
import { UNKNOWN } from "../Sim/Fog.js";

// Fog-of-war render state for the human (player 0), per rock:
//   2 visible (seen now) · 1 remembered (known but not currently seen) · 0 hidden (never explored).
// Returns 2 always when fog is off, so the whole render path is unchanged in that mode.
const FOG_HUMAN = 0;
function fogState(world, r) {
  if (!world.fogOn || !world.fog) return 2;
  if (world.fog.seen[FOG_HUMAN][r]) return 2;
  return world.fog.known[FOG_HUMAN][r] === UNKNOWN ? 0 : 1;
}
// The owner the human PERCEIVES for rock r: true owner when seen/no-fog, last-known when remembered.
function fogOwner(world, r, trueOwner) {
  if (!world.fogOn || !world.fog) return trueOwner;
  if (world.fog.seen[FOG_HUMAN][r]) return trueOwner;
  return world.fog.known[FOG_HUMAN][r];
}

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

// Soft hazy cloud (colored core → transparent) for nebula zones. Like the glow but with a
// fuller, foggier falloff so the region reads as a translucent haze, not a point light. Cached
// module-wide (tinted per-region via the mesh material color).
let _nebulaTex = null;
function nebulaTexture() {
  if (_nebulaTex) return _nebulaTex;
  const s = 256;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d");
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,0.85)");
  g.addColorStop(0.4, "rgba(255,255,255,0.5)");
  g.addColorStop(0.75, "rgba(255,255,255,0.18)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  disc(ctx, s);
  ctx.fill();
  _nebulaTex = new THREE.CanvasTexture(cv);
  _nebulaTex.colorSpace = THREE.SRGBColorSpace;
  return _nebulaTex;
}

// Dense-belt debris band (Feature 7b): a dusty DARK disc — opaque-ish murky core fading to
// transparent — speckled with scattered rock dots. Distinct from the nebula's light additive
// haze: this reads as a dirty, solid debris field that ships route around. Cached module-wide.
let _beltTex = null;
function beltTexture() {
  if (_beltTex) return _beltTex;
  const s = 256;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d");
  // Murky dust base: dark dusty-brown core fading to transparent at the edge.
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(54,46,38,0.9)");
  g.addColorStop(0.55, "rgba(44,38,32,0.6)");
  g.addColorStop(0.85, "rgba(30,26,22,0.22)");
  g.addColorStop(1, "rgba(20,18,16,0)");
  ctx.fillStyle = g;
  disc(ctx, s);
  ctx.fill();
  // Scattered debris dots clipped to the disc (deterministic seeded scatter).
  ctx.save();
  disc(ctx, s);
  ctx.clip();
  const rnd = rngFrom(0x5e17);
  for (let i = 0; i < 220; i++) {
    const a = rnd() * Math.PI * 2;
    const rr = Math.sqrt(rnd()) * s * 0.48; // uniform area fill
    const px = s / 2 + Math.cos(a) * rr;
    const py = s / 2 + Math.sin(a) * rr;
    const sz = 0.6 + rnd() * 2.4;
    const sh = 120 + Math.floor(rnd() * 90); // grey→tan rocks
    ctx.globalAlpha = 0.25 + rnd() * 0.5;
    ctx.fillStyle = `rgb(${sh},${sh - 18},${sh - 36})`;
    ctx.beginPath();
    ctx.arc(px, py, sz, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  _beltTex = new THREE.CanvasTexture(cv);
  _beltTex.colorSpace = THREE.SRGBColorSpace;
  return _beltTex;
}

// Textures deliberately cached at module scope and shared across matches — match teardown
// (Game.disposeSceneGraph) must NOT dispose these, or the next match gets a dead texture.
export function sharedTextures() {
  const out = [];
  if (_glowTex) out.push(_glowTex);
  if (_nebulaTex) out.push(_nebulaTex);
  if (_beltTex) out.push(_beltTex);
  return out;
}

export function createAsteroidView(scene, world, camCtl, fx) {
  const rocks = world.asteroids;
  const n = rocks.length;
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  const lastOwner = new Int32Array(n).fill(-99);
  // Fog render caches: lastFog gates the rim recolor; fogApplied gates the body/rim MASK pass — each
  // only rewrites an instance when a rock's visibility actually changes, not every frame. -9 = unset.
  const lastFog = new Int8Array(n).fill(-9);
  const fogApplied = new Int8Array(n).fill(-9);

  // Per-body THREE.Mesh refs for non-instanced bodies (planets, star, blackhole) + their halos,
  // keyed by id, so a destroyed body can be hidden (asteroids hide via their instanced matrix).
  const bodyMesh = new Array(n).fill(null);
  const bodyHalo = new Array(n).fill(null);
  // Dead-transition tracking: detect the frame a body first becomes `dead` (one-shot work:
  // hide body+rim, spawn explosion, drop network edges) — set ONCE, never re-fired.
  const deadSeen = new Uint8Array(n);

  // Bodies that move each frame (moons, asteroid satellites, binary members) need their
  // instanced body/rim + the network edges rewritten every tick.
  const movingIds = [];
  const movingFlag = new Uint8Array(n);
  for (let i = 0; i < n; i++)
    if (rocks[i].orbiting) {
      movingIds.push(i);
      movingFlag[i] = 1;
    }
  const hasMoving = movingIds.length > 0;

  // prefers-reduced-motion: damp the battery-ring pulse and beam flicker to constants so the
  // rings/beams stay visible but don't throb. From the scene controller (Scene.js computes it).
  const reducedMotion = !!(camCtl && camCtl.reducedMotion);

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

  // --- Nebula zones (Feature 7a): a soft translucent haze per world.nebulae region, sitting
  //     BEHIND the bodies (z behind rocks) so the zone reads as a hazy "hiding" cloud. Built
  //     once from the static region list; part of the scene graph so teardown reclaims it. ---
  const NEBULA_HUES = [0x6a4cff, 0x4cc2ff]; // violet + cyan, alternating per region
  for (let k = 0; k < (world.nebulae || []).length; k++) {
    const z = world.nebulae[k];
    const cloud = new THREE.Mesh(
      new THREE.CircleGeometry(1, 48),
      new THREE.MeshBasicMaterial({
        map: nebulaTexture(),
        color: NEBULA_HUES[k % NEBULA_HUES.length],
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    cloud.position.set(z.x, z.y, -2.5); // behind rocks (-2) and rims (-1.9)
    cloud.scale.set(z.radius, z.radius, 1);
    cloud.frustumCulled = false;
    scene.add(cloud);
  }

  // --- Dense belts (Feature 7b): a dusty DARK debris band per world.belts region. Normal
  //     (NOT additive) alpha blend so it darkens/obscures rather than glowing like a nebula —
  //     the visual cue that ships route AROUND it. Sits behind the bodies; built once from the
  //     static region list; part of the scene graph so teardown reclaims it. ---
  for (let k = 0; k < (world.belts || []).length; k++) {
    const z = world.belts[k];
    const band = new THREE.Mesh(
      new THREE.CircleGeometry(1, 48),
      new THREE.MeshBasicMaterial({
        map: beltTexture(),
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      }),
    );
    band.position.set(z.x, z.y, -2.4); // behind rocks (-2), just in front of nebulae (-2.5)
    band.scale.set(z.radius, z.radius, 1);
    band.frustumCulled = false;
    scene.add(band);
  }

  // --- Resource-rich glint (Feature 7a): an additive golden halo on each rich rock so it reads
  //     as a mineral-rich body (it blooms). One instanced layer over the rich set; static. ---
  const richIds = [];
  for (let i = 0; i < n; i++) if (rocks[i].special === "rich") richIds.push(i);
  if (richIds.length) {
    const richGlint = new THREE.InstancedMesh(
      new THREE.CircleGeometry(1, 32),
      new THREE.MeshBasicMaterial({
        map: radialGlowTexture(),
        color: 0xffd24a, // warm gold
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      richIds.length,
    );
    richGlint.frustumCulled = false;
    richGlint.position.z = -1.85; // just over the rock body, under seedlings
    for (let k = 0; k < richIds.length; k++) {
      const a = rocks[richIds[k]];
      const rr = a.radius * 1.7;
      dummy.position.set(a.x, a.y, 0);
      dummy.scale.set(rr, rr, 1);
      dummy.updateMatrix();
      richGlint.setMatrixAt(k, dummy.matrix);
    }
    richGlint.instanceMatrix.needsUpdate = true;
    scene.add(richGlint);
  }

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
      bodyMesh[i] = pm;
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
      bodyMesh[i] = body;
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
      bodyHalo[i] = halo;
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
  // edgePairs is rebuilt from the CURRENT neighbor lists whenever a body dies (the Sim clears a
  // dead body's neighbors), so its edges vanish. The buffer is allocated once at the initial
  // (max) edge count; the draw range shrinks when edges are dropped.
  let edgePairs = [];
  function buildEdgePairs() {
    edgePairs = [];
    for (let i = 0; i < n; i++) {
      if (rocks[i].dead) continue;
      for (const j of rocks[i].neighbors || [])
        if (j > i && !rocks[j].dead) edgePairs.push([i, j]);
    }
  }
  buildEdgePairs();
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
    netGeo.setDrawRange(0, edgePairs.length * 2);
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
    const countChanged = links.length !== linkCount;
    if (countChanged) {
      linkCount = links.length;
      linkPos = new Float32Array(links.length * 6);
      linkGeo.setAttribute("position", new THREE.BufferAttribute(linkPos, 3));
      linkGeo.setDrawRange(0, links.length * 2);
    }
    // Only rewrite + re-upload when the link set changed or an endpoint is a moving (orbiting)
    // body — a static link set needs no per-frame rewrite (mirrors the writeNet hasMoving gate).
    let endpointMoving = false;
    if (hasMoving)
      for (let e = 0; e < links.length; e++)
        if (movingFlag[links[e][0]] || movingFlag[links[e][1]]) {
          endpointMoving = true;
          break;
        }
    if (!countChanged && !endpointMoving) return;
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
  // Preallocated scratch for the rally set (grown only on capacity change) — no per-frame
  // arrays. rallyA/rallyB/rallyFlag hold rock indices for each [from, to, flag] triple.
  let rallyA = new Int32Array(0);
  let rallyB = new Int32Array(0);
  let rallyFlag = new Int32Array(0);
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

  // --- Bombard battery telegraph: a menacing additive ring on every ARMED rock, pulsing.
  //     A CHARGING rock (rock.bombard set) pulses brighter/faster, scaled by charge progress.
  //     One instanced ring layer, count set each frame from the live armed/charging set. ---
  const battery = new THREE.InstancedMesh(
    new THREE.RingGeometry(0.82, 1.0, 40),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexColors: true,
    }),
    Math.max(1, n),
  );
  battery.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(Math.max(1, n) * 3),
    3,
  );
  battery.frustumCulled = false;
  battery.count = 0;
  battery.position.z = -1.5;
  scene.add(battery);
  const batCol = new THREE.Color();
  let clock = 0; // seconds, advanced each frame for the pulse

  // --- Contest overlay: split bar above each contested rock showing each owner's share of
  //     present strength. Up to 2 segment instances per rock (top-2 owners). ---
  const OWN = Math.max(1, MAX_PLAYERS);
  const contestStr = new Float32Array(n * OWN); // [rock*OWN + owner] -> strength sum
  const hasCombat = new Uint8Array(n); // 1 if any STATE.COMBAT seedling present this frame
  const contCap = Math.max(1, 2 * n);
  const contest = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexColors: true,
    }),
    contCap,
  );
  contest.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(contCap * 3),
    3,
  );
  contest.frustumCulled = false;
  contest.count = 0;
  contest.position.z = -1.7;
  scene.add(contest);
  const contCol = new THREE.Color();

  // --- Charge beams: an additive/bloom laser from each charging battery to its target, growing
  //     as the charge resolves. One LineSegments rebuilt per frame from the charging set. ---
  const beamGeo = new THREE.BufferGeometry();
  let beamPos = new Float32Array(0);
  let beamCap = -1;
  // Preallocated scratch for the charging set (grown only on capacity change) — no per-frame
  // arrays. beamA/beamT hold rock indices, beamProg the charge progress.
  let beamA = new Int32Array(0);
  let beamT = new Int32Array(0);
  let beamProg = new Float32Array(0);
  const beam = new THREE.LineSegments(
    beamGeo,
    new THREE.LineBasicMaterial({
      color: 0xff5a3c,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  beam.frustumCulled = false;
  beam.visible = false;
  beam.position.z = -1;
  scene.add(beam);

  function setSelected(id) {
    selectedId = id;
    selRing.visible = !!rocks[id] && !rocks[id].dead;
  }
  function clearSelected() {
    selectedId = -1;
    selRing.visible = false;
  }

  // hideBody — the SHARED one-shot hide for a dead body, used by BOTH the in-play death path
  // (processDeaths) and the restore-time path (hideAlreadyDead) so the two can't drift ("fine in
  // a fresh game, wrong on resume"). Marks deadSeen, hides the stored mesh+halo (planet/star/
  // blackhole), zero-scales the rock-mesh instance (asteroid) and the owner rim, and seeds
  // lastOwner so a later update() pass never reads -99. Returns true if a rock-mesh instance was
  // touched (caller flushes instanceMatrix). Deliberately does NOT spawn the explosion or clear
  // selection — those are in-play-only effects that processDeaths layers on around this call.
  function hideBody(i) {
    deadSeen[i] = 1;
    if (bodyMesh[i]) bodyMesh[i].visible = false;
    if (bodyHalo[i]) bodyHalo[i].visible = false;
    let rockDirty = false;
    if (rockLi[i] >= 0) {
      dummy.position.set(0, 0, -2);
      dummy.scale.set(0, 0, 0);
      dummy.updateMatrix();
      rockMesh.setMatrixAt(rockLi[i], dummy.matrix);
      rockDirty = true;
    }
    // Hide the owner rim by zero-scaling its instance (off-screen + no area).
    dummy.position.set(0, 0, -1.9);
    dummy.scale.set(0, 0, 0);
    dummy.updateMatrix();
    rims.setMatrixAt(i, dummy.matrix);
    lastOwner[i] = rocks[i].owner;
    return rockDirty;
  }

  // processDeaths — once per frame: find bodies that JUST became dead and do the one-shot hide
  // (shared hideBody) PLUS the in-play-only effects: spawn an explosion burst (fx, if provided)
  // tinted by the body's last owner, clear selection if it was selected, then rebuild the
  // neighbor network so the dead body's edges vanish.
  function processDeaths() {
    let netDirty = false;
    let rockDirty = false;
    for (let i = 0; i < n; i++) {
      if (!rocks[i].dead || deadSeen[i]) continue;
      const a = rocks[i];
      // Capture the explosion tint BEFORE hideBody reseeds lastOwner to the (now-neutral) owner.
      const tint = ownerColorHex(lastOwner[i]);
      if (hideBody(i)) rockDirty = true;
      if (selectedId === i) clearSelected();
      if (fx && fx.spawnExplosion) fx.spawnExplosion(a.x, a.y, tint);
      netDirty = true;
    }
    if (rockDirty) rockMesh.instanceMatrix.needsUpdate = true;
    if (netDirty) {
      rims.instanceMatrix.needsUpdate = true;
      buildEdgePairs();
      writeNet();
      netGeo.attributes.position.needsUpdate = true;
    }
  }

  function update(dt = 0) {
    clock += dt;
    // owner-tint rims on change. lastOwner snapshots the owner BEFORE a death sets it NEUTRAL,
    // so processDeaths can color the explosion with the body's last owner (read before this).
    let dirty = false;
    for (let i = 0; i < n; i++) {
      if (rocks[i].dead) continue; // dead rim is hidden (zero-scaled), don't recolor it
      // Under fog the rim shows the human's PERCEIVED owner (last-known when remembered); a
      // remembered rim is dimmed so it reads as stale. Visible/no-fog rims are full-bright truth.
      // Recolor on a change in perceived owner OR fog state (so the dim toggles on re-seeing).
      const o = fogOwner(world, i, rocks[i].owner);
      const fs = world.fogOn ? fogState(world, i) : 2;
      if (o !== lastOwner[i] || fs !== lastFog[i]) {
        ownerColor(col, o);
        if (fs === 1) col.multiplyScalar(0.45);
        rims.setColorAt(i, col);
        lastOwner[i] = o;
        lastFog[i] = fs;
        dirty = true;
      }
    }
    if (dirty && rims.instanceColor) rims.instanceColor.needsUpdate = true;

    // Fog masking: hide bodies/rims for never-explored rocks, restore them when they become known.
    if (world.fogOn) updateFogMask();

    // One-shot hide for bodies that just died (must run before moving-body rewrites so a dead
    // moon's rim isn't re-shown). Reads lastOwner above for the explosion tint.
    processDeaths();

    // moving bodies (moons / satellites / binaries): update body + rim, and the network edges
    if (hasMoving) {
      for (const id of movingIds) {
        const a = rocks[id];
        if (a.dead) continue; // destroyed body stays hidden — never re-place its instances
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
    updateContest();
    updateRally();
    updateBattery();
    updateBeams();
  }

  // updateBattery — pulsing ring on every armed/charging live battery. Armed = steady menacing
  // pulse; charging = brighter/faster pulse scaled by charge progress (1 = just fired → 0). One
  // instanced layer; count = number of armed-or-charging live rocks this frame.
  function updateBattery() {
    let m = 0;
    for (let i = 0; i < n; i++) {
      const a = rocks[i];
      if (a.dead) continue;
      const charging = !!a.bombard;
      if (!a.armed && !charging) continue;
      let prog = 0; // charge progress 0→1 as charge ticks down to 0
      if (charging)
        prog = 1 - Math.max(0, Math.min(1, a.bombard.charge / CHARGE_TICKS));
      // Pulse: slow menacing throb when armed; fast, intensifying when charging.
      const speed = charging ? 9 + prog * 9 : 3.2;
      const pulse = reducedMotion ? 0.7 : 0.5 + 0.5 * Math.sin(clock * speed);
      const grow = charging ? 1.18 + prog * 0.5 : 1.12;
      const rr = a.radius * (grow + pulse * (charging ? 0.18 : 0.1));
      dummy.position.set(a.x, a.y, -1.5);
      dummy.scale.set(rr, rr, 1);
      dummy.updateMatrix();
      battery.setMatrixAt(m, dummy.matrix);
      // Armed = orange-red; charging = hotter, brighter toward white as it resolves.
      const bright = charging
        ? 0.7 + prog * 0.3 + pulse * 0.2
        : 0.55 + pulse * 0.3;
      if (charging) batCol.setRGB(1, 0.45 + prog * 0.4, 0.2 + prog * 0.3);
      else batCol.setHex(0xff5a28);
      batCol.multiplyScalar(bright);
      battery.setColorAt(m, batCol);
      m++;
    }
    battery.count = m;
    if (m > 0) {
      battery.instanceMatrix.needsUpdate = true;
      if (battery.instanceColor) battery.instanceColor.needsUpdate = true;
    }
  }

  // updateBeams — additive laser from each charging battery to its target, growing taut as the
  // charge resolves (jitter shrinks). Rebuilt every frame from the live charging set; hidden
  // when nothing is charging.
  function updateBeams() {
    if (beamA.length < n) {
      beamA = new Int32Array(n);
      beamT = new Int32Array(n);
      beamProg = new Float32Array(n);
    }
    let m = 0;
    for (let i = 0; i < n; i++) {
      const a = rocks[i];
      if (a.dead || !a.bombard) continue;
      const ti = a.bombard.target;
      const t = rocks[ti];
      if (!t || t.dead) continue;
      beamA[m] = i;
      beamT[m] = ti;
      beamProg[m] =
        1 - Math.max(0, Math.min(1, a.bombard.charge / CHARGE_TICKS));
      m++;
    }
    if (m === 0) {
      beam.visible = false;
      return;
    }
    if (m * 2 !== beamCap) {
      beamCap = m * 2;
      beamPos = new Float32Array(m * 6);
      beamGeo.setAttribute("position", new THREE.BufferAttribute(beamPos, 3));
    }
    let maxProg = 0;
    for (let k = 0; k < m; k++) {
      const a = rocks[beamA[k]];
      const t = rocks[beamT[k]];
      const o = k * 6;
      beamPos[o] = a.x;
      beamPos[o + 1] = a.y;
      beamPos[o + 2] = -1;
      beamPos[o + 3] = t.x;
      beamPos[o + 4] = t.y;
      beamPos[o + 5] = -1;
      if (beamProg[k] > maxProg) maxProg = beamProg[k];
    }
    beamGeo.setDrawRange(0, m * 2);
    beamGeo.attributes.position.needsUpdate = true;
    // Brighten + flicker the beam as the worst charge in the set resolves. Under reduced-motion
    // the flicker term is a steady constant (no ~6 Hz flash).
    const flick = reducedMotion ? 0.75 : Math.sin(clock * 40);
    beam.material.opacity = 0.45 + maxProg * 0.5 + 0.1 * flick;
    beam.visible = true;
  }

  // updateFogMask — apply the human's fog visibility to each non-dead body. Never-explored rocks
  // (state 0) are fully hidden (body/halo/rock-instance/rim zero-scaled); remembered rocks (state
  // 1) show a dimmed body (last-known); visible rocks (state 2) render normally. Driven off lastFog
  // (set in the rim loop just before this) so it only touches an instance when state changes — a
  // static fog frame costs one cheap scan. Only called when world.fogOn.
  function updateFogMask() {
    let rockDirty = false;
    let rimDirty = false;
    for (let i = 0; i < n; i++) {
      const a = rocks[i];
      if (a.dead) continue; // dead bodies are hidden by processDeaths; fog never re-shows them
      // Reuse the fog state the rim loop just computed into lastFog[i] (it runs first, every frame,
      // writing every non-dead rock) instead of recomputing fogState here.
      const fs = lastFog[i];
      // Re-mask only when this rock's state changed (or a visible moving body, whose transform the
      // moving-body pass rewrites each frame — its mask must follow). Static unchanged rocks: skip.
      if (fs === fogApplied[i] && !(fs !== 0 && a.orbiting)) continue;
      fogApplied[i] = fs;
      const visible = fs !== 0;
      const dim = fs === 1;
      // Planet / star / blackhole meshes: toggle visibility + dim the remembered ones.
      const bm = bodyMesh[i];
      if (bm) {
        bm.visible = visible;
        if (bm.material) {
          bm.material.transparent = dim || bm.material.transparent;
          bm.material.opacity = dim ? 0.4 : 1;
        }
        if (bodyHalo[i]) bodyHalo[i].visible = visible;
      }
      // Asteroid rock-mesh instance: zero-scale when hidden, restore the real matrix otherwise.
      if (rockLi[i] >= 0) {
        if (!visible) {
          dummy.position.set(0, 0, -2);
          dummy.scale.set(0, 0, 0);
        } else {
          dummy.position.set(a.x, a.y, -2);
          dummy.scale.set(a.radius, a.radius, 1);
        }
        dummy.updateMatrix();
        rockMesh.setMatrixAt(rockLi[i], dummy.matrix);
        rockDirty = true;
      }
      // Rim instance: zero-scale a hidden rock's rim (color already set in the rim loop).
      if (!visible) {
        dummy.position.set(0, 0, -1.9);
        dummy.scale.set(0, 0, 0);
        dummy.updateMatrix();
        rims.setMatrixAt(i, dummy.matrix);
        rimDirty = true;
      } else if (!a.orbiting) {
        // Restore a static rock's rim transform (moving rims are rewritten every frame anyway).
        dummy.position.set(a.x, a.y, -1.9);
        dummy.scale.set(a.radius, a.radius, 1);
        dummy.updateMatrix();
        rims.setMatrixAt(i, dummy.matrix);
        rimDirty = true;
      }
    }
    if (rockDirty) rockMesh.instanceMatrix.needsUpdate = true;
    if (rimDirty) rims.instanceMatrix.needsUpdate = true;
  }

  function updateGlow() {
    if (!lodActive(camCtl)) {
      if (glow.count !== 0) glow.count = 0;
      return;
    }
    orbitCount.fill(0);
    contestStr.fill(0);
    hasCombat.fill(0);
    const s = world.seed;
    for (let i = 0; i < s.count; i++) {
      const h = s.home[i];
      if (h >= 0 && h < n) {
        orbitCount[h]++;
        const st = s.state[i];
        if (st !== STATE.TRANSIT && st !== STATE.SLING) {
          const o = s.owner[i];
          if (o >= 0 && o < OWN) contestStr[h * OWN + o] += s.strength[i];
          if (st === STATE.COMBAT) hasCombat[h] = 1;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const a = rocks[i];
      // A destroyed body, OR (under fog) a rock the human can't currently SEE, emits no aggregate
      // glow — the orbiter count is live intel the human shouldn't read on a remembered/dark rock.
      if (a.dead || (world.fogOn && fogState(world, i) !== 2)) {
        dummy.position.set(0, 0, 0);
        dummy.scale.set(0, 0, 0);
        dummy.updateMatrix();
        glow.setMatrixAt(i, dummy.matrix);
        continue;
      }
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

  // updateContest — split bar above each contested rock (≥2 owners have present strength).
  // Draws up to 2 segment instances per rock: the top-2 owners by strength, side-by-side,
  // widths proportional to share. Strength is pre-accumulated by updateGlow's seedling scan.
  function updateContest() {
    if (!lodActive(camCtl)) {
      contest.count = 0;
      return;
    }
    const BAR_H = 4;
    const BAR_GAP = 8; // gap above rock edge
    let m = 0;
    for (let i = 0; i < n; i++) {
      const a = rocks[i];
      if (a.dead) continue;
      if (world.fogOn && fogState(world, i) !== 2) continue; // contest is live intel — seen only
      const base = i * OWN;
      // Find top-2 owners by strength.
      let o0 = -1,
        s0 = 0,
        o1 = -1,
        s1 = 0;
      for (let o = 0; o < OWN; o++) {
        const v = contestStr[base + o];
        if (v > s0) {
          o1 = o0;
          s1 = s0;
          o0 = o;
          s0 = v;
        } else if (v > s1) {
          o1 = o;
          s1 = v;
        }
      }
      if (o0 < 0 || o1 < 0) continue; // fewer than 2 owners present — not contested
      const total = s0 + s1;
      if (total <= 0) continue;
      const barW = a.radius * 1.4;
      const cy = a.y + a.radius + BAR_GAP;
      const pulse = hasCombat[i] ? 0.75 + 0.25 * Math.sin(clock * 7) : 1;
      // Segment 0: leader (o0), left half proportional to share.
      const w0 = barW * (s0 / total);
      const w1 = barW * (s1 / total);
      const x0 = a.x - barW / 2 + w0 / 2;
      const x1 = a.x - barW / 2 + w0 + w1 / 2;
      dummy.position.set(x0, cy, 0);
      dummy.scale.set(w0, BAR_H, 1);
      dummy.updateMatrix();
      contest.setMatrixAt(m, dummy.matrix);
      contCol.setHex(ownerColorHex(o0)).multiplyScalar(pulse);
      contest.setColorAt(m, contCol);
      m++;
      dummy.position.set(x1, cy, 0);
      dummy.scale.set(w1, BAR_H, 1);
      dummy.updateMatrix();
      contest.setMatrixAt(m, dummy.matrix);
      contCol.setHex(ownerColorHex(o1)).multiplyScalar(pulse);
      contest.setColorAt(m, contCol);
      m++;
    }
    contest.count = m;
    if (m > 0) {
      contest.instanceMatrix.needsUpdate = true;
      if (contest.instanceColor) contest.instanceColor.needsUpdate = true;
    }
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
    // Triples [from, to, flag] as parallel index scratch — the flag marks the "other end".
    if (rallyA.length < n) {
      rallyA = new Int32Array(n);
      rallyB = new Int32Array(n);
      rallyFlag = new Int32Array(n);
    }
    let m = 0;
    if (showInbound) {
      for (let i = 0; i < n; i++) {
        const r = rocks[i];
        if (r.rally === sel.id && r.id !== sel.id) {
          rallyA[m] = i;
          rallyB[m] = sel.id;
          rallyFlag[m] = i;
          m++;
        }
      }
    } else if (sel.rally >= 0 && rocks[sel.rally]) {
      rallyA[m] = sel.id;
      rallyB[m] = sel.rally;
      rallyFlag[m] = sel.rally;
      m++;
    }
    if (m === 0) {
      rallyLine.visible = false;
      rallyFlags.count = 0;
      return;
    }
    if (m * 2 !== rallySegCap) {
      rallySegCap = m * 2;
      rallySegPos = new Float32Array(m * 6);
      rallySegGeo.setAttribute(
        "position",
        new THREE.BufferAttribute(rallySegPos, 3),
      );
    }
    for (let k = 0; k < m; k++) {
      const a = rocks[rallyA[k]];
      const b = rocks[rallyB[k]];
      const flag = rocks[rallyFlag[k]];
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
    rallySegGeo.setDrawRange(0, m * 2);
    rallySegGeo.attributes.position.needsUpdate = true;
    rallyLine.visible = true;
    rallyFlags.count = m;
    rallyFlags.instanceMatrix.needsUpdate = true;
  }

  // Restored-world handling: a save can hold bodies that ALREADY died before saving (e.g. a
  // battery fired pre-save). They were built above as live instances; here, at construction, we
  // hide them (shared hideBody) and mark deadSeen so processDeaths treats them as already-handled
  // — NO spurious explosion fires on resume (processDeaths only explodes a NEW dead transition,
  // and hideBody itself never explodes). For a fresh match this loop finds nothing (no body is
  // dead at t0). The neighbor network was already built excluding dead bodies (buildEdgePairs
  // skips them), so only the body/rim/halo instances need hiding here.
  function hideAlreadyDead() {
    let rockDirty = false;
    for (let i = 0; i < n; i++) {
      if (!rocks[i].dead || deadSeen[i]) continue;
      if (hideBody(i)) rockDirty = true;
    }
    if (rockDirty) rockMesh.instanceMatrix.needsUpdate = true;
    rims.instanceMatrix.needsUpdate = true;
  }
  hideAlreadyDead();

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
