import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, spawnSeedling, STATE, OWNER_NEUTRAL } from "./World.js";
import { resolveCombat, CONTACT_RADIUS, HOLD_GAP } from "./Combat.js";
import Sim from "./World.js";

// Build a minimal world with ONE asteroid at a known spot and no auto-seeded orbiters
// of interest. We place our own seedlings by directly poking the SoA (via spawnSeedling
// then overwriting x/y) so positions are fully controlled for combat tests.
function bareWorld(seed = 1) {
  // 1 asteroid, 1 player → MapGen seeds 10 orbiters on it; that's fine, we ignore them
  // by giving our test seedlings a distinct owner/position far from the auto ones, or by
  // using a fresh asteroid coordinate. We instead create a world with a single player so
  // only owner 0 home seedlings exist, then add our own.
  return createWorld({
    seed,
    asteroidCount: 1,
    players: [{ id: 0, isAi: false, difficulty: 0 }],
    width: 4000,
    height: 4000,
  });
}

// Place a seedling at an exact position with given owner/strength/energy.
function put(w, x, y, owner, strength, energy, home = 0) {
  const i = spawnSeedling(w, { home, owner, strength, energy });
  const s = w.seed;
  s.x[i] = x;
  s.y[i] = y;
  s.px[i] = x;
  s.py[i] = y;
  s.state[i] = STATE.ORBIT;
  return i;
}

function aliveCount(w, owner) {
  const s = w.seed;
  let n = 0;
  for (let i = 0; i < s.count; i++) if (s.owner[i] === owner) n++;
  return n;
}

// --- Grid / proximity -------------------------------------------------------

test("grid: enemies within CONTACT_RADIUS trade damage; far ones don't", () => {
  const w = bareWorld();
  // wipe the auto-seeded orbiters so they don't interfere
  w.seed.count = 0;
  // home -1 = not orbiting a rock, so this isolates PROXIMITY combat (the same-home rule
  // would otherwise make co-homed enemies fight regardless of distance).
  const a = put(w, 0, 0, 0, 50, 100, -1);
  const near = put(w, CONTACT_RADIUS - 1, 0, 1, 50, 100, -1);
  const far = put(w, 500, 0, 1, 50, 100, -1);
  const e0 = w.seed.energy[a];
  const eNear = w.seed.energy[near];
  const eFar = w.seed.energy[far];
  resolveCombat(w, 1 / 30);
  // a and near are in contact -> both lost energy
  assert.ok(w.seed.energy[0] < e0 || w.seed.count < 3, "a should take damage");
  // far one untouched (find it: it's the only owner-1 seedling that didn't lose energy)
  let farUntouched = false;
  for (let i = 0; i < w.seed.count; i++) {
    if (w.seed.owner[i] === 1 && Math.abs(w.seed.x[i] - 500) < 1) {
      farUntouched = w.seed.energy[i] === eFar;
    }
  }
  assert.ok(farUntouched, "far enemy should be untouched");
  void eNear;
});

test("same-rock enemies fight even far apart (no peaceful co-occupation)", () => {
  const w = bareWorld();
  w.seed.count = 0;
  // two enemies sharing home 0, placed FAR apart (way beyond CONTACT_RADIUS)
  const a = put(w, 0, 0, 0, 50, 100, 0);
  const e0 = w.seed.energy[a];
  const e1 = w.seed.energy[put(w, 600, 0, 1, 50, 100, 0)];
  resolveCombat(w, 1 / 30);
  assert.ok(w.seed.energy[0] < e0, "co-homed enemy a takes damage");
  let bDmg = false;
  for (let i = 0; i < w.seed.count; i++)
    if (w.seed.owner[i] === 1) bDmg = w.seed.energy[i] < e1;
  assert.ok(bDmg, "co-homed enemy b takes damage despite the distance");
});

test("no friendly fire: same-owner neighbors never lose energy", () => {
  const w = bareWorld();
  w.seed.count = 0;
  put(w, 0, 0, 0, 80, 100);
  put(w, 3, 0, 0, 80, 100);
  put(w, 6, 0, 0, 80, 100);
  for (let t = 0; t < 50; t++) resolveCombat(w, 1 / 30);
  for (let i = 0; i < w.seed.count; i++) {
    assert.equal(w.seed.energy[i], 100, "friendly seedling lost energy");
  }
  assert.equal(w.seed.count, 3);
});

// --- Determinism ------------------------------------------------------------

function fightWorld(seed) {
  const w = bareWorld(seed);
  w.seed.count = 0;
  // two clusters of 4 each, interleaved within contact range
  for (let k = 0; k < 4; k++) {
    put(w, k * 4, 0, 0, 50, 40);
    put(w, k * 4 + 2, 0, 1, 50, 40);
  }
  return w;
}

test("deterministic: identical setup+seed ⇒ identical survivors after N ticks", () => {
  const wa = fightWorld(11);
  const wb = fightWorld(11);
  for (let t = 0; t < 200; t++) {
    resolveCombat(wa, 1 / 30);
    resolveCombat(wb, 1 / 30);
  }
  assert.equal(wa.seed.count, wb.seed.count);
  for (let i = 0; i < wa.seed.count; i++) {
    assert.equal(wa.seed.owner[i], wb.seed.owner[i]);
    assert.equal(wa.seed.x[i], wb.seed.x[i]);
    assert.ok(Math.abs(wa.seed.energy[i] - wb.seed.energy[i]) < 1e-6);
  }
});

