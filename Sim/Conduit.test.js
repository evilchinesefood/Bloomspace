// Sim/Conduit.test.js — Energy conduits (#10): per-tick capped transfer, sever-on-flip, tryConduit
// validation, default-empty byte-parity, and Save round-trip + validate-drop. RNG-FREE; the
// default-empty paths (updateConduits + the sever filter) must stay no-ops so existing tests don't
// drift — that parity is asserted directly here too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, spawnSeedling, STATE, step } from "./World.js";
import { updateConduits, CONDUIT_RATE, ENERGY_MAX } from "./Economy.js";
import { resolveCombat, HOLD_GAP } from "./Combat.js";
import { tryConduit } from "./MapGen.js";
import { serialize, deserialize } from "./Save.js";

const DT = 1 / 30;

// A bare 3-asteroid, 1-player world. We set ownership/energy directly on rocks (like Combat tests
// poke owner) so the transfer math is fully controlled.
function world(seed = 1) {
  return createWorld({
    seed,
    asteroidCount: 3,
    players: [{ id: 0, isAi: false, difficulty: 0 }],
    width: 4000,
    height: 4000,
  });
}

// Two distinct rocks we both own, with controlled energy + a plain (cap = ENERGY_MAX) profile.
function twoOwned(w, fromE = 100, toE = 0) {
  const from = w.asteroids[0];
  const to = w.asteroids[1];
  for (const r of [from, to]) {
    r.owner = 0;
    r.dead = false;
    r.energyMult = 1;
    r.special = undefined;
  }
  from.energy = fromE;
  to.energy = toE;
  return { from, to };
}

// --- 1. Per-tick capped transfer --------------------------------------------

test("conduit moves energy from→to, capped at CONDUIT_RATE*dt per tick", () => {
  const w = world();
  const { from, to } = twoOwned(w, 100, 0);
  assert.ok(tryConduit(w, 0, 1, 0), "conduit built");
  updateConduits(w, DT);
  const moved = CONDUIT_RATE * DT;
  assert.ok(
    Math.abs(from.energy - (100 - moved)) < 1e-6,
    "from drained by exactly one tick",
  );
  assert.ok(Math.abs(to.energy - moved) < 1e-6, "to gained exactly one tick");
});

test("conduit transfer is conservative (no energy created/destroyed)", () => {
  const w = world();
  const { from, to } = twoOwned(w, 80, 17);
  tryConduit(w, 0, 1, 0);
  for (let t = 0; t < 50; t++) updateConduits(w, DT);
  assert.ok(Math.abs(from.energy + to.energy - 97) < 1e-6, "sum preserved");
  assert.ok(from.energy >= 0, "from never negative");
});

test("conduit never overfills `to` past its cap", () => {
  const w = world();
  // Headroom (0.1) smaller than one tick's transfer (CONDUIT_RATE*DT = 0.4) + a huge source, so
  // the per-tick cap clamp — not the source — is the binding constraint and `to` fills to cap.
  const { to } = twoOwned(w, 100000, ENERGY_MAX - 0.1);
  tryConduit(w, 0, 1, 0);
  updateConduits(w, DT);
  assert.ok(to.energy <= ENERGY_MAX + 1e-6, "to capped at ENERGY_MAX");
  assert.ok(
    Math.abs(to.energy - ENERGY_MAX) < 1e-6,
    "to filled exactly to cap",
  );
});

test("conduit never drains `from` below 0", () => {
  const w = world();
  const { from, to } = twoOwned(w, 0.1, 0); // less than one tick's worth available
  tryConduit(w, 0, 1, 0);
  updateConduits(w, DT);
  assert.ok(from.energy >= 0, "from clamped at 0");
  assert.ok(Math.abs(to.energy - 0.1) < 1e-6, "only what was available moved");
});

test("conduit with a non-owned endpoint does NOT transfer (inert)", () => {
  const w = world();
  const { from, to } = twoOwned(w, 100, 0);
  tryConduit(w, 0, 1, 0);
  to.owner = 1; // endpoint flipped to an enemy after the conduit was built
  const e0from = from.energy;
  const e0to = to.energy;
  updateConduits(w, DT);
  assert.equal(from.energy, e0from, "from unchanged");
  assert.equal(to.energy, e0to, "to unchanged");
});

test("a dead endpoint makes the conduit inert", () => {
  const w = world();
  const { from, to } = twoOwned(w, 100, 0);
  tryConduit(w, 0, 1, 0);
  to.dead = true;
  const e0from = from.energy;
  updateConduits(w, DT);
  assert.equal(from.energy, e0from, "no transfer through a dead endpoint");
});

// --- 2. Sever on owner flip --------------------------------------------------

