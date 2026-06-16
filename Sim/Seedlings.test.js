import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, OWNER_NEUTRAL, STATE } from "./World.js";
import { sendSeedlings } from "./Seedlings.js";
import Sim from "./World.js";

const PLAYERS = [
  { id: 0, isAi: false, difficulty: 0 },
  { id: 1, isAi: true, difficulty: 1 },
];

function mk(seed = 7, count = 16) {
  return createWorld({
    seed,
    asteroidCount: count,
    players: PLAYERS,
    width: 1000,
    height: 1000,
  });
}

// Find a home asteroid for player 0 and a neutral asteroid.
function homeAndNeutral(w, owner = 0) {
  const home = w.asteroids.find((a) => a.owner === owner);
  const neutral = w.asteroids.find((a) => a.owner === OWNER_NEUTRAL);
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
  // those many are now TRANSIT toward neutral
  let transit = 0;
  for (let i = 0; i < w.seed.count; i++) {
    if (w.seed.state[i] === STATE.TRANSIT && w.seed.target[i] === neutral.id)
      transit++;
  }
  assert.equal(transit, sent);
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
  const neutral = w.asteroids.find((a) => a.owner === OWNER_NEUTRAL);
  sendSeedlings(w, home0.id, neutral.id, 0.5, 0);
  stepUntil(w, () => neutral.owner === 0);
  // now send the remaining reserve from home0 to the (now owned) second rock
  const sent = sendSeedlings(w, home0.id, neutral.id, 1, 0);
  assert.ok(sent >= 1);
  stepUntil(w, () => countOrbiting(w, neutral.id, 0) >= sent + 1, 4000);
  assert.equal(neutral.owner, 0); // still owner 0, no flip
});

test("sending to ENEMY asteroid does NOT flip ownership", () => {
  const w = mk();
  const home0 = w.asteroids.find((a) => a.owner === 0);
  const home1 = w.asteroids.find((a) => a.owner === 1);
  const sent = sendSeedlings(w, home0.id, home1.id, 1, 0);
  assert.ok(sent >= 1);
  // step well past arrival
  for (let i = 0; i < 1500; i++) Sim.step(w, 1 / 30);
  assert.equal(home1.owner, 1, "enemy rock ownership wrongly flipped");
  // the sent seedlings are alive (not DEAD) and now homed at the enemy rock
  let parked = 0;
  for (let i = 0; i < w.seed.count; i++) {
    if (w.seed.owner[i] === 0 && w.seed.home[i] === home1.id) parked++;
  }
  assert.ok(parked >= 1, "attacker seedlings not parked at enemy rock");
});
