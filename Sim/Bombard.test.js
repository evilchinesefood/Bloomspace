// Sim/Bombard.test.js — Feature 6a: Bombardment Battery (SIM CORE + AI). Test-first.
// Covers battery arming, fireBombard validation, charge→resolve, dead-body destruction
// correctness, the id===index invariant after a destroy, black-hole cache invalidation,
// self-target, every-system-skips-dead, deterministic AI arm+fire, and no-drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, OWNER_NEUTRAL, EVENT, STATE } from "./World.js";
import Sim from "./World.js";
import {
  plantTree,
  updateTrees,
  countBombard,
  matureBombardCount,
} from "./Trees.js";
import { addConnection } from "./MapGen.js";
import { updateAi } from "./Ai.js";
import { updateEconomy } from "./Economy.js";
import {
  fireBombard,
  updateBombard,
  destroyBody,
  isArmed,
  BATTERY_SIZE,
  CHARGE_TICKS,
  BOMBARD_SEED_COST,
  BOMBARD_ENERGY_COST,
} from "./Bombard.js";

const DT = 1 / 30;

// The AI's slice of a tick WITHOUT checkVictory — lets a controller test run past the point a
// real game would latch terminal (and stop the AI). Mirrors step()'s order for the systems the
// bombard program depends on: AI decisions, energy regen, tree growth, then battery charges.
function aiTick(w) {
  updateAi(w, DT);
  updateEconomy(w, DT);
  updateTrees(w, DT);
  updateBombard(w, DT);
}

function world(seed = 1) {
  return createWorld({
    seed,
    asteroidCount: 16,
    players: [{ id: 0, isAi: false, difficulty: 0 }],
    width: 4000,
    height: 4000,
  });
}
function ownedRock(w) {
  return w.asteroids.find((a) => a.owner === 0);
}
function neutralRock(w) {
  return w.asteroids.find(
    (a) => a.owner === OWNER_NEUTRAL && a.kind === "asteroid" && !a.moon,
  );
}
function liveSeedlings(w) {
  return w.seed.count;
}
// Plant a full battery of mature bombard trees on `rock`, paying with topped-up resources.
function armBattery(w, rock, player) {
  rock.energy = 2000;
  player.seeds = 2000;
  for (let k = 0; k < BATTERY_SIZE; k++) {
    rock.energy = 2000;
    player.seeds = 2000;
    assert.equal(
      plantTree(w, rock.id, "bombard", player.id),
      true,
      `bombard tree ${k} should plant`,
    );
  }
  // mature them all
  for (const t of rock.trees) t.growth = 1;
}
function countEvents(w, type) {
  let n = 0;
  for (let i = 0; i < w.events.n; i++) if (w.events.type[i] === type) n++;
  return n;
}

// --- 1. Battery arming -------------------------------------------------------

test("battery needs 5 MATURE bombard trees to arm; 4 mature + 1 immature → not armed", () => {
  const w = world();
  const rock = ownedRock(w);
  const p = w.players[0];
  rock.energy = 2000;
  p.seeds = 2000;
  for (let k = 0; k < BATTERY_SIZE; k++) {
    rock.energy = 2000;
    p.seeds = 2000;
    assert.equal(plantTree(w, rock.id, "bombard", 0), true);
  }
  assert.equal(countBombard(rock), BATTERY_SIZE);
  // none mature yet
  assert.equal(matureBombardCount(rock), 0);
  assert.equal(isArmed(rock), false);
  // mature only four
  const bombs = rock.trees.filter((t) => t.type === "bombard");
  for (let k = 0; k < 4; k++) bombs[k].growth = 1;
  assert.equal(matureBombardCount(rock), 4);
  assert.equal(isArmed(rock), false, "4 mature + 1 immature must NOT arm");
  // mature the fifth
  bombs[4].growth = 1;
  assert.equal(matureBombardCount(rock), 5);
  assert.equal(isArmed(rock), true);
});

test("escalating plant cost charged correctly per bombard tree", () => {
  const w = world(2);
  const rock = ownedRock(w);
  const p = w.players[0];
  for (let k = 0; k < BATTERY_SIZE; k++) {
    rock.energy = 1000;
    p.seeds = 1000;
    const seeds0 = p.seeds;
    const energy0 = rock.energy;
    assert.equal(plantTree(w, rock.id, "bombard", 0), true);
    assert.equal(
      p.seeds,
      seeds0 - BOMBARD_SEED_COST[k],
      `seed cost for tree ${k}`,
    );
    assert.equal(
      rock.energy,
      energy0 - BOMBARD_ENERGY_COST[k],
      `energy cost for tree ${k}`,
    );
  }
});

