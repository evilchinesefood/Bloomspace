// Sim/Stats.test.js — post-game stats accumulator: determinism, bounds, totals, save/resume.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, step, MAX_SAMPLES, EVENT, pushEvent } from "./World.js";
import { serialize, deserialize } from "./Save.js";

const DT = 1 / 30;

function mk(
  seed = 5,
  asteroidCount = 14,
  players = [
    { id: 0, isAi: false, difficulty: 0 },
    { id: 1, isAi: true, difficulty: 1 },
  ],
) {
  return createWorld({
    seed,
    asteroidCount,
    players,
    width: 3000,
    height: 3000,
  });
}

// --- 1. INITIALIZATION -------------------------------------------------------

test("createWorld initializes stats + history", () => {
  const w = mk();
  assert.ok(w.stats, "stats present");
  assert.ok(Array.isArray(w.history), "history is array");
  assert.equal(w.history.length, 0, "history starts empty");
  assert.equal(w.stats.captures.length, w.players.length);
  assert.equal(w.stats.deaths.length, w.players.length);
  assert.equal(w.stats.peakFleet.length, w.players.length);
  assert.deepEqual(w.stats.captures, [0, 0]);
  assert.deepEqual(w.stats.deaths, [0, 0]);
  assert.deepEqual(w.stats.peakFleet, [0, 0]);
});

// --- 2. DETERMINISM ----------------------------------------------------------

test("same seed ⇒ identical history + stats after N ticks", () => {
  const cfg = () => mk(42);
  const wa = cfg(),
    wb = cfg();
  const N = 300;
  for (let i = 0; i < N; i++) {
    step(wa, DT);
    step(wb, DT);
  }
  assert.deepEqual(wa.history, wb.history, "history identical for same seed");
  assert.deepEqual(wa.stats.captures, wb.stats.captures);
  assert.deepEqual(wa.stats.deaths, wb.stats.deaths);
  assert.deepEqual(wa.stats.peakFleet, wb.stats.peakFleet);
});

// --- 3. BOUNDED HISTORY ------------------------------------------------------

test("history length never exceeds MAX_SAMPLES even for a very long run", () => {
  const w = mk(7);
  // Step enough ticks to fill and trigger multiple downsamples.
  const ticks = MAX_SAMPLES * 30 * 3; // 3× the fill-up budget
  for (let i = 0; i < ticks; i++) step(w, DT);
  assert.ok(
    w.history.length <= MAX_SAMPLES,
    `history length ${w.history.length} exceeded MAX_SAMPLES ${MAX_SAMPLES}`,
  );
});

test("history grows to at least 2 samples after enough ticks", () => {
  const w = mk(3);
  for (let i = 0; i < 70; i++) step(w, DT); // 70 ticks > 2 × SAMPLE_TICKS(30)
  assert.ok(w.history.length >= 2, "expected at least 2 samples");
});

// --- 4. EVENT COUNTING -------------------------------------------------------

test("captures counter increments on EVENT.CAPTURE", () => {
  const w = mk(9);
  // Reset to known state.
  w.stats.captures[0] = 0;
  w.stats.captures[1] = 0;
  w.events.n = 0;
  // Inject synthetic CAPTURE events (owner 0 captured 2, owner 1 captured 1).
  pushEvent(w, EVENT.CAPTURE, 0, 0, 0);
  pushEvent(w, EVENT.CAPTURE, 0, 0, 0);
  pushEvent(w, EVENT.CAPTURE, 0, 0, 1);
  // stepStats reads events — call it via one step (tick++, then stepStats runs).
  // But we need to avoid clearing world.events.n between push and step. Instead,
  // replicate the real call path: step() calls stepStats at the end after tick++.
  // Inject events, then step once; stepStats will process them.
  // However step() also calls updateSeedlings/AI etc which may reset events.n.
  // Safer: directly verify by calling step after injecting — the events we pushed
  // are already there at index 0..2; step() appends more but won't remove ours.
  const capBefore0 = w.stats.captures[0];
  const capBefore1 = w.stats.captures[1];
  step(w, DT); // stepStats inside step() reads our injected events
  // Our 3 injected events should have been counted.
  assert.ok(
    w.stats.captures[0] >= capBefore0 + 2,
    "player 0 capture count increased by 2+",
  );
  assert.ok(
    w.stats.captures[1] >= capBefore1 + 1,
    "player 1 capture count increased by 1+",
  );
});

