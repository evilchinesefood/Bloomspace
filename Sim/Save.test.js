// Sim/Save.test.js — Feature 8a: save/resume SIM CORE. The round-trip determinism test is the
// GATE: serialize → deserialize → N×step() must match a never-saved run stepped N×, through
// tech, specials, a built-but-unfired bombard battery, a rally, and in-transit seedlings.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWorld,
  step,
  makeRng,
  makeSeedArrays,
  SEED_FIELDS,
} from "./World.js";
import { serialize, deserialize, SAVE_VERSION } from "./Save.js";
import { buyTech, TECH } from "./Tech.js";
import { plantTree } from "./Trees.js";
import { setRally, sendSeedlings } from "./Seedlings.js";
import { BATTERY_SIZE } from "./Bombard.js";

const DT = 1 / 30;

function makeWorld(seed = 7) {
  return createWorld({
    seed,
    asteroidCount: 14,
    specials: true,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 3 },
      { id: 2, isAi: true, difficulty: 2 },
    ],
    width: 4000,
    height: 4000,
  });
}

// Snapshot every behaviorally-load-bearing field into a comparable plain object.
function snap(w) {
  const s = w.seed;
  const fields = {};
  const fieldNames = [
    "x",
    "y",
    "px",
    "py",
    "vx",
    "vy",
    "home",
    "target",
    "dest",
    "owner",
    "energy",
    "strength",
    "orbitAngle",
    "orbitRadius",
    "state",
    "kind",
    "slingRem",
  ];
  for (const f of fieldNames) fields[f] = Array.from(s[f].subarray(0, s.count));
  return {
    tick: w.tick,
    status: w.status,
    seedCount: s.count,
    seedFields: fields,
    asteroids: w.asteroids.map((a) => ({
      id: a.id,
      owner: a.owner,
      energy: a.energy,
      dead: a.dead,
      armed: a.armed,
      rally: a.rally,
      neighbors: a.neighbors.slice(),
      bombard: a.bombard ? { ...a.bombard } : a.bombard,
      trees: a.trees.map((t) => ({ ...t })),
      x: a.x,
      y: a.y,
      orbitAng: a.orbitAng,
    })),
    players: w.players.map((p) => ({
      seeds: p.seeds,
      tech: { ...p.tech },
      _aiCd: p._aiCd,
      _aiSends: p._aiSends,
      _techRR: p._techRR,
      _techTick: p._techTick,
      _domTicks: p._domTicks,
      _bombFires: p._bombFires,
      _bombPlants: p._bombPlants,
      _bombFireTick: p._bombFireTick,
      _bombPlanTick: p._bombPlanTick,
    })),
  };
}

// Build a world with rich state: warm it up, then deliberately add tech + a built (mature, NOT
// fired) bombard battery + a rally + in-transit seedlings. Returns the world.
function richWorld(seed = 7) {
  const w = makeWorld(seed);
  // Warm the sim so AI counters, trees, economy, and orbits all carry mid-game state.
  for (let i = 0; i < 400; i++) step(w, DT);

  // Tech on >= 1 track for the human (sanctioned mutation).
  const p0 = w.players[0];
  p0.seeds += 200;
  assert.equal(buyTech(w, 0, TECH.STRENGTH), true, "bought STRENGTH tech");
  assert.equal(buyTech(w, 0, TECH.STRENGTH), true, "bought STRENGTH tech t2");
  assert.equal(buyTech(w, 0, TECH.REGEN), true, "bought REGEN tech");

  // Find a human-owned live habitable rock; give it energy + plant a FULL bombard battery
  // (5 mature bombard trees) — built but NOT fired (no rock.bombard charge).
  const host = w.asteroids.find((a) => a.owner === 0 && !a.dead && a.habitable);
  assert.ok(host, "human owns a habitable rock");
  host.energy = 1000;
  p0.seeds += 500;
  for (let k = 0; k < BATTERY_SIZE; k++) {
    assert.equal(
      plantTree(w, host.id, "bombard", 0),
      true,
      `planted bombard tree ${k}`,
    );
  }
  // Mature all bombard trees so the battery is ARMED but not charging.
  for (const t of host.trees) if (t.type === "bombard") t.growth = 1;

  // Set a rally on another human rock toward the host (funnels orbiters → in-transit ships).
  const rallyRock = w.asteroids.find(
    (a) => a.owner === 0 && !a.dead && a.habitable && a.id !== host.id,
  );
  if (rallyRock) assert.equal(setRally(w, rallyRock.id, host.id, 0), true);

  // Force some in-transit seedlings directly from the host toward a neighbor.
  const nb = host.neighbors.find((j) => !w.asteroids[j].dead);
  if (nb != null) sendSeedlings(w, host.id, nb, 0.5, 0);

  // Step a few ticks so the rally/send produce live TRANSIT ships in the SoA.
  for (let i = 0; i < 10; i++) step(w, DT);
  return w;
}