test("a 6th bombard tree is rejected (battery is full)", () => {
  const w = world(3);
  const rock = ownedRock(w);
  const p = w.players[0];
  for (let k = 0; k < BATTERY_SIZE; k++) {
    rock.energy = 2000;
    p.seeds = 2000;
    assert.equal(plantTree(w, rock.id, "bombard", 0), true);
  }
  rock.energy = 2000;
  p.seeds = 2000;
  const seeds0 = p.seeds;
  const energy0 = rock.energy;
  assert.equal(plantTree(w, rock.id, "bombard", 0), false, "6th rejected");
  assert.equal(countBombard(rock), BATTERY_SIZE);
  assert.equal(p.seeds, seeds0, "no seed spend on rejected plant");
  assert.equal(rock.energy, energy0, "no energy spend on rejected plant");
});

test("bombard trees never produce orbiters or flower (only grow)", () => {
  const w = world(4);
  const rock = neutralRock(w);
  rock.owner = 0;
  rock.energyStat = 100;
  rock.energy = 2000;
  w.players[0].seeds = 2000;
  w.seed.count = 0; // isolate
  const p = w.players[0];
  for (let k = 0; k < BATTERY_SIZE; k++) {
    rock.energy = 2000;
    p.seeds = 2000;
    plantTree(w, rock.id, "bombard", 0);
  }
  const seeds0 = w.players[0].seeds;
  for (let t = 0; t < 2000; t++) updateTrees(w, DT);
  assert.equal(w.seed.count, 0, "bombard trees must not spawn orbiters");
  assert.equal(
    w.players[0].seeds,
    seeds0,
    "bombard trees must not flower seeds",
  );
  // but they DID mature
  assert.equal(matureBombardCount(rock), BATTERY_SIZE);
  assert.equal(isArmed(rock), true);
});

// --- 2. fireBombard validation ----------------------------------------------

test("fireBombard rejects: not owned / not armed / target missing / already charging", () => {
  const w = world(5);
  const rock = ownedRock(w);
  const p = w.players[0];
  const target = neutralRock(w);
  // not armed yet
  assert.equal(fireBombard(w, rock.id, target.id, 0), false, "not armed");
  armBattery(w, rock, p);
  // wrong owner
  assert.equal(
    fireBombard(w, rock.id, target.id, 1),
    false,
    "owner mismatch rejected",
  );
  // target missing
  assert.equal(
    fireBombard(w, rock.id, 9999, 0),
    false,
    "missing target rejected",
  );
  // valid fire
  assert.equal(fireBombard(w, rock.id, target.id, 0), true);
  assert.ok(rock.bombard, "rock.bombard set after fire");
  // already charging
  assert.equal(
    fireBombard(w, rock.id, target.id, 0),
    false,
    "already charging rejected",
  );
});

test("fireBombard on success sets rock.bombard and emits EVENT.FIRE with target coords", () => {
  const w = world(6);
  const rock = ownedRock(w);
  const p = w.players[0];
  const target = neutralRock(w);
  armBattery(w, rock, p);
  w.events.n = 0;
  assert.equal(fireBombard(w, rock.id, target.id, 0), true);
  assert.deepEqual(rock.bombard, { target: target.id, charge: CHARGE_TICKS });
  assert.equal(countEvents(w, EVENT.FIRE), 1, "one FIRE event emitted");
  // verify the FIRE event carries battery pos + target pos + owner. The events SoA is Float32,
  // so positions round-trip through 32-bit precision — compare within a small tolerance.
  const near = (a, b) => Math.abs(a - b) < 1e-2;
  let found = false;
  for (let i = 0; i < w.events.n; i++) {
    if (w.events.type[i] === EVENT.FIRE) {
      assert.ok(near(w.events.x[i], rock.x));
      assert.ok(near(w.events.y[i], rock.y));
      assert.ok(near(w.events.x2[i], target.x));
      assert.ok(near(w.events.y2[i], target.y));
      assert.equal(w.events.owner[i], 0);
      found = true;
    }
  }
  assert.ok(found);
});

test("fireBombard rejects firing at an already-dead body and does not mutate", () => {
  const w = world(7);
  const rock = ownedRock(w);
  const p = w.players[0];
  const target = neutralRock(w);
  armBattery(w, rock, p);
  destroyBody(w, target.id);
  assert.equal(
    fireBombard(w, rock.id, target.id, 0),
    false,
    "dead target rejected",
  );
  assert.equal(rock.bombard, undefined, "no charge started");
});

