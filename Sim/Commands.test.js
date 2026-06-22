// Commands.test.js — the deterministic intent seam. Asserts applyCommand dispatches each CMD type
// to the right mutator (via observable world effects + returned result), drainCommands applies a
// staged batch in stable owner-ascending order then clears the list, and an empty/absent list is a
// no-op. Built headlessly like the other Sim tests. queueCommand's byte-parity (it stays immediate)
// is the determinism harness's job — the parity suites cover that.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, OWNER_NEUTRAL, STATE } from "./World.js";
import {
  applyCommand,
  queueCommand,
  drainCommands,
  CMD,
  STAGED,
} from "./Commands.js";

const PLAYERS = [
  { id: 0, isAi: false, difficulty: 0 },
  { id: 1, isAi: true, difficulty: 1 },
];

function mk(seed = 7, count = 24) {
  return createWorld({
    seed,
    asteroidCount: count,
    players: PLAYERS,
    width: 2000,
    height: 2000,
  });
}

// A neutral colonizable body (plain habitable asteroid, not the star/a moon).
function neutralColonizable(w) {
  return w.asteroids.find(
    (a) => a.owner === OWNER_NEUTRAL && a.kind === "asteroid" && !a.moon,
  );
}

function homeOf(w, owner) {
  return w.asteroids.find((a) => a.owner === owner);
}

function orbitersAt(w, rockId, owner) {
  const s = w.seed;
  let n = 0;
  for (let i = 0; i < s.count; i++)
    if (
      s.state[i] === STATE.ORBIT &&
      s.home[i] === rockId &&
      s.owner[i] === owner
    )
      n++;
  return n;
}

test("createWorld initializes an empty pendingCommands list", () => {
  const w = mk();
  assert.deepEqual(w.pendingCommands, []);
});

test("applyCommand SEND dispatches to sendSeedlings (moves orbiters, returns count)", () => {
  const w = mk();
  const home = homeOf(w, 0);
  const neutral = neutralColonizable(w);
  const before = orbitersAt(w, home.id, 0);
  assert.ok(before > 0, "home should start with orbiters");
  const sent = applyCommand(w, {
    type: CMD.SEND,
    from: home.id,
    to: neutral.id,
    fraction: 1,
    owner: 0,
  });
  assert.ok(sent > 0, "SEND returns the count actually launched");
  assert.equal(orbitersAt(w, home.id, 0), before - sent);
});

test("applyCommand RAID dispatches to raidSeedlings (flags raiders raid=1, returns count)", () => {
  const w = mk();
  const home = homeOf(w, 0);
  const neutral = neutralColonizable(w);
  const before = orbitersAt(w, home.id, 0);
  assert.ok(before > 0, "home should start with orbiters");
  const sent = applyCommand(w, {
    type: CMD.RAID,
    from: home.id,
    to: neutral.id,
    fraction: 1,
    owner: 0,
  });
  assert.ok(sent > 0, "RAID returns the count actually launched");
  assert.equal(orbitersAt(w, home.id, 0), before - sent);
  // Launched ships are flagged raiders heading to the neutral target.
  let flagged = 0;
  for (let i = 0; i < w.seed.count; i++)
    if (
      w.seed.state[i] === STATE.TRANSIT &&
      w.seed.dest[i] === neutral.id &&
      w.seed.raid[i] === 1
    )
      flagged++;
  assert.equal(flagged, sent, "every launched raider is flagged raid=1");
});

test("applyCommand RALLY dispatches to setRally (sets anchor, returns true)", () => {
  const w = mk();
  const home = homeOf(w, 0);
  const neutral = neutralColonizable(w);
  const ok = applyCommand(w, {
    type: CMD.RALLY,
    from: home.id,
    to: neutral.id,
    owner: 0,
  });
  assert.equal(ok, true);
  assert.equal(home.rally, neutral.id);
});

test("applyCommand PLANT dispatches to plantTree (adds a tree, returns bool)", () => {
  const w = mk();
  const home = homeOf(w, 0);
  const before = home.trees.length;
  const player = w.players[0];
  player.seeds = 999; // afford the plant
  home.energy = 999;
  const ok = applyCommand(w, {
    type: CMD.PLANT,
    rock: home.id,
    treeType: "seedling",
    owner: 0,
  });
  assert.equal(ok, true);
  assert.equal(home.trees.length, before + 1);
  assert.equal(home.trees[home.trees.length - 1].type, "seedling");
});

