// Sim/Specials.test.js — Feature 7a terrain specials (RESOURCE-RICH + NEBULA).
// Gated behind config.specials (default OFF) so the existing tests don't drift. Covers:
// deterministic generation, OFF=no-drift (same base layout), the rich economy/flower effect,
// the nebula transit slowdown, and invariants under specials.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, STATE } from "./World.js";
import { updateEconomy } from "./Economy.js";
import {
  updateTrees,
  plantTree,
  FLOWER_SEEDS,
  FLOWER_INTERVAL,
} from "./Trees.js";
import { updateSeedlings } from "./Seedlings.js";
import { RICH_ENERGY_MULT, RICH_SEED_BONUS, NEBULA_SLOW } from "./MapGen.js";

const DT = 1 / 30;
const PLAYERS = [
  { id: 0, isAi: false, difficulty: 0 },
  { id: 1, isAi: true, difficulty: 1 },
];

function mk(seed, specials, count = 26) {
  return createWorld({
    seed,
    asteroidCount: count,
    players: PLAYERS.map((p) => ({ ...p })),
    width: 2000,
    height: 2000,
    specials,
  });
}

const richIds = (w) =>
  w.asteroids.filter((a) => a.special === "rich").map((a) => a.id);

// --- 1. Deterministic generation ------------------------------------------------------------
test("same seed + specials:true ⇒ identical rich set and identical nebulae", () => {
  const a = mk(1234, true);
  const b = mk(1234, true);
  assert.deepEqual(richIds(a), richIds(b), "rich set must be deterministic");
  assert.deepEqual(a.nebulae, b.nebulae, "nebulae must be deterministic");
  assert.ok(a.nebulae.length >= 1, "at least one nebula generated");
});

test("a different seed produces a different specials layout", () => {
  const a = mk(1234, true);
  const c = mk(9999, true);
  const differ =
    JSON.stringify(richIds(a)) !== JSON.stringify(richIds(c)) ||
    JSON.stringify(a.nebulae) !== JSON.stringify(c.nebulae);
  assert.ok(differ, "rich set or nebulae should differ across seeds");
});

test("nebula entries are plain {x,y,radius} numbers (JSON-serializable for save/resume)", () => {
  const w = mk(1234, true);
  for (const z of w.nebulae) {
    assert.equal(Object.keys(z).sort().join(","), "radius,x,y");
    for (const k of ["x", "y", "radius"]) {
      assert.equal(typeof z[k], "number");
      assert.ok(Number.isFinite(z[k]));
    }
  }
  // round-trips cleanly
  assert.deepEqual(JSON.parse(JSON.stringify(w.nebulae)), w.nebulae);
});

// --- 2. Default OFF = no drift; specials only ADD -------------------------------------------
test("specials OFF (default): no rich rocks, empty nebulae", () => {
  const off = mk(1234, false);
  assert.equal(richIds(off).length, 0, "no rich rocks when off");
  assert.deepEqual(off.nebulae, [], "nebulae empty when off");
  const dflt = createWorld({
    seed: 1234,
    asteroidCount: 26,
    players: PLAYERS.map((p) => ({ ...p })),
    width: 2000,
    height: 2000,
  });
  assert.equal(richIds(dflt).length, 0, "omitting specials = off");
  assert.deepEqual(dflt.nebulae, []);
});

test("specials ON shares the EXACT base layout of specials OFF for the same seed", () => {
  // Specials are tagged at the END, drawing rng only then ⇒ positions/stats/homes/seedlings
  // must be byte-identical between an ON world and an OFF world of the same seed.
  const off = mk(4242, false);
  const on = mk(4242, true);
  assert.equal(off.asteroids.length, on.asteroids.length);
  for (let i = 0; i < off.asteroids.length; i++) {
    const a = off.asteroids[i];
    const b = on.asteroids[i];
    for (const f of [
      "id",
      "x",
      "y",
      "radius",
      "owner",
      "energy",
      "energyStat",
      "strengthStat",
      "speedStat",
      "energyMult",
      "kind",
      "habitable",
      "moon",
      "binary",
      "binarySecondary",
      "seed",
    ]) {
      assert.equal(a[f], b[f], `body ${i} field ${f} drifted with specials on`);
    }
    assert.deepEqual(a.neighbors, b.neighbors, `body ${i} neighbors drifted`);
  }
  // Seedlings (homes seeded identically) — same count + positions.
  assert.equal(off.seed.count, on.seed.count, "seedling count drifted");
  for (let i = 0; i < off.seed.count; i++) {
    assert.equal(off.seed.x[i], on.seed.x[i]);
    assert.equal(off.seed.y[i], on.seed.y[i]);
    assert.equal(off.seed.home[i], on.seed.home[i]);
    assert.equal(off.seed.owner[i], on.seed.owner[i]);
  }
});