// --- 3. Charge → resolve -----------------------------------------------------

test("after CHARGE_TICKS the target is destroyed, trees consumed, bombard cleared", () => {
  const w = world(8);
  const rock = ownedRock(w);
  const p = w.players[0];
  const target = neutralRock(w);
  armBattery(w, rock, p);
  // add a non-bombard tree so we can confirm only bombard trees are consumed
  rock.energy = 2000;
  p.seeds = 2000;
  plantTree(w, rock.id, "seedling", 0);
  const totalTrees0 = rock.trees.length;
  assert.equal(countBombard(rock), BATTERY_SIZE);
  assert.equal(fireBombard(w, rock.id, target.id, 0), true);
  for (let t = 0; t < CHARGE_TICKS; t++) updateBombard(w, DT);
  assert.equal(target.dead, true, "target destroyed at resolve");
  assert.equal(rock.bombard, undefined, "bombard cleared");
  assert.equal(countBombard(rock), 0, "5 bombard trees consumed");
  assert.equal(
    rock.trees.length,
    totalTrees0 - BATTERY_SIZE,
    "only the 5 bombard trees removed; other trees survive",
  );
});

test("resolve via full step() destroys the target", () => {
  const w = world(9);
  const rock = ownedRock(w);
  const p = w.players[0];
  const target = neutralRock(w);
  armBattery(w, rock, p);
  assert.equal(fireBombard(w, rock.id, target.id, 0), true);
  for (let t = 0; t < CHARGE_TICKS + 2; t++) Sim.step(w, DT);
  assert.equal(target.dead, true, "step() drives the charge to resolve");
});

// --- 4. Destruction correctness ---------------------------------------------

test("destroyed body: neutral owner, no trees, no neighbors, removed from links + nav", () => {
  const w = world(10);
  const target = neutralRock(w);
  const tid = target.id;
  // a neighbor of the target (some body that lists tid)
  const neighborOfTarget = w.asteroids.find((a) =>
    (a.neighbors || []).includes(tid),
  );
  assert.ok(neighborOfTarget, "target should have a graph neighbor");
  // world.links holds only MANUAL connections (the procedural graph lives in .neighbors), so
  // add one touching the target to exercise destroyBody's link-removal path.
  const other = w.asteroids.find(
    (a) =>
      a.id !== tid &&
      a.kind === "asteroid" &&
      !a.moon &&
      !a.neighbors.includes(tid),
  );
  addConnection(w, tid, other.id);
  assert.ok(
    w.links.some((e) => e[0] === tid || e[1] === tid),
    "a manual link should touch the target before destroy",
  );
  destroyBody(w, tid);
  assert.equal(target.dead, true);
  assert.equal(target.owner, OWNER_NEUTRAL);
  assert.deepEqual(target.trees, []);
  assert.deepEqual(target.neighbors, []);
  assert.equal(target.rally, -1);
  assert.equal(target.armed, false);
  // removed from every other body's neighbor list
  for (const a of w.asteroids)
    assert.ok(
      !(a.neighbors || []).includes(tid),
      `body ${a.id} still lists dead ${tid}`,
    );
  // removed from world.links
  assert.ok(
    !w.links.some((e) => e[0] === tid || e[1] === tid),
    "links still reference the dead body",
  );
  // nav no longer first-hops INTO tid from anywhere (it was rebuilt)
  for (let s = 0; s < w.asteroids.length; s++) {
    if (s === tid) continue;
    for (let t = 0; t < w.asteroids.length; t++) {
      if (t === tid || t === s) continue;
      assert.notEqual(
        w.nav[s][t],
        tid,
        `nav routes ${s}->${t} through dead ${tid}`,
      );
    }
  }
});