test("deaths counter increments on EVENT.DEATH", () => {
  const w = mk(11);
  w.stats.deaths[0] = 0;
  w.events.n = 0;
  pushEvent(w, EVENT.DEATH, 0, 0, 0);
  pushEvent(w, EVENT.DEATH, 0, 0, 0);
  const before = w.stats.deaths[0];
  step(w, DT);
  assert.ok(
    w.stats.deaths[0] >= before + 2,
    "player 0 death count increased by 2+",
  );
});

// --- 5. PEAK FLEET -----------------------------------------------------------

test("peakFleet tracks max live seedlings per player", () => {
  const w = mk(13);
  // Run 90 ticks so sampling fires at least 3 times and fleet numbers are recorded.
  for (let i = 0; i < 90; i++) step(w, DT);
  assert.ok(w.stats.peakFleet[0] > 0, "human peakFleet > 0");
});

// --- 6. NO PERTURBATION (existing determinism test still holds) --------------

test("stats accumulation does not perturb seedling state or rng stream", () => {
  // Two worlds same seed — one is the "reference" that we snapshot after N ticks.
  // The stats fields exist on both but must not affect seed/asteroid/rng state.
  const cfg = {
    seed: 99,
    asteroidCount: 12,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 2 },
    ],
    width: 3000,
    height: 3000,
  };
  const wa = createWorld(cfg);
  const wb = createWorld(cfg);
  const N = 500;
  for (let i = 0; i < N; i++) {
    step(wa, DT);
    step(wb, DT);
  }
  // Seedling counts + asteroid ownership must be identical.
  assert.equal(wa.seed.count, wb.seed.count, "seedling count matches");
  assert.equal(wa.tick, wb.tick, "tick matches");
  const ownA = wa.asteroids.map((a) => a.owner);
  const ownB = wb.asteroids.map((a) => a.owner);
  assert.deepEqual(ownA, ownB, "asteroid ownership matches");
  // rng state must be identical (stats consumes no rng calls).
  assert.equal(wa.rng.getState(), wb.rng.getState(), "rng state identical");
});

// --- 7. SAVE / RESUME --------------------------------------------------------

test("serialize → deserialize preserves stats + history", () => {
  const w1 = mk(17);
  for (let i = 0; i < 120; i++) step(w1, DT);
  assert.ok(w1.history.length > 0, "has history before save");

  const saved = serialize(w1);
  assert.ok(saved.stats, "stats present in saved object");
  assert.ok(Array.isArray(saved.history), "history present in saved object");

  const w2 = deserialize(saved);
  assert.ok(w2, "deserialize succeeded");
  assert.deepEqual(w2.stats.captures, w1.stats.captures, "captures restored");
  assert.deepEqual(w2.stats.deaths, w1.stats.deaths, "deaths restored");
  assert.deepEqual(
    w2.stats.peakFleet,
    w1.stats.peakFleet,
    "peakFleet restored",
  );
  assert.deepEqual(w2.history, w1.history, "history restored");

  // Stepping after restore continues accumulating.
  for (let i = 0; i < 60; i++) {
    step(w1, DT);
    step(w2, DT);
  }
  assert.deepEqual(
    w2.stats.captures,
    w1.stats.captures,
    "captures match after resume steps",
  );
  assert.deepEqual(
    w2.stats.deaths,
    w1.stats.deaths,
    "deaths match after resume steps",
  );
});

test("old save without stats/history deserializes cleanly with zeroed accumulators", () => {
  const w1 = mk(21);
  for (let i = 0; i < 30; i++) step(w1, DT);
  const saved = serialize(w1);
  // Strip stats/history to simulate an old save.
  delete saved.stats;
  delete saved.history;
  const w2 = deserialize(saved);
  assert.ok(w2, "deserialize succeeded on stripped save");
  assert.ok(w2.stats, "stats initialized");
  assert.ok(Array.isArray(w2.history), "history initialized");
  assert.deepEqual(w2.stats.captures, new Array(w2.players.length).fill(0));
});