test("applyCommand PLANT uses c.treeType, not c.type, for the tree kind", () => {
  const w = mk();
  const home = homeOf(w, 0);
  w.players[0].seeds = 999;
  home.energy = 999;
  applyCommand(w, {
    type: CMD.PLANT,
    rock: home.id,
    treeType: "defense",
    owner: 0,
  });
  // The tree kind comes from treeType ("defense"), never from the CMD.PLANT discriminator.
  assert.equal(home.trees[home.trees.length - 1].type, "defense");
});

test("applyCommand on an unknown type is a no-op returning undefined", () => {
  const w = mk();
  const snapshotTrees = w.asteroids.map((a) => a.trees.length);
  const r = applyCommand(w, { type: "bogus", owner: 0 });
  assert.equal(r, undefined);
  assert.deepEqual(
    w.asteroids.map((a) => a.trees.length),
    snapshotTrees,
    "unknown command must not mutate the world",
  );
});

test("queueCommand applies immediately and returns the mutator result", () => {
  const w = mk();
  const home = homeOf(w, 0);
  const neutral = neutralColonizable(w);
  const before = orbitersAt(w, home.id, 0);
  // Empty after a queueCommand — it does NOT defer (no append to pendingCommands).
  const sent = queueCommand(w, {
    type: CMD.SEND,
    from: home.id,
    to: neutral.id,
    fraction: 1,
    owner: 0,
  });
  assert.ok(sent > 0);
  assert.equal(orbitersAt(w, home.id, 0), before - sent);
  assert.deepEqual(w.pendingCommands, [], "queueCommand must not stage/defer");
});

test("drainCommands applies every staged command, then clears the list", () => {
  // Two different owners, each rallying their OWN home (the owner guard inside setRally passes
  // for the matching owner only). Insert owner-DESCENDING to prove the drain still applies both.
  const w = mk();
  const r0 = homeOf(w, 0);
  const r1 = homeOf(w, 1);
  const n = neutralColonizable(w);
  w.pendingCommands.push(
    { type: CMD.RALLY, from: r1.id, to: n.id, owner: 1 },
    { type: CMD.RALLY, from: r0.id, to: n.id, owner: 0 },
  );
  drainCommands(w);
  assert.equal(r0.rally, n.id, "owner-0 staged rally applied");
  assert.equal(r1.rally, n.id, "owner-1 staged rally applied");
  assert.equal(w.pendingCommands.length, 0, "drain must clear the staged list");
});

test("drainCommands executes in stable owner-ascending order (real visit order)", () => {
  // Observe the REAL drain visiting the REAL mutator in order: instrument each command's source
  // rock with a `rally` setter that records (owner, seq) the instant setRally writes it. The
  // staged batch is scrambled (owners 2,0,2,1,0); the recorded order must come out owner-ascending
  // and stable within an owner (the two owner-0 entries keep their insertion order, ditto owner-2).
  const w = mk();
  const trace = [];
  function instrument(rock, owner, seq) {
    let v = rock.rally;
    Object.defineProperty(rock, "rally", {
      configurable: true,
      get: () => v,
      set: (x) => {
        v = x;
        trace.push(seq);
      },
    });
    return { type: CMD.RALLY, from: rock.id, to: rock.id, owner, seq };
  }
  // Five distinct owned rocks so each command targets a rock its owner controls (setRally's guard
  // passes). Owners are assigned by the staged command, and each rock is set to that owner first.
  const rocks = w.asteroids
    .filter((a) => a.kind === "asteroid" && !a.moon)
    .slice(0, 5);
  const plan = [
    [2, "a"],
    [0, "b"],
    [2, "c"],
    [1, "d"],
    [0, "e"],
  ];
  // Ensure each rock is owned by the command's owner (so the setRally guard passes) and the world
  // has enough players for owner ids 2 (mk() has 2 players; extend the array for this unit test).
  while (w.players.length <= 2)
    w.players.push({ id: w.players.length, isAi: true, difficulty: 1 });
  plan.forEach(([owner], i) => {
    rocks[i].owner = owner;
  });
  plan.forEach(([owner, seq], i) => {
    w.pendingCommands.push(instrument(rocks[i], owner, seq));
  });
  drainCommands(w);
  assert.deepEqual(
    trace,
    ["b", "e", "d", "a", "c"],
    "owner-ascending, stable within an owner (b before e; a before c)",
  );
  assert.equal(w.pendingCommands.length, 0);
});