test("destroying a body kills every seedling homed/targeting/dest'd at it (DEATH events)", () => {
  const w = world(11);
  const target = neutralRock(w);
  const tid = target.id;
  target.owner = 0;
  // home several seedlings at the target
  for (let k = 0; k < 5; k++)
    Sim.spawnSeedling(w, { home: tid, owner: 0, orbitAngle: k });
  // and one in transit toward it
  const ti = Sim.spawnSeedling(w, { home: ownedRock(w).id, owner: 0 });
  w.seed.target[ti] = tid;
  w.seed.dest[ti] = tid;
  w.seed.state[ti] = STATE.TRANSIT;
  const before = liveSeedlings(w);
  const homedAtTarget = (() => {
    let n = 0;
    const s = w.seed;
    for (let i = 0; i < s.count; i++)
      if (s.home[i] === tid || s.target[i] === tid || s.dest[i] === tid) n++;
    return n;
  })();
  assert.ok(homedAtTarget >= 6, "set up seedlings tied to the target");
  w.events.n = 0;
  destroyBody(w, tid);
  const after = liveSeedlings(w);
  assert.equal(
    after,
    before - homedAtTarget,
    "all seedlings tied to the dead body are killed",
  );
  assert.equal(
    countEvents(w, EVENT.DEATH),
    homedAtTarget,
    "one DEATH event per killed seedling",
  );
  // no survivor references the dead body
  const s = w.seed;
  for (let i = 0; i < s.count; i++) {
    assert.notEqual(s.home[i], tid);
    assert.notEqual(s.target[i], tid);
    assert.notEqual(s.dest[i], tid);
  }
});

test("destroyBody is idempotent / no-op on an already-dead body", () => {
  const w = world(12);
  const target = neutralRock(w);
  destroyBody(w, target.id);
  const links0 = w.links.length;
  assert.doesNotThrow(() => destroyBody(w, target.id));
  assert.equal(w.links.length, links0, "second destroy changes nothing");
  // bad id is a safe no-op
  assert.doesNotThrow(() => destroyBody(w, 99999));
});

// --- 5. id === index STILL HOLDS after destruction --------------------------

test("id===index invariant survives a bombard destroy (via public fire path)", () => {
  const w = world(13);
  const rock = ownedRock(w);
  const p = w.players[0];
  const target = neutralRock(w);
  armBattery(w, rock, p);
  assert.equal(fireBombard(w, rock.id, target.id, 0), true);
  for (let t = 0; t < CHARGE_TICKS + 2; t++) Sim.step(w, DT);
  assert.equal(target.dead, true);
  assert.ok(
    w.asteroids.every((a, i) => a.id === i),
    "id===index broke after a bombard destroy",
  );
  // every surviving seedling still indexes a real body
  const s = w.seed;
  for (let i = 0; i < s.count; i++) {
    assert.ok(s.home[i] >= 0 && s.home[i] < w.asteroids.length);
    if (s.target[i] >= 0)
      assert.ok(s.target[i] < w.asteroids.length, "target idx valid");
    if (s.dest[i] >= 0)
      assert.ok(s.dest[i] < w.asteroids.length, "dest idx valid");
  }
});

// --- 6. Black-hole cache invalidation ---------------------------------------

test("destroying a black hole stops it reaping ships (cache invalidates)", () => {
  // find a seed whose star is a black hole
  let w = null;
  let hole = null;
  for (let seed = 1; seed < 400 && !hole; seed++) {
    const cand = world(seed);
    const h = cand.asteroids.find((a) => a.kind === "blackhole");
    if (h) {
      w = cand;
      hole = h;
    }
  }
  assert.ok(hole, "found a map with a black hole");
  // A live home rock far from the hole; probes orbit it but we override position to the hole,
  // and freeze them in COMBAT state so updateSeedlings won't move them off the hole this tick.
  const homeRock = ownedRock(w);
  const park = (i) => {
    w.seed.x[i] = hole.x;
    w.seed.y[i] = hole.y;
    w.seed.state[i] = STATE.COMBAT; // frozen in place (Combat reaps deaths, doesn't move)
  };
  // park a ship right inside the hole; one step should reap it (destroyInBlackHoles runs first)
  const probe = Sim.spawnSeedling(w, { home: homeRock.id, owner: 0 });
  park(probe);
  const n0 = w.seed.count;
  Sim.step(w, DT);
  assert.ok(w.seed.count < n0, "live black hole reaps a ship inside it");
  // now destroy the black hole; ships inside it must no longer be reaped
  destroyBody(w, hole.id);
  assert.equal(w._blackholes, null, "cache invalidated by destroyBody");
  const probe2 = Sim.spawnSeedling(w, { home: homeRock.id, owner: 0 });
  park(probe2);
  const n1 = w.seed.count;
  Sim.step(w, DT);
  assert.equal(
    w.seed.count,
    n1,
    "dead black hole must not reap the ship sitting on it",
  );
});