// --- 3. Resource-rich effect ----------------------------------------------------------------
test("rich owned rock regenerates ≈RICH_ENERGY_MULT× faster than a non-rich twin", () => {
  const w = mk(1234, true);
  // Two identical owned rocks (same energyStat, no planet mult), one tagged rich.
  const base = {
    owner: 0,
    energy: 0,
    energyStat: 100,
    energyMult: 1,
    dead: false,
  };
  const plain = { ...base };
  const rich = { ...base, special: "rich" };
  w.asteroids.push(plain, rich);
  for (let t = 0; t < 30; t++) updateEconomy(w, DT); // stay below the cap
  assert.ok(plain.energy > 0 && rich.energy > 0);
  const ratio = rich.energy / plain.energy;
  assert.ok(
    Math.abs(ratio - RICH_ENERGY_MULT) < 1e-6,
    `expected ratio ≈ ${RICH_ENERGY_MULT}, got ${ratio}`,
  );
});

test("rich rock's flower yields FLOWER_SEEDS + RICH_SEED_BONUS; plain yields FLOWER_SEEDS", () => {
  function flowerOnce(special) {
    const w = mk(1234, true);
    const rock = w.asteroids.find((a) => a.owner === 0);
    if (special) rock.special = "rich";
    else delete rock.special;
    rock.energy = 0; // no produce spend; isolate the flower path
    rock.trees = [
      {
        type: "seedling",
        level: 1,
        growth: 1,
        cooldown: 999,
        flowerCd: 0.0001,
      },
    ];
    const player = w.players.find((p) => p.id === 0);
    const before = player.seeds;
    updateTrees(w, DT); // crosses flowerCd → one payout
    return player.seeds - before;
  }
  assert.equal(flowerOnce(true), FLOWER_SEEDS + RICH_SEED_BONUS);
  assert.equal(flowerOnce(false), FLOWER_SEEDS);
  void plantTree;
  void FLOWER_INTERVAL;
});

// --- 4. Nebula effect -----------------------------------------------------------------------
test("a seedling transiting through a nebula covers less ground than with no nebula", () => {
  // Controlled straight-line transit. One owned home, one neutral target placed far to the
  // right; a nebula straddling the path. Compare distance covered over N ticks with vs without
  // the nebula (same world otherwise).
  function run(withNebula) {
    const w = mk(777, true);
    const s = w.seed;
    // Anchor a clean two-body line: home at (200,1000), target at (1800,1000).
    const home = w.asteroids[0];
    const target = w.asteroids[1];
    home.x = 200;
    home.y = 1000;
    home.radius = 30;
    home.speedStat = 50; // neutral speedFactor across both runs
    target.x = 1800;
    target.y = 1000;
    target.radius = 30;
    target.owner = -1;
    home.owner = 0;
    // Direct nav hop home→target so the ship flies straight.
    w.nebulae = withNebula ? [{ x: 1000, y: 1000, radius: 300 }] : [];
    // Spawn one ship orbiting home, then launch straight at target by hand.
    s.count = 0;
    const i = 0;
    s.count = 1;
    s.home[i] = home.id;
    s.owner[i] = 0;
    s.state[i] = STATE.TRANSIT;
    s.target[i] = target.id;
    s.dest[i] = target.id;
    s.x[i] = home.x;
    s.y[i] = home.y;
    s.energy[i] = 50;
    s.strength[i] = 50;
    let ticks = 0;
    while (s.state[i] === STATE.TRANSIT && ticks < 5000) {
      updateSeedlings(w, DT);
      ticks++;
    }
    return ticks;
  }
  const clear = run(false);
  const fogged = run(true);
  assert.ok(
    fogged > clear,
    `nebula transit should take MORE ticks (clear=${clear}, fogged=${fogged})`,
  );
});

test("nebulaSlow factor matches NEBULA_SLOW (sanity on the constant)", () => {
  assert.ok(
    NEBULA_SLOW > 0 && NEBULA_SLOW < 1,
    "nebula slow must be a slowdown",
  );
});

// --- 5. Invariants under specials -----------------------------------------------------------
test("with specials:true, id===index and graph connectivity still hold", () => {
  for (const seed of [1, 42, 1337, 9001]) {
    const w = mk(seed, true);
    assert.ok(
      w.asteroids.every((a, i) => a.id === i),
      `id===index broke for seed ${seed}`,
    );
    // BFS from body 0 reaches every body (connected travel graph).
    const n = w.asteroids.length;
    const seen = new Uint8Array(n);
    const q = [0];
    seen[0] = 1;
    let qi = 0;
    while (qi < q.length) {
      for (const nb of w.asteroids[q[qi++]].neighbors) {
        if (!seen[nb]) {
          seen[nb] = 1;
          q.push(nb);
        }
      }
    }
    assert.equal(
      seen.reduce((a, b) => a + b, 0),
      n,
      `graph not fully connected for seed ${seed}`,
    );
  }
});
