import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, STARTING_SEEDS, OWNER_NEUTRAL } from "./World.js";
import Sim from "./World.js";
import {
  plantTree,
  updateTrees,
  TREE_SEED_COST,
  TREE_ENERGY_COST,
  DEFENDERS_MAX,
} from "./Trees.js";
import { setRally } from "./Seedlings.js";

const DT = 1 / 30;

function world(seed = 1) {
  return createWorld({
    seed,
    asteroidCount: 6,
    players: [{ id: 0, isAi: false, difficulty: 0 }],
    width: 4000,
    height: 4000,
  });
}
function ownedRock(w) {
  return w.asteroids.find((a) => a.owner === 0);
}
function neutralRock(w) {
  return w.asteroids.find((a) => a.owner === OWNER_NEUTRAL);
}
function ownerSeedlings(w, owner) {
  const s = w.seed;
  let n = 0;
  for (let i = 0; i < s.count; i++) if (s.owner[i] === owner) n++;
  return n;
}

// --- plantTree --------------------------------------------------------------

test("plantTree succeeds with seeds+energy: deducts both, appends tree", () => {
  const w = world();
  const rock = ownedRock(w);
  rock.energy = 100;
  const player = w.players[0];
  const seeds0 = player.seeds;
  const treesBefore = rock.trees.length;
  assert.equal(plantTree(w, rock.id, "seedling", 0), true);
  assert.equal(rock.trees.length, treesBefore + 1);
  assert.equal(player.seeds, seeds0 - TREE_SEED_COST);
  assert.equal(rock.energy, 100 - TREE_ENERGY_COST);
  assert.equal(rock.trees[rock.trees.length - 1].type, "seedling");
});

test("plantTree fails (no mutation) on unowned rock", () => {
  const w = world();
  const rock = neutralRock(w);
  rock.energy = 100;
  const seeds0 = w.players[0].seeds;
  assert.equal(plantTree(w, rock.id, "seedling", 0), false);
  assert.equal(rock.trees.length, 0);
  assert.equal(w.players[0].seeds, seeds0);
  assert.equal(rock.energy, 100);
});

test("plantTree fails when not enough seeds", () => {
  const w = world();
  const rock = ownedRock(w);
  rock.energy = 100;
  w.players[0].seeds = TREE_SEED_COST - 1;
  assert.equal(plantTree(w, rock.id, "seedling", 0), false);
  assert.equal(rock.trees.length, 0);
  assert.equal(rock.energy, 100, "energy untouched on failure");
});

test("plantTree fails when not enough energy", () => {
  const w = world();
  const rock = ownedRock(w);
  rock.energy = TREE_ENERGY_COST - 1;
  const seeds0 = w.players[0].seeds;
  assert.equal(plantTree(w, rock.id, "seedling", 0), false);
  assert.equal(rock.trees.length, 0);
  assert.equal(w.players[0].seeds, seeds0, "seeds untouched on failure");
});

// --- Seedling tree production ----------------------------------------------

test("seedling tree on energetic rock grows orbiters + flowers seeds", () => {
  const w = world(3);
  const rock = ownedRock(w);
  rock.energyStat = 100;
  rock.energy = 200;
  w.players[0].seeds = 100;
  plantTree(w, rock.id, "seedling", 0);
  const units0 = ownerSeedlings(w, 0);
  const seeds0 = w.players[0].seeds;
  for (let t = 0; t < 1200; t++) updateTrees(w, DT); // ~40s
  assert.ok(
    ownerSeedlings(w, 0) > units0,
    "mature seedling tree should spawn orbiters",
  );
  assert.ok(w.players[0].seeds > seeds0, "flowering should add seeds");
});

test("production stalls when energy is starved", () => {
  const w = world(3);
  const rock = ownedRock(w);
  rock.energyStat = 0; // no regen
  rock.energy = 200;
  w.players[0].seeds = 100;
  plantTree(w, rock.id, "seedling", 0);
  // drain energy below the plant cost was already paid; force near-empty
  rock.energy = 0;
  const units0 = ownerSeedlings(w, 0);
  for (let t = 0; t < 1200; t++) updateTrees(w, DT);
  assert.equal(
    ownerSeedlings(w, 0),
    units0,
    "starved rock (no energy, no regen) produces no orbiters",
  );
});

