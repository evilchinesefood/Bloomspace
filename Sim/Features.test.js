import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, OWNER_NEUTRAL } from "./World.js";
import Sim from "./World.js";
import { addConnection } from "./MapGen.js";
import { setRally, sendSeedlings } from "./Seedlings.js";

const SLING = 4; // STATE.SLING

const DT = 1 / 30;
const TWO = [
  { id: 0, isAi: false, difficulty: 0 },
  { id: 1, isAi: true, difficulty: 1 },
];
const mk = (seed, count = 20) =>
  createWorld({
    seed,
    asteroidCount: count,
    players: TWO,
    width: 2000,
    height: 2000,
  });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const star = (w) =>
  w.asteroids.find((a) => a.kind === "star" || a.kind === "blackhole");

// --- central star ----------------------------------------------------------
test("every map has exactly one central, non-habitable star/black hole", () => {
  for (const seed of [1, 2, 3, 7, 11]) {
    const stars = mk(seed).asteroids.filter(
      (a) => a.kind === "star" || a.kind === "blackhole",
    );
    assert.equal(stars.length, 1);
    assert.equal(stars[0].habitable, false);
  }
});

test("ships rally to a star and orbit it, but never colonize it", () => {
  const w = mk(3);
  const s = star(w);
  const home = w.asteroids.find((a) => a.owner === 0);
  assert.ok(setRally(w, home.id, s.id, 0));
  for (let t = 0; t < 600; t++) Sim.step(w, DT);
  assert.equal(s.owner, OWNER_NEUTRAL, "star was colonized");
  let orbiting = 0;
  for (let i = 0; i < w.seed.count; i++)
    if (w.seed.home[i] === s.id) orbiting++;
  // black-hole maps annihilate orbiters; a star gathers them.
  if (s.kind === "star")
    assert.ok(orbiting > 0, "no ships gathered at the star");
});

// --- black hole ------------------------------------------------------------
test("a black hole destroys any ship that enters its orbit", () => {
  let w;
  let seed = 0;
  do {
    seed++;
    w = mk(seed);
  } while (!w.asteroids.some((a) => a.kind === "blackhole") && seed < 80);
  const bh = w.asteroids.find((a) => a.kind === "blackhole");
  assert.ok(bh, "no black-hole seed found");
  for (let k = 0; k < 6; k++)
    Sim.spawnSeedling(w, {
      home: bh.id,
      owner: 0,
      orbitRadius: bh.radius + 20,
      orbitAngle: k,
    });
  const before = w.seed.count;
  Sim.step(w, DT);
  assert.ok(
    w.seed.count <= before - 6,
    "black hole did not annihilate orbiters",
  );
});

// --- win/lose --------------------------------------------------------------
test("win = eliminate all enemies (need NOT own every body)", () => {
  const w = mk(3);
  for (const a of w.asteroids) if (a.owner >= 1) a.owner = OWNER_NEUTRAL;
  const s = w.seed;
  for (let i = s.count - 1; i >= 0; i--)
    if (s.owner[i] >= 1) Sim.killSeedling(w, i);
  Sim.step(w, DT);
  assert.equal(w.status, "won");
  assert.ok(
    w.asteroids.some((a) => a.owner === OWNER_NEUTRAL),
    "won while neutral bodies still exist — exactly the point",
  );
});

test("lose = player has zero asteroids AND zero seedlings", () => {
  const w = mk(3);
  for (const a of w.asteroids) if (a.owner === 0) a.owner = OWNER_NEUTRAL;
  const s = w.seed;
  for (let i = s.count - 1; i >= 0; i--)
    if (s.owner[i] === 0) Sim.killSeedling(w, i);
  Sim.step(w, DT);
  assert.equal(w.status, "lost");
});

// --- manual connections ----------------------------------------------------
test("manual connection links two bodies and reroutes units directly", () => {
  const w = mk(1, 26);
  const home = w.asteroids.find((a) => a.owner === 0);
  let far = -1;
  let bd = -1;
  for (const a of w.asteroids) {
    if (a.moon || a.binarySecondary || a.id === home.id || !a.habitable)
      continue;
    const d = dist(home, a);
    if (d > bd) {
      bd = d;
      far = a.id;
    }
  }
  assert.notEqual(
    w.nav[home.id][far],
    far,
    "far rock was already a direct hop",
  );
  assert.ok(addConnection(w, home.id, far));
  assert.equal(
    w.nav[home.id][far],
    far,
    "nav not rerouted across the new link",
  );
  assert.ok(
    home.neighbors.includes(far) &&
      w.asteroids[far].neighbors.includes(home.id),
  );
  assert.equal(addConnection(w, home.id, far), false, "duplicate link allowed");
});

// --- orbital integrity -----------------------------------------------------
test("orbiting bodies never clip neighbours across many ticks", () => {
  const w = mk(1, 26);
  let maxOverlap = 0;
  for (let t = 0; t < 400; t++) {
    Sim.step(w, DT);
    const A = w.asteroids;
    for (let i = 0; i < A.length; i++)
      for (let j = i + 1; j < A.length; j++) {
        const ov = A[i].radius + A[j].radius - dist(A[i], A[j]);
        if (ov > maxOverlap) maxOverlap = ov;
      }
  }
  assert.ok(maxOverlap <= 0.5, `bodies clipped by ${maxOverlap.toFixed(1)}`);
});