test("destroying a NORMAL body leaves the black hole reaping correctly", () => {
  let w = null;
  let hole = null;
  for (let seed = 1; seed < 400 && !hole; seed++) {
    const cand = world(seed);
    const h = cand.asteroids.find((a) => a.kind === "blackhole");
    if (h) {
      w = cand;
      hole = h;
    }
  }
  assert.ok(hole);
  const normal = neutralRock(w);
  destroyBody(w, normal.id);
  // black hole still reaps
  const probe = Sim.spawnSeedling(w, { home: 0, owner: 0 });
  w.seed.x[probe] = hole.x;
  w.seed.y[probe] = hole.y;
  const n0 = w.seed.count;
  Sim.step(w, DT);
  assert.ok(w.seed.count < n0, "black hole still reaps after a normal destroy");
});

// --- 7. Self-target ----------------------------------------------------------

test("firing a rock at itself destroys it (rock dead, trees gone, ships killed)", () => {
  const w = world(14);
  const rock = ownedRock(w);
  const p = w.players[0];
  armBattery(w, rock, p);
  const rid = rock.id;
  // seedlings homed at the firing rock
  const before = w.seed.count;
  let homedHere = 0;
  for (let i = 0; i < w.seed.count; i++)
    if (w.seed.home[i] === rid) homedHere++;
  assert.ok(homedHere > 0, "firing rock has orbiters to lose");
  assert.equal(fireBombard(w, rid, rid, 0), true, "self-target allowed");
  for (let t = 0; t < CHARGE_TICKS; t++) updateBombard(w, DT);
  assert.equal(rock.dead, true, "self-fire destroys the firing rock");
  assert.deepEqual(rock.trees, [], "its trees are gone");
  assert.equal(rock.bombard, undefined);
  // its ships are dead
  for (let i = 0; i < w.seed.count; i++)
    assert.notEqual(w.seed.home[i], rid, "no survivor homed at the dead rock");
  assert.equal(w.seed.count, before - homedHere);
});

test("guard: if target died before resolve, the firing rock just consumes trees + clears", () => {
  const w = world(15);
  const a = ownedRock(w);
  const p = w.players[0];
  // two batteries: rock A fires at target, then we kill target out from under it
  const target = neutralRock(w);
  armBattery(w, a, p);
  assert.equal(fireBombard(w, a.id, target.id, 0), true);
  // someone else destroys the target mid-charge
  destroyBody(w, target.id);
  assert.equal(target.dead, true);
  for (let t = 0; t < CHARGE_TICKS; t++) updateBombard(w, DT);
  assert.equal(a.bombard, undefined, "charge cleared even though target died");
  assert.equal(countBombard(a), 0, "firing rock still consumes its trees");
  assert.doesNotThrow(() => updateBombard(w, DT));
});

// --- 8. Every system skips dead ---------------------------------------------

test("after a destroy: no energy regen / tree growth / orbit / ownership flip on the dead body", () => {
  const w = world(16);
  const target = neutralRock(w);
  // make it an owned, energetic body with a tree and an orbit, THEN kill it
  target.owner = 0;
  target.energy = 150;
  target.energyStat = 100;
  target.orbiting = true;
  target.orbitParent = -1;
  target.orbitCx = target.x;
  target.orbitCy = target.y;
  target.orbitDist = 40;
  target.orbitAng = 0;
  target.orbitSpeed = 1;
  destroyBody(w, target.id);
  const x0 = target.x;
  const y0 = target.y;
  const e0 = target.energy;
  for (let t = 0; t < 300; t++) Sim.step(w, DT);
  assert.equal(target.dead, true);
  assert.equal(target.energy, e0, "dead body must not regen energy");
  assert.deepEqual(target.trees, [], "dead body grows no trees");
  assert.equal(target.x, x0, "dead body must not orbit");
  assert.equal(target.y, y0);
  assert.equal(target.owner, OWNER_NEUTRAL, "dead body never flips ownership");
});

test("a deterministic multi-step run after a destruction stays stable (no NaN, no throw)", () => {
  const run = (seed) => {
    const w = world(seed);
    const rock = ownedRock(w);
    const p = w.players[0];
    const target = neutralRock(w);
    armBattery(w, rock, p);
    fireBombard(w, rock.id, target.id, 0);
    for (let t = 0; t < CHARGE_TICKS + 500; t++) Sim.step(w, DT);
    const s = w.seed;
    for (let i = 0; i < s.count; i++)
      assert.ok(
        !Number.isNaN(s.x[i]) && !Number.isNaN(s.energy[i]),
        "no NaN after destroy",
      );
    return { count: s.count, owner: w.asteroids.map((a) => a.owner) };
  };
  const a = run(17);
  const b = run(17);
  assert.equal(a.count, b.count);
  assert.deepEqual(a.owner, b.owner);
});