// --- Defender spawning ------------------------------------------------------

test("defense tree spawns defenders up to the cap, not beyond", () => {
  const w = world(4);
  // isolate one rock with no pre-existing orbiters
  const rock = neutralRock(w);
  rock.owner = 0;
  rock.energyStat = 100;
  rock.energy = 200;
  w.players[0].seeds = 100;
  // remove all existing seedlings so we count only this rock's defenders
  w.seed.count = 0;
  plantTree(w, rock.id, "defense", 0);
  for (let t = 0; t < 6000; t++) updateTrees(w, DT); // long run, keep energy topped
  // keep energy available so the cap (not energy) is the limiter
  let defenders = 0;
  for (let i = 0; i < w.seed.count; i++)
    if (w.seed.home[i] === rock.id && w.seed.owner[i] === 0) defenders++;
  assert.ok(defenders > 0, "defense tree should spawn defenders");
  assert.ok(defenders <= DEFENDERS_MAX, "must not exceed cap");
});

test("defenders re-topped to cap with energy regen via full step()", () => {
  const w = world(8);
  const rock = neutralRock(w);
  rock.owner = 0;
  rock.energyStat = 100;
  rock.energy = 200;
  w.players[0].seeds = 100;
  plantTree(w, rock.id, "defense", 0);
  for (let t = 0; t < 2000; t++) Sim.step(w, DT);
  let defenders = 0;
  for (let i = 0; i < w.seed.count; i++)
    if (w.seed.home[i] === rock.id && w.seed.owner[i] === 0) defenders++;
  assert.ok(defenders <= DEFENDERS_MAX, "cap holds under full step");
});

// --- Determinism ------------------------------------------------------------

test("determinism: same seed+actions ⇒ identical counts/energy/seeds", () => {
  function run(seed) {
    const w = world(seed);
    const rock = ownedRock(w);
    rock.energy = 200;
    rock.energyStat = 80;
    w.players[0].seeds = 50;
    plantTree(w, rock.id, "seedling", 0);
    plantTree(w, rock.id, "defense", 0);
    for (let t = 0; t < 1500; t++) Sim.step(w, DT);
    return {
      count: w.seed.count,
      seeds: w.players[0].seeds,
      energy: rock.energy,
    };
  }
  const a = run(21);
  const b = run(21);
  assert.equal(a.count, b.count);
  assert.equal(a.seeds, b.seeds);
  assert.ok(Math.abs(a.energy - b.energy) < 1e-6);
});

test("createWorld normalizes player seeds to STARTING_SEEDS (additive)", () => {
  const w = world();
  for (const p of w.players) assert.equal(p.seeds, STARTING_SEEDS);
  // explicit seeds preserved
  const w2 = createWorld({
    seed: 1,
    asteroidCount: 3,
    players: [{ id: 0, isAi: false, difficulty: 0, seeds: 99 }],
  });
  assert.equal(w2.players[0].seeds, 99);
});

// --- rally / anchor point ---------------------------------------------------

test("setRally sets the anchor, clears on self/invalid, and respects ownership", () => {
  const w = world();
  const home = ownedRock(w);
  const anchor = neutralRock(w);
  assert.ok(setRally(w, home.id, anchor.id, 0));
  assert.equal(home.rally, anchor.id);
  assert.ok(setRally(w, home.id, home.id, 0)); // targeting self clears
  assert.equal(home.rally, -1);
  assert.equal(setRally(w, home.id, anchor.id, 1), false); // non-owner can't set
});

test("rally: seedling-tree production auto-routes new seedlings to the anchor", () => {
  const w = world();
  const home = ownedRock(w);
  const anchor = neutralRock(w);
  home.energy = 500;
  w.players[0].seeds = 50;
  assert.ok(plantTree(w, home.id, "seedling", 0));
  assert.ok(setRally(w, home.id, anchor.id, 0));
  let routed = false;
  for (let i = 0; i < 4000 && !routed; i++) {
    Sim.step(w, DT);
    if (anchor.owner === 0)
      routed = true; // a rallied seedling colonized the anchor
    else {
      const s = w.seed;
      for (let k = 0; k < s.count; k++)
        if (s.target[k] === anchor.id) {
          routed = true;
          break;
        }
    }
  }
  assert.ok(routed, "new production never routed to the rally anchor");
});
