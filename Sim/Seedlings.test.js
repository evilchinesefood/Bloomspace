import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, OWNER_NEUTRAL, STATE, EVENT } from "./World.js";
import { sendSeedlings, updateSeedlings } from "./Seedlings.js";
import Sim from "./World.js";

const PLAYERS = [
  { id: 0, isAi: false, difficulty: 0 },
  { id: 1, isAi: true, difficulty: 1 },
];

function mk(seed = 7, count = 20) {
  return createWorld({
    seed,
    asteroidCount: count,
    players: PLAYERS,
    width: 2000,
    height: 2000,
  });
}

// A neutral, colonizable body: a plain habitable asteroid (NOT the non-habitable star or a
// moving moon — sending to those wouldn't colonize / behaves specially).
function neutralColonizable(w) {
  return w.asteroids.find(
    (a) => a.owner === OWNER_NEUTRAL && a.kind === "asteroid" && !a.moon,
  );
}

// Find a home asteroid for player 0 and a neutral colonizable asteroid.
function homeAndNeutral(w, owner = 0) {
  const home = w.asteroids.find((a) => a.owner === owner);
  const neutral = neutralColonizable(w);
  return { home, neutral };
}

function countOrbiting(w, asteroidId, owner) {
  const s = w.seed;
  let n = 0;
  for (let i = 0; i < s.count; i++) {
    if (
      s.state[i] === STATE.ORBIT &&
      s.home[i] === asteroidId &&
      s.owner[i] === owner
    )
      n++;
  }
  return n;
}

// Step until a predicate holds or we hit a guard.
function stepUntil(w, pred, max = 2000) {
  for (let i = 0; i < max; i++) {
    if (pred()) return i;
    Sim.step(w, 1 / 30);
  }
  return -1;
}

test("send converts floor(count*fraction) eligible orbiters to transit", () => {
  const w = mk();
  const { home, neutral } = homeAndNeutral(w);
  const before = countOrbiting(w, home.id, 0);
  const sent = sendSeedlings(w, home.id, neutral.id, 0.5, 0);
  assert.equal(sent, Math.floor(before * 0.5));
  // those many are now TRANSIT with the neutral as their final destination (the next-hop
  // `target` may be an intermediate waypoint on the nearest-neighbor route).
  let transit = 0;
  for (let i = 0; i < w.seed.count; i++) {
    if (w.seed.state[i] === STATE.TRANSIT && w.seed.dest[i] === neutral.id)
      transit++;
  }
  assert.equal(transit, sent);
});

test("multi-hop: sending to a far asteroid routes through the neighbor network", () => {
  const w = mk();
  const home = w.asteroids.find((a) => a.owner === 0);
  // find a NON-adjacent neutral destination (nav first-hop is an intermediate, not the dest)
  let far = -1;
  for (let t = 0; t < w.asteroids.length; t++) {
    if (t === home.id || w.asteroids[t].owner !== OWNER_NEUTRAL) continue;
    const hop = w.nav[home.id][t];
    if (hop >= 0 && hop !== t) {
      far = t;
      break;
    }
  }
  assert.notEqual(far, -1, "expected a non-adjacent neutral asteroid");
  const sent = sendSeedlings(w, home.id, far, 1, 0);
  assert.ok(sent >= 1);
  // Sent seedlings aim at the FIRST HOP (a neighbor of home), not straight at the far rock.
  for (let i = 0; i < w.seed.count; i++) {
    if (w.seed.state[i] === STATE.TRANSIT && w.seed.dest[i] === far) {
      assert.notEqual(
        w.seed.target[i],
        far,
        "must not fly straight to a far rock",
      );
      assert.ok(
        home.neighbors.includes(w.seed.target[i]),
        "first hop is a neighbor of home",
      );
    }
  }
  // …and they eventually reach the far destination by hopping the network.
  const arrived = stepUntil(
    w,
    () => {
      for (let i = 0; i < w.seed.count; i++)
        if (w.seed.owner[i] === 0 && w.seed.home[i] === far) return true;
      return false;
    },
    4000,
  );
  assert.notEqual(
    arrived,
    -1,
    "multi-hop seedlings never reached the destination",
  );
});

test("send respects owner filter", () => {
  const w = mk();
  const home0 = w.asteroids.find((a) => a.owner === 0);
  const neutral = w.asteroids.find((a) => a.owner === OWNER_NEUTRAL);
  // owner 1 has no seedlings orbiting home0 => nothing sent
  const sent = sendSeedlings(w, home0.id, neutral.id, 1, 1);
  assert.equal(sent, 0);
});

test("send no-ops: from==to, bad target, fraction 0", () => {
  const w = mk();
  const { home, neutral } = homeAndNeutral(w);
  assert.equal(sendSeedlings(w, home.id, home.id, 1, 0), 0);
  assert.equal(sendSeedlings(w, home.id, 99999, 1, 0), 0);
  assert.equal(sendSeedlings(w, home.id, neutral.id, 0, 0), 0);
});

test("fraction clamps above 1 (sends all eligible)", () => {
  const w = mk();
  const { home, neutral } = homeAndNeutral(w);
  const before = countOrbiting(w, home.id, 0);
  const sent = sendSeedlings(w, home.id, neutral.id, 5, 0);
  assert.equal(sent, before);
});

test("tiny fraction with few eligible sends 0 (floor)", () => {
  const w = createWorld({ seed: 3, asteroidCount: 8, players: PLAYERS });
  const home = w.asteroids.find((a) => a.owner === 0);
  const neutral = w.asteroids.find((a) => a.owner === OWNER_NEUTRAL);
  const before = countOrbiting(w, home.id, 0);
  assert.ok(before >= 1);
  // 0.01 * (<=12) floors to 0
  assert.equal(sendSeedlings(w, home.id, neutral.id, 0.01, 0), 0);
});