test("drainCommands on an empty list is a no-op", () => {
  const w = mk();
  assert.deepEqual(w.pendingCommands, []);
  assert.doesNotThrow(() => drainCommands(w));
  assert.deepEqual(w.pendingCommands, []);
});

test("drainCommands tolerates an absent pendingCommands field", () => {
  const w = mk();
  delete w.pendingCommands; // simulates a deserialized pre-seam save (serialization is a later step)
  assert.doesNotThrow(() => drainCommands(w));
});

// --- Staging (pause-and-plan) tests -----------------------------------------

test("queueCommand STAGES a human command while world is paused (returns STAGED, no immediate mutation)", () => {
  const w = mk();
  w.paused = true;
  const home = homeOf(w, 0);
  const neutral = neutralColonizable(w);
  const before = orbitersAt(w, home.id, 0);
  const result = queueCommand(w, {
    type: CMD.SEND,
    from: home.id,
    to: neutral.id,
    fraction: 1,
    owner: 0,
  });
  assert.equal(result, STAGED, "should return the STAGED sentinel");
  assert.equal(
    orbitersAt(w, home.id, 0),
    before,
    "no orbiters should leave while staged",
  );
  assert.equal(
    w.pendingCommands.length,
    1,
    "command should be pushed onto pendingCommands",
  );
  assert.equal(w.pendingCommands[0].type, CMD.SEND);
  assert.equal(w.pendingCommands[0].from, home.id);
});

test("queueCommand applies immediately (unpaused) — returns mutator result, no staging", () => {
  const w = mk();
  w.paused = false;
  const home = homeOf(w, 0);
  const neutral = neutralColonizable(w);
  const before = orbitersAt(w, home.id, 0);
  const sent = queueCommand(w, {
    type: CMD.SEND,
    from: home.id,
    to: neutral.id,
    fraction: 1,
    owner: 0,
  });
  assert.ok(sent > 0, "should return the actual sent count (not STAGED)");
  assert.notEqual(sent, STAGED);
  assert.equal(
    orbitersAt(w, home.id, 0),
    before - sent,
    "orbiters should leave immediately",
  );
  assert.deepEqual(w.pendingCommands, [], "pendingCommands should stay empty");
});

test("queueCommand applies an AI command immediately even while world is paused", () => {
  const w = mk();
  w.paused = true;
  const r1 = homeOf(w, 1); // AI owner
  const neutral = neutralColonizable(w);
  const before = orbitersAt(w, r1.id, 1);
  const sent = queueCommand(w, {
    type: CMD.SEND,
    from: r1.id,
    to: neutral.id,
    fraction: 1,
    owner: 1,
  });
  assert.ok(sent > 0, "AI send should apply immediately (AI never stages)");
  assert.notEqual(sent, STAGED);
  assert.equal(orbitersAt(w, r1.id, 1), before - sent);
  assert.deepEqual(
    w.pendingCommands,
    [],
    "AI command must not touch pendingCommands",
  );
});

test("staged command executes on resume: unpause + drainCommands applies the staged order", () => {
  const w = mk();
  w.paused = true;
  const home = homeOf(w, 0);
  const neutral = neutralColonizable(w);
  const before = orbitersAt(w, home.id, 0);
  // Stage a SEND while paused.
  const r = queueCommand(w, {
    type: CMD.SEND,
    from: home.id,
    to: neutral.id,
    fraction: 1,
    owner: 0,
  });
  assert.equal(r, STAGED);
  assert.equal(
    orbitersAt(w, home.id, 0),
    before,
    "still no departure while paused",
  );
  // Simulate resume: unpause then drain (mirrors what step() does).
  w.paused = false;
  drainCommands(w);
  assert.ok(
    orbitersAt(w, home.id, 0) < before,
    "orbiters departed after drain",
  );
  assert.deepEqual(
    w.pendingCommands,
    [],
    "pendingCommands cleared after drain",
  );
});
