import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, spawnSeedling, STATE, OWNER_NEUTRAL } from "./World.js";
import { updateAi, checkVictory } from "./Ai.js";
import Sim from "./World.js";

const hasNaN = (s) => {
  for (let i = 0; i < s.count; i++)
    if (
      Number.isNaN(s.x[i]) ||
      Number.isNaN(s.y[i]) ||
      Number.isNaN(s.energy[i])
    )
      return true;
  return false;
};

const ownedBy = (w, id) => w.asteroids.filter((a) => a.owner === id).length;
const transit = (w) => {
  const s = w.seed;
  let n = 0;
  for (let i = 0; i < s.count; i++) if (s.state[i] === STATE.TRANSIT) n++;
  return n;
};

// --- Win / lose / playing ---------------------------------------------------

test("win: every asteroid owned by 0 ⇒ status 'won'", () => {
  const w = createWorld({
    seed: 1,
    asteroidCount: 6,
    players: [{ id: 0, isAi: false, difficulty: 0 }],
  });
  for (const a of w.asteroids) a.owner = 0;
  checkVictory(w);
  assert.equal(w.status, "won");
});

test("win is detected through a full step()", () => {
  const w = createWorld({
    seed: 2,
    asteroidCount: 4,
    players: [{ id: 0, isAi: false, difficulty: 0 }],
  });
  for (const a of w.asteroids) a.owner = 0;
  Sim.step(w, 1 / 30);
  assert.equal(w.status, "won");
});

test("lose: player 0 owns no rocks and has no seedlings ⇒ 'lost'", () => {
  const w = createWorld({
    seed: 3,
    asteroidCount: 4,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 1 },
    ],
  });
  for (const a of w.asteroids) a.owner = 1;
  w.seed.count = 0; // wipe all seedlings (incl. player 0's)
  checkVictory(w);
  assert.equal(w.status, "lost");
});

test("not lost while player 0 still has seedlings even with no rocks", () => {
  const w = createWorld({
    seed: 3,
    asteroidCount: 4,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 1 },
    ],
  });
  for (const a of w.asteroids) a.owner = 1;
  // player 0 keeps its auto-seeded orbiters; they're still alive
  checkVictory(w);
  assert.equal(w.status, "playing");
});

test("mixed ownership ⇒ 'playing'", () => {
  const w = createWorld({
    seed: 4,
    asteroidCount: 6,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 1 },
    ],
  });
  checkVictory(w);
  assert.equal(w.status, "playing");
});

test("terminal status never flips back", () => {
  const w = createWorld({
    seed: 5,
    asteroidCount: 4,
    players: [{ id: 0, isAi: false, difficulty: 0 }],
  });
  for (const a of w.asteroids) a.owner = 0;
  checkVictory(w);
  assert.equal(w.status, "won");
  // now make it look like a loss; status must stay 'won'
  for (const a of w.asteroids) a.owner = 1;
  w.seed.count = 0;
  checkVictory(w);
  assert.equal(w.status, "won");
});

// --- AI behaves: expands / fights -------------------------------------------

test("AI expands: owns more rocks (or sends seedlings) after many ticks", () => {
  const w = createWorld({
    seed: 7,
    asteroidCount: 12,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 2 },
    ],
  });
  const start = ownedBy(w, 1);
  let sawTransit = false;
  for (let t = 0; t < 4000; t++) {
    Sim.step(w, 1 / 30);
    if (transit(w) > 0) sawTransit = true;
    if (ownedBy(w, 1) > start) break;
  }
  assert.ok(
    ownedBy(w, 1) > start || sawTransit,
    "AI should expand or at least dispatch seedlings",
  );
  assert.ok(!hasNaN(w.seed), "no NaN in seedling arrays");
});

// --- Difficulty matters ------------------------------------------------------

