// Retreat.test.js — Feature #2 Retreat & Regroup. A DETERMINISTIC, rng-free post-combat pass:
// a rock "armed for retreat" that's outmatched after combat sends its ORBITing garrison to a
// valid owned fallback rock (via launchSeedling). Default-off → no-op → byte-identical to before
// (the parity suite in Save.test.js covers that). Here we assert the OBSERVABLE on-path: an armed
// + outmatched rock retreats; an unarmed one (or a not-outmatched one) does not; and the
// retreatArmed/fallbackId fields survive a serialize→deserialize round-trip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, spawnSeedling, STATE } from "./World.js";
import { resolveCombat, updateRetreat } from "./Combat.js";
import { addConnection } from "./MapGen.js";
import { applyCommand, CMD } from "./Commands.js";
import { serialize, deserialize } from "./Save.js";

const DT = 1 / 30;

// A world with two human-owned rocks (A = home, B = fallback) DIRECTLY linked so launchSeedling's
// nav routing resolves a first hop A→B. We then wipe the auto-seeded orbiters and place our own.
function twoRockWorld(seed = 1) {
  const w = createWorld({
    seed,
    asteroidCount: 8,
    players: [{ id: 0, isAi: false, difficulty: 0 }],
    width: 3000,
    height: 3000,
  });
  const home = w.asteroids.find((a) => a.owner === 0);
  // Pick a DIFFERENT habitable plain rock as the fallback and make us own it; link the two so the
  // nav table has a direct hop (launchSeedling needs a reachable first hop).
  const fb = w.asteroids.find(
    (a) => a.id !== home.id && a.kind === "asteroid" && !a.moon && !a.dead,
  );
  fb.owner = 0;
  if (!home.neighbors.includes(fb.id)) addConnection(w, home.id, fb.id);
  w.seed.count = 0; // drop auto orbiters — we control the garrison/enemy directly
  return { w, home, fb };
}

// Place a seedling at an exact position with given owner/strength/energy, homed at `home`.
function put(w, x, y, owner, strength, energy, home) {
  const i = spawnSeedling(w, { home, owner, strength, energy });
  const s = w.seed;
  s.x[i] = x;
  s.y[i] = y;
  s.px[i] = x;
  s.py[i] = y;
  s.state[i] = STATE.ORBIT;
  return i;
}

// Count this owner's STATIONED garrison homed at rockId — a defending ship is ORBIT (idle) or
// COMBAT (resolveCombat tints an engaged orbiter COMBAT, not ORBIT); a fled ship is TRANSIT.
function orbitGarrison(w, rockId, owner) {
  const s = w.seed;
  let n = 0;
  for (let i = 0; i < s.count; i++)
    if (
      (s.state[i] === STATE.ORBIT || s.state[i] === STATE.COMBAT) &&
      s.home[i] === rockId &&
      s.owner[i] === owner
    )
      n++;
  return n;
}

// Count this owner's TRANSITing seedlings whose final dest is destId.
function transitToward(w, destId, owner) {
  const s = w.seed;
  let n = 0;
  for (let i = 0; i < s.count; i++)
    if (
      s.state[i] === STATE.TRANSIT &&
      s.owner[i] === owner &&
      s.dest[i] === destId
    )
      n++;
  return n;
}

// Garrison the home rock with our defenders and stack a stronger enemy presence ON that body
// (homed there, owner 1) so resolveCombat records enemy strength > our strength at the rock.
function setupOutmatched({ w, home }) {
  // 2 weak owned defenders on home, FAR apart so proximity damage doesn't kill them this tick.
  put(w, home.x + 4, home.y, 0, 20, 100, home.id);
  put(w, home.x - 4, home.y, 0, 20, 100, home.id);
  // 4 strong enemies co-homed on the same rock (same-body engagement → totAt[home] dominated by
  // enemy strength). Placed far from our defenders so they don't trade lethal proximity damage.
  for (let k = 0; k < 4; k++)
    put(w, home.x + 400 + k, home.y + 400, 1, 80, 100, home.id);
}

test("armed + outmatched rock retreats its ORBIT garrison toward the fallback", () => {
  const { w, home, fb } = twoRockWorld(3);
  setupOutmatched({ w, home });
  home.retreatArmed = true;
  home.fallbackId = fb.id;
  const before = orbitGarrison(w, home.id, 0);
  assert.ok(before >= 1, "home should start with an owned garrison");

  resolveCombat(w, DT);
  updateRetreat(w);

  // Survivors of our garrison that were still ORBITing flipped to TRANSIT toward the fallback.
  const stillOrbiting = orbitGarrison(w, home.id, 0);
  const fleeing = transitToward(w, fb.id, 0);
  assert.equal(
    stillOrbiting,
    0,
    "no owned garrison left orbiting the home rock",
  );
  assert.ok(fleeing >= 1, "the garrison launched toward the fallback");
  // Each fleeing ship is in TRANSIT with its FINAL dest = fallback id (its first hop is the
  // direct A→B link).
  const s = w.seed;
  for (let i = 0; i < s.count; i++)
    if (s.owner[i] === 0 && s.state[i] === STATE.TRANSIT)
      assert.equal(s.dest[i], fb.id, "fleeing ship destined for the fallback");
});