// --- 1. ROUND-TRIP DETERMINISM (the GATE) -----------------------------------

test("round-trip: resumed match matches a never-saved continuation over N steps", () => {
  const w1 = richWorld(7);

  // Confirm we actually built the rich state the test claims to exercise.
  const teched =
    w1.players[0].tech.strength >= 2 && w1.players[0].tech.regen >= 1;
  assert.ok(teched, "human has multi-track tech before save");
  const builtBattery = w1.asteroids.some(
    (a) =>
      a.owner === 0 &&
      a.trees.filter((t) => t.type === "bombard" && t.growth >= 1).length >=
        BATTERY_SIZE,
  );
  assert.ok(builtBattery, "a full mature (unfired) bombard battery exists");
  assert.ok(
    w1.belts.length > 0 && w1.nebulae.length > 0,
    "specials (belts + nebulae) present",
  );
  const hasTransit = Array.from(w1.seed.state.subarray(0, w1.seed.count)).some(
    (st) => st === 1,
  );
  assert.ok(hasTransit, "in-transit seedlings exist before save");

  const saved = serialize(w1);
  const w2 = deserialize(saved);
  assert.ok(w2, "deserialize produced a world");

  // Immediately after restore, before stepping, the worlds must be identical.
  assert.deepEqual(
    snap(w2),
    snap(w1),
    "restored world == live world (pre-step)",
  );

  // Step BOTH an additional N and compare every load-bearing field.
  const N = 300;
  for (let i = 0; i < N; i++) {
    step(w1, DT);
    step(w2, DT);
  }
  assert.deepEqual(
    snap(w2),
    snap(w1),
    "resumed continuation diverged from never-saved run",
  );
});

// --- 2. RNG CONTINUITY ------------------------------------------------------

test("rng continuity: w2.rng() yields the same stream as w1.rng() after restore", () => {
  const w1 = makeWorld(13);
  for (let i = 0; i < 137; i++) step(w1, DT);
  const saved = serialize(w1);
  const w2 = deserialize(saved);
  // Draw from each — they must match value-for-value (the state integer round-tripped).
  for (let k = 0; k < 50; k++) {
    assert.equal(w2.rng(), w1.rng(), `rng draw ${k} mismatch`);
  }
});

test("makeRng accessors are a no-op on the numeric sequence", () => {
  // The refactor must NOT change Mulberry32 output. A plain rng and one whose state we
  // read/restore around each draw must produce the identical sequence.
  const a = makeRng(12345);
  const b = makeRng(12345);
  for (let k = 0; k < 1000; k++) {
    const st = b.getState();
    b.setState(st); // restore same state — must not perturb
    assert.equal(a(), b(), `seq diverged at ${k}`);
  }
});

// --- 3. SCHEMA VERSIONING ---------------------------------------------------

test("serialize stamps version: SAVE_VERSION", () => {
  const w = makeWorld();
  const saved = serialize(w);
  assert.equal(saved.version, SAVE_VERSION);
});

test("deserialize rejects a wrong/missing version → null", () => {
  const w = makeWorld();
  const saved = serialize(w);
  assert.equal(deserialize({ ...saved, version: SAVE_VERSION + 1 }), null);
  const noVer = { ...saved };
  delete noVer.version;
  assert.equal(deserialize(noVer), null);
  assert.equal(deserialize(null), null);
});

// --- 4. JSON-SAFETY (real localStorage string round-trip) -------------------