// --- AI development --------------------------------------------------------
test("Normal+ AI develops (plants trees); Easy never does", () => {
  const treesFor = (dif) => {
    const w = createWorld({
      seed: 5,
      asteroidCount: 20,
      planetMin: 0,
      planetMax: 1,
      players: [
        { id: 0, isAi: false, difficulty: 0 },
        { id: 1, isAi: true, difficulty: dif },
      ],
    });
    for (let t = 0; t < 3000; t++) Sim.step(w, DT);
    let trees = 0;
    for (const a of w.asteroids) if (a.owner === 1) trees += a.trees.length;
    return trees;
  };
  assert.equal(treesFor(0), 0, "Easy should not plant trees");
  assert.ok(treesFor(1) > 0, "Normal should develop (plant trees)");
});

// --- slingshot ------------------------------------------------------------
// Farthest plain body reachable from `home` via 2+ hops (so the route has an intermediate).
function multiHopTarget(w, home) {
  let far = -1;
  let bd = -1;
  for (const a of w.asteroids) {
    if (a.moon || a.binarySecondary || a.id === home.id || !a.habitable)
      continue;
    if (w.nav[home.id][a.id] === a.id) continue; // direct neighbour — no intermediate
    const d = dist(home, a);
    if (d > bd) {
      bd = d;
      far = a.id;
    }
  }
  return far;
}

test("ships slingshot around intermediate bodies, then still reach the destination", () => {
  // The slingshot ROUTING mechanic: ships curve around an intermediate body (state SLING) and
  // still continue to a multi-hop destination. Tested with a passive opponent (so a live AI can't
  // contest the route — irrelevant to the mechanic) and across several seeds, so it's robust to
  // map/AI tuning — we only need the mechanic to demonstrably work on some map.
  let proven = false;
  for (let seed = 1; seed <= 12 && !proven; seed++) {
    const w = createWorld({
      seed,
      asteroidCount: 26,
      width: 2000,
      height: 2000,
      players: [
        { id: 0, isAi: false, difficulty: 0 },
        { id: 1, isAi: true, difficulty: 0 },
      ],
    });
    const home = w.asteroids.find((a) => a.owner === 0);
    const far = multiHopTarget(w, home);
    if (far < 0) continue;
    sendSeedlings(w, home.id, far, 1, 0);
    let sawSling = false;
    for (let t = 0; t < 2400; t++) {
      Sim.step(w, DT);
      for (let i = 0; i < w.seed.count; i++)
        if (w.seed.state[i] === SLING) sawSling = true;
    }
    const f = w.asteroids[far];
    let arrived = 0;
    for (let i = 0; i < w.seed.count; i++)
      if (
        w.seed.owner[i] === 0 &&
        dist({ x: w.seed.x[i], y: w.seed.y[i] }, f) < f.radius + 60
      )
        arrived++;
    if (sawSling && arrived > 0) proven = true;
  }
  assert.ok(
    proven,
    "no seed produced a ship that slingshotted past a body and reached the destination",
  );
});

test("a ship slinging past an enemy-held body fights it but does NOT capture it", () => {
  const w = mk(1, 26);
  const home = w.asteroids.find((a) => a.owner === 0);
  const mid = (home.neighbors || []).find(
    (id) =>
      w.asteroids[id].kind === "asteroid" &&
      !w.asteroids[id].moon &&
      id !== home.id,
  );
  let dest = -1;
  for (const a of w.asteroids) {
    if (a.id === home.id || a.id === mid || a.moon || !a.habitable) continue;
    if (w.nav[home.id][a.id] === mid) {
      dest = a.id;
      break;
    }
  }
  assert.ok(mid >= 0 && dest >= 0, "couldn't route through an intermediate");
  w.asteroids[mid].owner = 1;
  for (let k = 0; k < 6; k++)
    Sim.spawnSeedling(w, {
      home: mid,
      owner: 1,
      orbitRadius: w.asteroids[mid].radius + 35,
      orbitAngle: k,
      strength: 80,
      energy: 100,
    });
  const before = w.seed.count;
  sendSeedlings(w, home.id, dest, 1, 0);
  for (let t = 0; t < 900; t++) Sim.step(w, DT);
  assert.ok(
    w.seed.count < before,
    "no casualties — slinging ships never fought the defenders",
  );
  assert.equal(
    w.asteroids[mid].owner,
    1,
    "a passing/slinging ship wrongly captured the body",
  );
});

test("binary pairs stay locked diametrically opposite their shared centre", () => {
  let w;
  let seed = 0;
  do {
    seed++;
    w = mk(seed, 26);
  } while (!w.asteroids.some((a) => a.binary) && seed < 40);
  const prim = w.asteroids.find((a) => a.binary && !a.binarySecondary);
  assert.ok(prim, "no binary found");
  const sec = w.asteroids[prim.binaryPartner];
  for (let t = 0; t < 200; t++) Sim.step(w, DT);
  const cx = (prim.x + sec.x) / 2;
  const cy = (prim.y + sec.y) / 2;
  // centre stays put (fixed midpoint) and members stay opposite at equal radius
  assert.ok(Math.abs(cx - prim.orbitCx) < 1 && Math.abs(cy - prim.orbitCy) < 1);
  const dp = dist(prim, { x: prim.orbitCx, y: prim.orbitCy });
  const ds = dist(sec, { x: prim.orbitCx, y: prim.orbitCy });
  assert.ok(Math.abs(dp - ds) < 1, "binary members at unequal radii");
});