test("transit to neutral colonizes then orbits new home", () => {
  const w = mk();
  const { home, neutral } = homeAndNeutral(w);
  assert.equal(neutral.owner, OWNER_NEUTRAL);
  const sent = sendSeedlings(w, home.id, neutral.id, 1, 0);
  assert.ok(sent >= 1);
  const arrived = stepUntil(w, () => neutral.owner === 0);
  assert.notEqual(arrived, -1, "never colonized");
  assert.equal(neutral.owner, 0);
  // seedlings should be orbiting the new home with target -1
  const n = countOrbiting(w, neutral.id, 0);
  assert.ok(n >= 1, "no orbiters at colonized rock");
  for (let i = 0; i < w.seed.count; i++) {
    if (w.seed.home[i] === neutral.id) {
      assert.equal(w.seed.target[i], -1);
      assert.equal(w.seed.state[i], STATE.ORBIT);
    }
  }
});

test("sending to OWN asteroid re-homes without ownership change", () => {
  const w = mk();
  const home0 = w.asteroids.find((a) => a.owner === 0);
  // colonize a neutral first to get a second owned rock (send half, keep a reserve)
  const neutral = neutralColonizable(w);
  sendSeedlings(w, home0.id, neutral.id, 0.5, 0);
  stepUntil(w, () => neutral.owner === 0);
  // now send the remaining reserve from home0 to the (now owned) second rock
  const sent = sendSeedlings(w, home0.id, neutral.id, 1, 0);
  assert.ok(sent >= 1);
  stepUntil(w, () => countOrbiting(w, neutral.id, 0) >= sent + 1, 4000);
  assert.equal(neutral.owner, 0); // still owner 0, no flip
});

test("enemy arrival is governed by combat, not instant colonization", () => {
  // Unlike a neutral rock (instant colonize on arrival), an enemy-held rock is NOT
  // captured on mere contact: combat must wipe the defenders first (Combat.flipOwnership).
  // This is robust to who ultimately wins — it only checks the arrival moment + that the
  // fight actually produces casualties (combat is wired into step()).
  // Use a passive opponent so the test isolates combat: an active AI defender would
  // expand/produce and inflate the population, masking the casualty signal.
  const w = createWorld({
    seed: 7,
    asteroidCount: 16,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: false, difficulty: 1 },
    ],
    width: 1000,
    height: 1000,
  });
  const home0 = w.asteroids.find((a) => a.owner === 0);
  const home1 = w.asteroids.find((a) => a.owner === 1);
  const startCount = w.seed.count;
  const sent = sendSeedlings(w, home0.id, home1.id, 1, 0);
  assert.ok(sent >= 1);
  // Step until the first attacker actually reaches and re-homes at the enemy rock.
  // resolveArrival runs in updateSeedlings *before* resolveCombat in the same tick, so the
  // arriving attacker is always observed alive here regardless of stats.
  const arrived = stepUntil(
    w,
    () => {
      for (let i = 0; i < w.seed.count; i++)
        if (w.seed.owner[i] === 0 && w.seed.home[i] === home1.id) return true;
      return false;
    },
    1500,
  );
  assert.notEqual(arrived, -1, "attacker never reached enemy rock");
  assert.equal(
    home1.owner,
    1,
    "enemy rock colonized on mere contact (should require combat)",
  );
  // Combat is actually engaged: the fight kills seedlings over time.
  for (let i = 0; i < 1500; i++) Sim.step(w, 1 / 30);
  assert.ok(w.seed.count < startCount, "combat never resolved (no casualties)");
});

// --- unreachable target (regression: don't report a phantom dispatch) ---

test("send to an unreachable target sends nothing and emits no SEND event", () => {
  const w = mk();
  const { home, neutral } = homeAndNeutral(w);
  // Simulate a disconnected graph component: no first hop from home to the target.
  w.nav[home.id][neutral.id] = -1;
  const orbitingBefore = countOrbiting(w, home.id, 0);
  assert.ok(orbitingBefore > 0, "home should have orbiters available to send");
  const sent = sendSeedlings(w, home.id, neutral.id, 1, 0);
  assert.equal(sent, 0, "no ships launch toward an unreachable target");
  assert.equal(
    countOrbiting(w, home.id, 0),
    orbitingBefore,
    "all ships stay in orbit when the target is unreachable",
  );
  let sendEvents = 0;
  for (let k = 0; k < w.events.n; k++)
    if (w.events.type[k] === EVENT.SEND) sendEvents++;
  assert.equal(
    sendEvents,
    0,
    "no confirm SEND event for a dispatch that didn't happen",
  );
});

// --- SLING break-off when the center body dies (regression: t.dead guard parity) ---

test("a SLING ship whose center body is destroyed breaks off into TRANSIT", () => {
  const w = mk();
  const s = w.seed;
  const center = w.asteroids.find((a) => a.kind === "asteroid");
  // Put seedling 0 into a slingshot arc around the center body.
  s.state[0] = STATE.SLING;
  s.target[0] = center.id;
  s.slingRem[0] = 0.5;
  // Destroy the center WITHOUT routing through destroyBody's same-tick reap loop.
  center.dead = true;
  updateSeedlings(w, 1 / 30);
  assert.equal(
    s.state[0],
    STATE.TRANSIT,
    "ship leaves the dead body instead of orbiting a corpse",
  );
  assert.equal(s.slingRem[0], 0, "sling remainder cleared on break-off");
});
