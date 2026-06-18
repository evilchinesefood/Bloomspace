import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, STARTING_SEEDS, OWNER_NEUTRAL, KIND } from "./World.js";
import Sim from "./World.js";
import {
  plantTree,
  updateTrees,
  TREE_SEED_COST,
  TREE_ENERGY_COST,
  DEFENDERS_PER_TREE,
} from "./Trees.js";
import { setRally } from "./Seedlings.js";

const DT = 1 / 30;

function world(seed = 1) {
  return createWorld({
    seed,
    asteroidCount: 14,
    players: [{ id: 0, isAi: false, difficulty: 0 }],
    width: 4000,
    height: 4000,
  });
}
function ownedRock(w) {
  return w.asteroids.find((a) => a.owner === 0);
}
// A neutral, colonizable body: a plain habitable asteroid (skip the non-habitable star/moons).
function neutralRock(w) {
  return w.asteroids.find(
    (a) => a.owner === OWNER_NEUTRAL && a.kind === "asteroid" && !a.moon,
  );
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
  assert.ok(defenders <= DEFENDERS_PER_TREE, "must not exceed cap with 1 tree");
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
  assert.ok(
    defenders <= DEFENDERS_PER_TREE,
    "cap holds under full step (1 tree)",
  );
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

test("rally drains a rock's existing orbiting fighters to the anchor (no tree needed)", () => {
  const w = world();
  const home = ownedRock(w);
  const anchor = neutralRock(w);
  const s = w.seed;
  const orbitingAtHome = () => {
    let n = 0;
    for (let i = 0; i < s.count; i++)
      if (s.owner[i] === 0 && s.home[i] === home.id && s.state[i] === 0) n++;
    return n;
  };
  const before = orbitingAtHome();
  assert.ok(before > 0, "home should start with orbiting seedlings");
  assert.ok(setRally(w, home.id, anchor.id, 0));
  for (let i = 0; i < 600; i++) Sim.step(w, DT);
  assert.equal(
    orbitingAtHome(),
    0,
    "rally never funneled the existing orbiters out",
  );
  assert.equal(
    anchor.owner,
    0,
    "funneled fighters never reached/colonized the anchor",
  );
});

// --- Defender scaling with mature defense trees ---------------------------

test("3 mature defense trees allow up to 18 defenders (DEFENDERS_PER_TREE * 3)", () => {
  const w = world(5);
  const rock = neutralRock(w);
  rock.owner = 0;
  rock.energyStat = 200;
  rock.energy = 9999;
  w.players[0].seeds = 200;
  w.seed.count = 0;
  // Plant 3 defense trees and instantly mature them
  for (let i = 0; i < 3; i++) {
    assert.ok(plantTree(w, rock.id, "defense", 0), `tree ${i} plant failed`);
    rock.trees[rock.trees.length - 1].growth = 1;
  }
  // Run long enough to fill the cap
  for (let t = 0; t < 12000; t++) updateTrees(w, DT);
  let defenders = 0;
  for (let i = 0; i < w.seed.count; i++)
    if (
      w.seed.home[i] === rock.id &&
      w.seed.owner[i] === 0 &&
      w.seed.kind[i] === 1
    )
      defenders++;
  assert.equal(
    defenders,
    DEFENDERS_PER_TREE * 3,
    `expected exactly ${DEFENDERS_PER_TREE * 3} defenders, got ${defenders}`,
  );
});

test("fighters homed to rock do not block defender spawns", () => {
  const w = world(6);
  const rock = neutralRock(w);
  rock.owner = 0;
  rock.energyStat = 200;
  rock.energy = 9999;
  w.players[0].seeds = 100;
  w.seed.count = 0;
  // Stuff rock with fighters (KIND.FIGHTER = 0) well past old flat cap
  for (let i = 0; i < 20; i++)
    Sim.spawnSeedling(w, { home: rock.id, owner: 0, kind: 0 });
  // Plant and mature one defense tree
  assert.ok(plantTree(w, rock.id, "defense", 0));
  rock.trees[rock.trees.length - 1].growth = 1;
  // Run until defenders spawn
  for (let t = 0; t < 6000; t++) updateTrees(w, DT);
  let defenders = 0;
  for (let i = 0; i < w.seed.count; i++)
    if (
      w.seed.home[i] === rock.id &&
      w.seed.owner[i] === 0 &&
      w.seed.kind[i] === 1
    )
      defenders++;
  assert.ok(defenders > 0, "fighters must not block defender spawns");
});

test("energy gates defender spawns even when under cap", () => {
  const w = world(7);
  const rock = neutralRock(w);
  rock.owner = 0;
  rock.energyStat = 0; // no regen
  rock.energy = 200; // enough to plant
  w.players[0].seeds = 100;
  w.seed.count = 0;
  assert.ok(plantTree(w, rock.id, "defense", 0));
  rock.trees[rock.trees.length - 1].growth = 1;
  rock.energy = 0; // drain to empty after planting
  for (let t = 0; t < 6000; t++) updateTrees(w, DT);
  let defenders = 0;
  for (let i = 0; i < w.seed.count; i++)
    if (
      w.seed.home[i] === rock.id &&
      w.seed.owner[i] === 0 &&
      w.seed.kind[i] === 1
    )
      defenders++;
  assert.equal(defenders, 0, "no energy → no defenders");
});

test("immature defense trees do not raise the defender cap", () => {
  const w = world(9);
  const rock = neutralRock(w);
  rock.owner = 0;
  rock.energyStat = 200;
  rock.energy = 9999;
  w.players[0].seeds = 200;
  w.seed.count = 0;
  // Plant 3 defense trees and pin growth to 0 (never matures)
  for (let i = 0; i < 3; i++) {
    assert.ok(plantTree(w, rock.id, "defense", 0));
    rock.trees[rock.trees.length - 1].growth = 0;
  }
  // Run < GROW_TIME (8s) so trees never reach maturity: 100 ticks ≈ 3.3s
  for (let t = 0; t < 100; t++) {
    updateTrees(w, DT);
    // keep all trees pinned at growth 0
    for (const tr of rock.trees) tr.growth = 0;
  }
  let defenders = 0;
  for (let i = 0; i < w.seed.count; i++)
    if (
      w.seed.home[i] === rock.id &&
      w.seed.owner[i] === 0 &&
      w.seed.kind[i] === 1
    )
      defenders++;
  assert.equal(
    defenders,
    0,
    "immature trees contribute 0 to the cap → no defenders spawn",
  );
});

test("rally keeps defenders (kind 1) home while funneling fighters", () => {
  const w = world();
  const home = ownedRock(w);
  const anchor = neutralRock(w);
  const di = Sim.spawnSeedling(w, { home: home.id, owner: 0, kind: 1 });
  assert.ok(di >= 0);
  assert.ok(setRally(w, home.id, anchor.id, 0));
  for (let i = 0; i < 600; i++) Sim.step(w, DT);
  const s = w.seed;
  const defendersHome = () => {
    let n = 0;
    for (let i = 0; i < s.count; i++)
      if (
        s.owner[i] === 0 &&
        s.home[i] === home.id &&
        s.kind[i] === KIND.DEFENDER
      )
        n++;
    return n;
  };
  assert.equal(
    defendersHome(),
    1,
    "rally wrongly funneled the defender away from home",
  );
});