test("UNARMED rock in the same outmatched situation does NOT retreat", () => {
  const { w, home, fb } = twoRockWorld(3);
  setupOutmatched({ w, home });
  home.retreatArmed = false; // not armed
  home.fallbackId = fb.id;

  resolveCombat(w, DT);
  updateRetreat(w);

  // Garrison stays put (still orbiting home), none launched toward the fallback.
  assert.ok(
    orbitGarrison(w, home.id, 0) >= 1,
    "unarmed garrison must stay in orbit",
  );
  assert.equal(
    transitToward(w, fb.id, 0),
    0,
    "unarmed rock must not launch a retreat",
  );
});

test("armed but NOT-outmatched rock does NOT retreat", () => {
  const { w, home, fb } = twoRockWorld(3);
  // OUR side dominates: many strong defenders, a single weak enemy on the rock.
  for (let k = 0; k < 5; k++) put(w, home.x + k, home.y, 0, 80, 200, home.id);
  put(w, home.x + 400, home.y + 400, 1, 10, 200, home.id);
  home.retreatArmed = true;
  home.fallbackId = fb.id;

  resolveCombat(w, DT);
  updateRetreat(w);

  assert.ok(
    orbitGarrison(w, home.id, 0) >= 1,
    "winning garrison must hold position",
  );
  assert.equal(
    transitToward(w, fb.id, 0),
    0,
    "a rock that is winning must not retreat",
  );
});

test("retreat skips an INVALID fallback (dead / not-owned / self)", () => {
  // Dead fallback → no retreat even when armed + outmatched.
  {
    const { w, home, fb } = twoRockWorld(3);
    setupOutmatched({ w, home });
    home.retreatArmed = true;
    home.fallbackId = fb.id;
    fb.dead = true;
    resolveCombat(w, DT);
    updateRetreat(w);
    assert.equal(
      transitToward(w, fb.id, 0),
      0,
      "no retreat to a dead fallback",
    );
    assert.ok(orbitGarrison(w, home.id, 0) >= 1, "garrison held");
  }
  // Fallback owned by someone else → no retreat.
  {
    const { w, home, fb } = twoRockWorld(3);
    setupOutmatched({ w, home });
    home.retreatArmed = true;
    home.fallbackId = fb.id;
    fb.owner = 1; // enemy now holds the would-be fallback
    resolveCombat(w, DT);
    updateRetreat(w);
    assert.equal(transitToward(w, fb.id, 0), 0, "no retreat to an enemy rock");
  }
  // Fallback === self → no retreat.
  {
    const { w, home } = twoRockWorld(3);
    setupOutmatched({ w, home });
    home.retreatArmed = true;
    home.fallbackId = home.id;
    resolveCombat(w, DT);
    updateRetreat(w);
    assert.equal(
      orbitGarrison(w, home.id, 0) >= 1,
      true,
      "self-fallback never retreats",
    );
  }
});

test("CMD.RETREAT arms the rock only for its owner; sets retreatArmed + fallbackId", () => {
  const { w, home, fb } = twoRockWorld(5);
  // Owner match → applied.
  const ok = applyCommand(w, {
    type: CMD.RETREAT,
    rock: home.id,
    fallbackId: fb.id,
    armed: true,
    owner: 0,
  });
  assert.equal(ok, true);
  assert.equal(home.retreatArmed, true);
  assert.equal(home.fallbackId, fb.id);
  // Wrong owner → no-op (must not flip another player's rock).
  const denied = applyCommand(w, {
    type: CMD.RETREAT,
    rock: home.id,
    fallbackId: fb.id,
    armed: false,
    owner: 1,
  });
  assert.equal(denied, false, "non-owner cannot toggle the rock's retreat");
  assert.equal(
    home.retreatArmed,
    true,
    "state unchanged by the denied command",
  );
});

test("save round-trip preserves retreatArmed + fallbackId on a rock", () => {
  const { w, home, fb } = twoRockWorld(7);
  home.retreatArmed = true;
  home.fallbackId = fb.id;
  const w2 = deserialize(serialize(w));
  assert.ok(w2, "deserialize produced a world");
  const home2 = w2.asteroids[home.id];
  assert.equal(home2.retreatArmed, true, "retreatArmed round-trips");
  assert.equal(home2.fallbackId, fb.id, "fallbackId round-trips");
});