test("AI never targets a dead body as a normal move", () => {
  const w = createWorld({
    seed: 20,
    asteroidCount: 14,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 2 },
    ],
    width: 3000,
    height: 3000,
  });
  // kill a neutral rock, then run the AI a while; the dead body must never be colonized
  const dead = w.asteroids.find(
    (a) => a.owner === OWNER_NEUTRAL && a.kind === "asteroid" && !a.moon,
  );
  destroyBody(w, dead.id);
  for (let t = 0; t < 4000; t++) Sim.step(w, DT);
  assert.equal(dead.dead, true);
  assert.equal(dead.owner, OWNER_NEUTRAL, "AI must never own a dead body");
});

// --- 9. AI arms + fires deterministically -----------------------------------

test("AI on a build difficulty eventually arms a battery and fires (deterministic)", () => {
  // Drive the AI controller + the systems it relies on directly (no checkVictory), so the world
  // never goes terminal mid-test — this isolates the bombard PROGRAM (a faithful unit test of the
  // controller, which `step` would short-circuit once a side is eliminated). Same path the game
  // uses, minus the victory latch. The player-0 target rocks stay live so the AI has a target.
  function run(seed) {
    const w = createWorld({
      seed,
      asteroidCount: 14,
      planetMin: 1,
      planetMax: 2,
      players: [
        { id: 0, isAi: false, difficulty: 0 },
        { id: 1, isAi: true, difficulty: 3 },
      ],
      width: 2600,
      height: 2600,
    });
    // give the AI a few rocks + a healthy economy head start so a battery is affordable in test
    // time (a real fast 1v1 would resolve before a 5-tree battery matures).
    let given = 0;
    for (const a of w.asteroids)
      if (
        a.owner === OWNER_NEUTRAL &&
        a.kind === "asteroid" &&
        !a.moon &&
        given < 3
      ) {
        a.owner = 1;
        given++;
      }
    w.players[1].seeds = 1000;
    for (const a of w.asteroids) if (a.owner === 1) a.energy = 200;
    let fired = false;
    let armedSeen = false;
    for (let t = 0; t < 40000 && !fired; t++) {
      aiTick(w); // the AI's slice of a step, no victory check (defined above)
      for (const a of w.asteroids) {
        if (a.owner === 1 && a.armed) armedSeen = true;
        if (a.owner === 1 && a.bombard) fired = true;
      }
      for (let i = 0; i < w.events.n; i++)
        if (w.events.type[i] === EVENT.FIRE) fired = true;
    }
    return {
      fired,
      armedSeen,
      fireCount: w.players[1]._bombFires | 0,
      player: w.players[1],
    };
  }
  const a = run(31);
  assert.ok(a.armedSeen, "AI should arm a battery given resources + time");
  assert.ok(a.fired, "AI should fire its armed battery");
  const b = run(31);
  assert.equal(a.fired, b.fired, "same-seed AI bombard is deterministic");
  assert.equal(a.armedSeen, b.armedSeen);
  assert.equal(a.fireCount, b.fireCount);

  // Serialization guard (ahead of save/resume): the AI's bombard counters must stay plain
  // numbers that survive a JSON round-trip — catch a future _bomb* field becoming a Set/Map.
  for (const f of [
    "_bombFires",
    "_bombPlants",
    "_bombFireTick",
    "_bombPlanTick",
  ])
    assert.equal(typeof a.player[f], "number", `${f} must be a plain number`);
  const round = JSON.parse(JSON.stringify(a.player));
  assert.equal(round._bombFires, a.player._bombFires, "_bombFires round-trips");
  assert.equal(
    round._bombPlants,
    a.player._bombPlants,
    "_bombPlants round-trips",
  );
});

test("Easy AI never builds a bombard battery", () => {
  const w = createWorld({
    seed: 33,
    asteroidCount: 14,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 0 },
    ],
    width: 2600,
    height: 2600,
  });
  w.players[1].seeds = 500;
  for (const a of w.asteroids) if (a.owner === 1) a.energy = 200;
  for (let t = 0; t < 8000; t++) Sim.step(w, DT);
  for (const a of w.asteroids)
    if (a.owner === 1)
      assert.equal(countBombard(a), 0, "Easy AI must not plant bombard trees");
});

// --- 10. Determinism / no-drift ---------------------------------------------