test("stronger/more-numerous side reliably wins", () => {
  const w = bareWorld(5);
  w.seed.count = 0;
  // owner 0: 6 strong; owner 1: 2 weak — all packed in contact
  for (let k = 0; k < 6; k++) put(w, k, 0, 0, 80, 60);
  for (let k = 0; k < 2; k++) put(w, k + 1, 0.5, 1, 30, 60);
  for (let t = 0; t < 400; t++) resolveCombat(w, 1 / 30);
  assert.equal(aliveCount(w, 1), 0, "weak side should be wiped");
  assert.ok(aliveCount(w, 0) >= 1, "strong side should have survivors");
});

test("equal forces mutually attrit (both sides take losses)", () => {
  const w = bareWorld(9);
  w.seed.count = 0;
  for (let k = 0; k < 5; k++) {
    put(w, k * 2, 0, 0, 50, 30);
    put(w, k * 2 + 1, 0, 1, 50, 30);
  }
  const a0 = aliveCount(w, 0);
  const b0 = aliveCount(w, 1);
  for (let t = 0; t < 300; t++) resolveCombat(w, 1 / 30);
  assert.ok(aliveCount(w, 0) < a0, "side 0 should lose some");
  assert.ok(aliveCount(w, 1) < b0, "side 1 should lose some");
});

// --- Death compaction integrity ---------------------------------------------

test("death compaction: count correct, arrays dense, no DEAD interleaved", () => {
  const w = bareWorld(3);
  w.seed.count = 0;
  // many overlapping enemies so lots die in a tick
  for (let k = 0; k < 10; k++) {
    put(w, k * 0.5, 0, 0, 90, 5); // tiny energy → die fast
    put(w, k * 0.5, 0.2, 1, 90, 5);
  }
  const before = w.seed.count;
  for (let t = 0; t < 100; t++) resolveCombat(w, 1 / 30);
  const s = w.seed;
  assert.ok(s.count < before, "some should have died");
  // dense: no DEAD state within [0,count); all slots are real
  for (let i = 0; i < s.count; i++) {
    assert.notEqual(
      s.state[i],
      STATE.DEAD,
      "DEAD slot interleaved in live range",
    );
  }
  // count is internally consistent: stepping more never reads beyond count
  resolveCombat(w, 1 / 30);
  assert.ok(s.count >= 0 && s.count <= s.capacity);
});

// --- Ownership flips ---------------------------------------------------------

test("flip: defenders wiped + single attacker side in hold-zone ⇒ owner flips", () => {
  const w = bareWorld(2);
  const rock = w.asteroids[0];
  rock.owner = 1; // pretend owner 1 holds it but has no defenders
  w.seed.count = 0; // remove auto orbiters
  const len = w.asteroids.length;
  // one attacker (owner 0) sitting inside the hold-zone, no defenders present
  put(w, rock.x + rock.radius + HOLD_GAP - 5, rock.y, 0, 50, 100);
  resolveCombat(w, 1 / 30);
  assert.equal(rock.owner, 0, "rock should flip to lone attacker");
  assert.equal(w.asteroids.length, len, "asteroids array length changed");
});

test("contested: defender still present ⇒ no flip", () => {
  const w = bareWorld(2);
  const rock = w.asteroids[0];
  rock.owner = 1;
  w.seed.count = 0;
  // defender (owner 1) AND attacker (owner 0) both in hold-zone but NOT in contact range
  put(w, rock.x + 5, rock.y, 1, 50, 100); // defender near center
  put(w, rock.x + rock.radius + HOLD_GAP - 2, rock.y, 0, 50, 100); // attacker at edge
  resolveCombat(w, 1 / 30);
  assert.equal(rock.owner, 1, "contested rock must not flip");
});

test("two rival sides present (no defender) ⇒ no flip", () => {
  const w = bareWorld(2);
  const rock = w.asteroids[0];
  rock.owner = 2; // owner with no units anywhere
  w.seed.count = 0;
  put(w, rock.x + 10, rock.y + 0, 0, 50, 100);
  put(w, rock.x - 10, rock.y + 0, 1, 50, 100);
  resolveCombat(w, 1 / 30);
  assert.equal(rock.owner, 2, "two rivals contest → no clean flip");
});

test("neutral rock is never flipped by combat (colonization is T2's job)", () => {
  const w = bareWorld(2);
  const rock = w.asteroids[0];
  rock.owner = OWNER_NEUTRAL;
  w.seed.count = 0;
  put(w, rock.x + 5, rock.y, 0, 50, 100);
  resolveCombat(w, 1 / 30);
  assert.equal(
    rock.owner,
    OWNER_NEUTRAL,
    "combat must not colonize neutral rocks",
  );
});

// --- Behavioral via full step() --------------------------------------------

test("full step(): opposing clusters near a rock fight to a flip without index corruption", () => {
  const w = bareWorld(4);
  const rock = w.asteroids[0];
  rock.owner = 1;
  w.seed.count = 0;
  // 2 weak defenders (owner 1) + 8 strong attackers (owner 0) clustered at the rock
  for (let k = 0; k < 2; k++) put(w, rock.x + k, rock.y, 1, 25, 30, 0);
  for (let k = 0; k < 8; k++)
    put(w, rock.x + (k % 4), rock.y + 1 + (k >> 2), 0, 70, 80, 0);

  let flipped = false;
  for (let t = 0; t < 600; t++) {
    Sim.step(w, 1 / 30);
    // density invariant every tick
    assert.ok(w.seed.count <= w.seed.capacity);
    if (rock.owner === 0) {
      flipped = true;
      break;
    }
  }
  assert.ok(flipped, "attackers should eventually take the rock");
  assert.equal(aliveCount(w, 1), 0, "defenders wiped");
});