test("sever: a conduit whose endpoint is captured is removed after the flip", () => {
  const w = world();
  // Own both rocks; rock 1 is held by owner 0 but undefended, and we drive owner 1 to capture it.
  const from = w.asteroids[0];
  const cap = w.asteroids[1];
  from.owner = 0;
  cap.owner = 0;
  tryConduit(w, 0, 1, 0);
  assert.equal(w.conduits.length, 1, "conduit built");
  // Put a single owner-1 attacker inside rock 1's hold-zone, no owner-0 defenders → flip to 1.
  const i = spawnSeedling(w, { home: 1, owner: 1, strength: 50, energy: 100 });
  const s = w.seed;
  s.x[i] = cap.x + cap.radius + HOLD_GAP - 5;
  s.y[i] = cap.y;
  s.px[i] = s.x[i];
  s.py[i] = s.y[i];
  s.state[i] = STATE.ORBIT;
  resolveCombat(w, DT);
  assert.equal(cap.owner, 1, "rock 1 flipped to owner 1");
  assert.equal(w.conduits.length, 0, "conduit severed on the flip");
});

// --- 3. tryConduit validation -----------------------------------------------

test("tryConduit rejects non-owned, same, duplicate, and dead endpoints", () => {
  const w = world();
  twoOwned(w, 100, 0);
  // same endpoint
  assert.equal(tryConduit(w, 0, 0, 0), false, "from===to rejected");
  // not owned by the builder
  w.asteroids[1].owner = 1;
  assert.equal(
    tryConduit(w, 0, 1, 0),
    false,
    "to not owned by builder rejected",
  );
  w.asteroids[1].owner = 0;
  // a dead endpoint
  w.asteroids[1].dead = true;
  assert.equal(tryConduit(w, 0, 1, 0), false, "dead endpoint rejected");
  w.asteroids[1].dead = false;
  // valid build, then a duplicate of the same direction
  assert.equal(tryConduit(w, 0, 1, 0), true, "valid conduit built");
  assert.equal(
    tryConduit(w, 0, 1, 0),
    false,
    "duplicate (same from,to) rejected",
  );
  // reverse direction is a DISTINCT conduit (allowed)
  assert.equal(tryConduit(w, 1, 0, 0), true, "reverse direction allowed");
  // out-of-range / missing endpoint
  assert.equal(tryConduit(w, 0, 99, 0), false, "missing endpoint rejected");
});

// --- 4. Default-empty byte-parity -------------------------------------------

test("default world has empty conduits; updateConduits is a no-op", () => {
  const w = world();
  assert.deepEqual(w.conduits, [], "createWorld initializes conduits = []");
  const before = w.asteroids.map((a) => a.energy);
  updateConduits(w, DT);
  assert.deepEqual(
    w.asteroids.map((a) => a.energy),
    before,
    "no conduits → no energy moves",
  );
});

test("with no conduits, step() leaves world.conduits empty (sever is a no-op)", () => {
  const w = world();
  for (let t = 0; t < 30; t++) step(w, DT);
  assert.deepEqual(w.conduits, [], "no conduit ever appears from a normal run");
});

// --- 5. Save round-trip + validate-on-restore -------------------------------

test("conduits survive serialize → deserialize", () => {
  const w = world();
  twoOwned(w, 100, 0);
  tryConduit(w, 0, 1, 0);
  const w2 = deserialize(JSON.parse(JSON.stringify(serialize(w))));
  assert.ok(w2, "deserialize produced a world");
  assert.deepEqual(w2.conduits, w.conduits, "conduits round-trip deep-equal");
});

test("a v2 save lacking conduits restores [] (additive, no version bump)", () => {
  const w = world();
  const saved = serialize(w);
  delete saved.conduits; // simulate a save written before conduits existed
  const w2 = deserialize(saved);
  assert.ok(w2, "deserialize produced a world");
  assert.deepEqual(w2.conduits, [], "missing conduits → []");
});

test("validate-on-restore drops malformed conduits, keeps valid, never throws", () => {
  const w = world();
  twoOwned(w, 100, 0);
  tryConduit(w, 0, 1, 0);
  const saved = serialize(w);
  const nAst = w.asteroids.length;
  const nPly = w.players.length;
  const valid = { from: 0, to: 1, owner: 0 };
  saved.conduits = [
    valid,
    { from: 0, to: 0, owner: 0 }, // from===to
    { from: nAst, to: 0, owner: 0 }, // from out of range
    { from: 0, to: nAst, owner: 0 }, // to out of range
    { from: 0, to: 1, owner: nPly }, // owner out of range
    { from: 0, to: 1, owner: -1 }, // negative owner
    { from: 1.5, to: 0, owner: 0 }, // non-integer id
    null, // null entry
    42, // primitive
  ];
  let w2;
  assert.doesNotThrow(() => {
    w2 = deserialize(saved);
  }, "deserialize never throws on malformed conduits");
  assert.equal(w2.conduits.length, 1, "only the one valid conduit kept");
  assert.deepEqual(w2.conduits[0], valid, "valid conduit preserved intact");
});