test("a no-bombard game is bit-identical across two same-seed runs (no drift)", () => {
  function run() {
    const w = createWorld({
      seed: 99,
      asteroidCount: 12,
      players: [
        { id: 0, isAi: false, difficulty: 0 },
        { id: 1, isAi: true, difficulty: 2 },
        { id: 2, isAi: true, difficulty: 1 },
      ],
    });
    for (let t = 0; t < 1500; t++) Sim.step(w, 1 / 30);
    return w;
  }
  const wa = run();
  const wb = run();
  assert.equal(wa.seed.count, wb.seed.count);
  assert.equal(wa.status, wb.status);
  for (let i = 0; i < wa.asteroids.length; i++)
    assert.equal(wa.asteroids[i].owner, wb.asteroids[i].owner);
  for (let i = 0; i < wa.seed.count; i++) {
    assert.equal(wa.seed.owner[i], wb.seed.owner[i]);
    assert.ok(Math.abs(wa.seed.x[i] - wb.seed.x[i]) < 1e-9);
  }
});

// --- A2: DESTROY event from destroyBody -------------------------------------

test("destroyBody emits exactly one EVENT.DESTROY for a moonless target body", () => {
  const w = world(50);
  // pick a moonless rock (no other body has orbitParent === its id) to get exactly 1 DESTROY
  const target = w.asteroids.find(
    (a) =>
      a.owner === OWNER_NEUTRAL &&
      a.kind === "asteroid" &&
      !a.moon &&
      !a.dead &&
      !w.asteroids.some((m) => m.orbitParent === a.id && m.moon && !m.dead),
  );
  assert.ok(target, "moonless neutral rock found");
  w.events.n = 0;
  destroyBody(w, target.id);
  assert.equal(countEvents(w, EVENT.DESTROY), 1, "exactly one DESTROY event");
  // owner is -1 (global, not player-tied)
  let ev = null;
  for (let i = 0; i < w.events.n; i++)
    if (w.events.type[i] === EVENT.DESTROY)
      ev = { x: w.events.x[i], y: w.events.y[i], owner: w.events.owner[i] };
  assert.ok(ev, "DESTROY event found");
  assert.equal(ev.owner, -1, "DESTROY owner is -1 (global)");
});

test("destroyBody on already-dead body emits no extra DESTROY", () => {
  const w = world(51);
  const target = neutralRock(w);
  destroyBody(w, target.id);
  w.events.n = 0;
  destroyBody(w, target.id); // idempotent call
  assert.equal(countEvents(w, EVENT.DESTROY), 0, "no DESTROY on re-destroy");
});

// --- A3: Moon cascade -------------------------------------------------------

test("destroying a planet with moons marks all moons dead and preserves id===index", () => {
  // find a world that has a planet with moons
  let w = null;
  let planet = null;
  for (let seed = 1; seed < 200 && !planet; seed++) {
    const cand = world(seed);
    const p = cand.asteroids.find(
      (a) =>
        !a.dead &&
        !a.moon &&
        a.kind !== "blackhole" &&
        cand.asteroids.some((m) => m.orbitParent === a.id && m.moon && !m.dead),
    );
    if (p) {
      w = cand;
      planet = p;
    }
  }
  assert.ok(planet, "found a planet with at least one moon");
  const moons = w.asteroids.filter(
    (a) => a.orbitParent === planet.id && a.moon && !a.dead,
  );
  assert.ok(moons.length > 0, "planet has live moons");

  w.events.n = 0;
  destroyBody(w, planet.id);

  // planet dead
  assert.equal(planet.dead, true, "planet is dead");
  // all moons dead
  for (const m of moons)
    assert.equal(m.dead, true, `moon ${m.id} should be dead`);
  // id===index invariant preserved
  assert.ok(
    w.asteroids.every((a, i) => a.id === i),
    "id===index broken after cascade",
  );
  // DESTROY emitted for planet + each moon
  assert.equal(
    countEvents(w, EVENT.DESTROY),
    1 + moons.length,
    "DESTROY emitted for planet and each moon",
  );
});

test("cascade: moons of moons are also destroyed recursively", () => {
  // find or construct a world with moon-of-moon if possible; otherwise skip gracefully
  let w = null;
  let moonWithMoon = null;
  for (let seed = 1; seed < 500 && !moonWithMoon; seed++) {
    const cand = world(seed);
    const m = cand.asteroids.find(
      (a) =>
        a.moon &&
        !a.dead &&
        cand.asteroids.some(
          (m2) => m2.orbitParent === a.id && m2.moon && !m2.dead,
        ),
    );
    if (m) {
      w = cand;
      moonWithMoon = m;
    }
  }
  if (!moonWithMoon) return; // no such map found — skip gracefully
  const grandparent = w.asteroids.find(
    (a) => a.id === moonWithMoon.orbitParent,
  );
  assert.ok(grandparent, "grandparent found");
  w.events.n = 0;
  destroyBody(w, grandparent.id);
  assert.equal(grandparent.dead, true);
  assert.equal(
    moonWithMoon.dead,
    true,
    "moon-of-moon's parent destroyed, so it too",
  );
});