test("JSON.stringify/parse round-trips the saved object and still deserializes", () => {
  const w1 = richWorld(21);
  const saved = serialize(w1);
  const through = JSON.parse(JSON.stringify(saved));
  assert.deepEqual(
    through,
    saved,
    "saved object survives a JSON string round-trip",
  );
  const w2 = deserialize(through);
  assert.ok(w2, "deserialize of JSON-cycled save works");
  assert.deepEqual(
    snap(w2),
    snap(w1),
    "JSON-cycled restore matches live (pre-step)",
  );
  // And it still steps deterministically vs the live world.
  for (let i = 0; i < 120; i++) {
    step(w1, DT);
    step(w2, DT);
  }
  assert.deepEqual(
    snap(w2),
    snap(w1),
    "JSON-cycled restore steps deterministically",
  );
});

// --- 5. SoA FIDELITY --------------------------------------------------------

test("SoA fidelity: count, field values, and exact typed-array types restore", () => {
  const w1 = richWorld(33);
  const w2 = deserialize(serialize(w1));
  const s1 = w1.seed;
  const s2 = w2.seed;
  assert.equal(s2.count, s1.count, "count restored");
  assert.equal(s2.capacity, s1.capacity, "capacity restored");
  // Exact typed-array constructors per field (integer fields must NOT become Float).
  const ctorOf = (s) => ({
    x: s.x.constructor.name,
    home: s.home.constructor.name,
    target: s.target.constructor.name,
    owner: s.owner.constructor.name,
    state: s.state.constructor.name,
    kind: s.kind.constructor.name,
  });
  assert.deepEqual(ctorOf(s2), ctorOf(s1), "typed-array constructors match");
  assert.equal(s2.home.constructor, s1.home.constructor);
  assert.equal(s2.owner.constructor, s1.owner.constructor);
  // Every used slot of every field is equal.
  const names = [
    "x",
    "y",
    "px",
    "py",
    "vx",
    "vy",
    "home",
    "target",
    "dest",
    "owner",
    "energy",
    "strength",
    "orbitAngle",
    "orbitRadius",
    "state",
    "kind",
    "slingRem",
  ];
  for (const f of names) {
    assert.deepEqual(
      Array.from(s2[f].subarray(0, s2.count)),
      Array.from(s1[f].subarray(0, s1.count)),
      `field ${f} mismatch`,
    );
  }
  // Stepping the restored world doesn't throw.
  assert.doesNotThrow(() => {
    for (let i = 0; i < 30; i++) step(w2, DT);
  });
});

// --- 6. SPECIALS / GRAPH FIDELITY -------------------------------------------

test("specials + graph fidelity: nebulae/belts/winConfig + neighbors + nav restore", () => {
  const w1 = richWorld(44);
  const w2 = deserialize(serialize(w1));
  assert.deepEqual(w2.nebulae, w1.nebulae, "nebulae match");
  assert.deepEqual(w2.belts, w1.belts, "belts match");
  assert.deepEqual(w2.winConfig, w1.winConfig, "winConfig match");
  assert.deepEqual(w2.links, w1.links, "links match");
  // Neighbor graph must match per body (so routing is identical).
  for (let i = 0; i < w1.asteroids.length; i++) {
    assert.deepEqual(
      w2.asteroids[i].neighbors,
      w1.asteroids[i].neighbors,
      `neighbors[${i}] mismatch`,
    );
  }
  // nav rebuilt + functional: same first-hop table.
  assert.ok(Array.isArray(w2.nav), "nav rebuilt");
  for (let s = 0; s < w1.nav.length; s++) {
    assert.deepEqual(
      Array.from(w2.nav[s]),
      Array.from(w1.nav[s]),
      `nav[${s}] mismatch`,
    );
  }
  // Derived state correctly reset.
  assert.equal(w2._blackholes, null, "_blackholes memo reset to null");
  assert.equal(w2.events.n, 0, "event channel reinitialized empty");
});

// --- 7. SoA SHAPE GUARD -----------------------------------------------------
// serialize/deserialize walk SEED_FIELDS; makeSeedArrays defines the actual SoA. If a future
// field is added to one but not the other, serialize would silently drop it (a resume-desync
// class of bug). Assert the two can't drift.
test("SEED_FIELDS exactly matches makeSeedArrays' typed-array fields", () => {
  const sa = makeSeedArrays(1);
  const typedKeys = Object.keys(sa).filter((k) => ArrayBuffer.isView(sa[k]));
  assert.deepEqual(
    [...SEED_FIELDS].sort(),
    typedKeys.sort(),
    "SEED_FIELDS drifted from makeSeedArrays — update both together",
  );
});