test("higher difficulty takes more actions / expands over the same window", () => {
  // Spec metric: a higher-difficulty AI "acts more often / more aggressively". We measure
  // dispatch actions (player._aiSends) — a clean, deterministic signal — plus expansion.
  // Raw neutral-capture count is noisy (the map saturates and an aggressive AI spends some
  // sends fighting), so actions is the primary assertion and expansion is a soft check.
  const make = (dif) =>
    createWorld({
      seed: 13,
      asteroidCount: 14,
      players: [
        { id: 0, isAi: false, difficulty: 0 },
        { id: 1, isAi: true, difficulty: dif },
      ],
    });
  const low = make(0);
  const high = make(3);
  const lowStart = ownedBy(low, 1);
  const highStart = ownedBy(high, 1);
  for (let t = 0; t < 2500; t++) {
    Sim.step(low, 1 / 30);
    Sim.step(high, 1 / 30);
  }
  assert.ok(
    high.players[1]._aiSends > low.players[1]._aiSends,
    `high-dif actions ${high.players[1]._aiSends} should exceed low-dif ${low.players[1]._aiSends}`,
  );
  const lowGain = ownedBy(low, 1) - lowStart;
  const highGain = ownedBy(high, 1) - highStart;
  assert.ok(highGain > 0, "high difficulty AI should make expansion progress");
  assert.ok(
    lowGain >= 0,
    "low difficulty AI should not lose ground from start",
  );
});

// --- Determinism -------------------------------------------------------------

test("determinism: same seed + config ⇒ identical world after N ticks", () => {
  const cfg = () => ({
    seed: 99,
    asteroidCount: 12,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 2 },
      { id: 2, isAi: true, difficulty: 1 },
    ],
  });
  const wa = createWorld(cfg());
  const wb = createWorld(cfg());
  for (let t = 0; t < 1500; t++) {
    Sim.step(wa, 1 / 30);
    Sim.step(wb, 1 / 30);
  }
  assert.equal(wa.seed.count, wb.seed.count, "seed count diverged");
  assert.equal(wa.status, wb.status, "status diverged");
  for (let i = 0; i < wa.asteroids.length; i++) {
    assert.equal(
      wa.asteroids[i].owner,
      wb.asteroids[i].owner,
      "owner diverged",
    );
  }
  for (let i = 0; i < wa.seed.count; i++) {
    assert.equal(wa.seed.owner[i], wb.seed.owner[i]);
    assert.ok(Math.abs(wa.seed.x[i] - wb.seed.x[i]) < 1e-6);
  }
});

// --- Edge safety -------------------------------------------------------------

test("edge: AI with no rocks and no seedlings no-ops without crash/NaN", () => {
  const w = createWorld({
    seed: 1,
    asteroidCount: 4,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 3 },
    ],
  });
  // strip everything the AI could act on
  for (const a of w.asteroids) a.owner = OWNER_NEUTRAL;
  w.seed.count = 0;
  for (let t = 0; t < 50; t++) updateAi(w, 1 / 30);
  assert.equal(w.seed.count, 0);
  assert.ok(!hasNaN(w.seed));
});

test("edge: AI owns a rock but has zero orbiters ⇒ safe no-op send", () => {
  const w = createWorld({
    seed: 1,
    asteroidCount: 4,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 2 },
    ],
  });
  // give AI a rock with no seedlings of its own
  const rock = w.asteroids.find((a) => a.owner === OWNER_NEUTRAL);
  rock.owner = 1;
  rock.energy = 0;
  // remove all owner-1 seedlings
  const s = w.seed;
  for (let i = s.count - 1; i >= 0; i--)
    if (s.owner[i] === 1) {
      const last = --s.count;
      for (const kk of [
        "x",
        "y",
        "px",
        "py",
        "vx",
        "vy",
        "home",
        "target",
        "owner",
        "energy",
        "strength",
        "orbitAngle",
        "orbitRadius",
        "state",
      ])
        s[kk][i] = s[kk][last];
    }
  assert.doesNotThrow(() => {
    for (let t = 0; t < 200; t++) updateAi(w, 1 / 30);
  });
  assert.ok(!hasNaN(w.seed));
});

test("ai decision timer resets with a fresh world (no leak)", () => {
  // Each world owns its own player objects, so AI timers can't leak between worlds.
  const cfg = () => ({
    seed: 8,
    asteroidCount: 8,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 2 },
    ],
  });
  const w1 = createWorld(cfg());
  assert.equal(
    w1.players[1]._aiCd,
    undefined,
    "fresh world has no AI timer set",
  );
  updateAi(w1, 1 / 30);
  assert.ok(w1.players[1]._aiCd > 0, "timer initialized on first update");
  const w2 = createWorld(cfg());
  assert.equal(w2.players[1]._aiCd, undefined, "second world starts clean");
});