test("cascade: binary partner (orbitParent===-1) of destroyed body is NOT destroyed", () => {
  // Find two bodies that form a binary pair: both have orbitParent===-1 and moon===true,
  // and share the same orbit anchor (their ids appear together in the asteroids list near
  // each other with matching orbitParent===-1). We pick one, destroy it, and confirm its
  // counterpart — which would be captured by a moon cascade if orbitParent===-1 weren't
  // excluded — survives.
  let w = null;
  let binaryA = null; // the one we will destroy
  let binaryB = null; // the counterpart that must survive
  for (let seed = 1; seed < 200 && !binaryA; seed++) {
    const cand = world(seed);
    // Both members of a binary pair have orbitParent===-1 and moon===true.
    // Find any two such bodies that share the same parent rock (their common anchor),
    // identified by being adjacent entries or by scanning for two orbitParent===-1 moons.
    const candidates = cand.asteroids.filter(
      (a) => !a.dead && a.orbitParent === -1 && a.moon,
    );
    if (candidates.length >= 2) {
      w = cand;
      binaryA = candidates[0];
      binaryB = candidates[1];
    }
  }
  if (!binaryA) return; // no binary pairs found in these seeds — skip gracefully
  assert.equal(binaryA.orbitParent, -1, "binaryA is a binary partner");
  assert.equal(binaryB.orbitParent, -1, "binaryB is a binary partner");
  // Destroy binaryA — the cascade must NOT pull in binaryB because orbitParent===-1
  // is explicitly excluded from moon cascade logic.
  destroyBody(w, binaryA.id);
  assert.equal(binaryA.dead, true, "binaryA was destroyed");
  assert.equal(
    binaryB.dead,
    undefined,
    "binary counterpart binaryB must NOT be cascade-destroyed",
  );
});

test("cascade: correct number of DESTROY events emitted for planet + moons", () => {
  let w = null;
  let planet = null;
  for (let seed = 1; seed < 200 && !planet; seed++) {
    const cand = world(seed);
    const p = cand.asteroids.find(
      (a) =>
        !a.dead &&
        !a.moon &&
        a.kind !== "blackhole" &&
        cand.asteroids.some((m) => m.orbitParent === a.id && m.moon && !m.dead),
    );
    if (p) {
      w = cand;
      planet = p;
    }
  }
  assert.ok(planet, "found a planet with moons");
  w.events.n = 0;
  destroyBody(w, planet.id);
  const destroyCount = countEvents(w, EVENT.DESTROY);
  const moons = w.asteroids.filter(
    (a) => a.orbitParent === planet.id && a.moon,
  );
  assert.equal(
    destroyCount,
    1 + moons.length,
    "one DESTROY per body (planet + each moon)",
  );
});

test("cascade: seedlings homed at moons are reaped when planet is destroyed", () => {
  let w = null;
  let planet = null;
  for (let seed = 1; seed < 200 && !planet; seed++) {
    const cand = world(seed);
    const p = cand.asteroids.find(
      (a) =>
        !a.dead &&
        !a.moon &&
        a.kind !== "blackhole" &&
        cand.asteroids.some((m) => m.orbitParent === a.id && m.moon && !m.dead),
    );
    if (p) {
      w = cand;
      planet = p;
    }
  }
  assert.ok(planet, "found planet with moons");
  const moons = w.asteroids.filter(
    (a) => a.orbitParent === planet.id && a.moon && !a.dead,
  );
  // spawn seedlings homed at the first moon
  const moon = moons[0];
  moon.owner = 0;
  for (let k = 0; k < 3; k++) Sim.spawnSeedling(w, { home: moon.id, owner: 0 });
  const before = w.seed.count;
  const homedAtMoon = (() => {
    let n = 0;
    for (let i = 0; i < w.seed.count; i++) if (w.seed.home[i] === moon.id) n++;
    return n;
  })();
  assert.ok(homedAtMoon >= 3, "moon has seedlings");
  destroyBody(w, planet.id);
  assert.equal(moon.dead, true, "moon destroyed by cascade");
  assert.ok(w.seed.count < before, "seed count dropped after cascade");
  // seedlings homed at the moon are reaped
  for (let i = 0; i < w.seed.count; i++)
    assert.notEqual(w.seed.home[i], moon.id, "no survivor homed at dead moon");
});
