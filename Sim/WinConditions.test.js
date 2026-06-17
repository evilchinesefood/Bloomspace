import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, WORLD_STATUS, EVENT } from "./World.js";
import { checkVictory } from "./Ai.js";

// Habitable bodies on the map (the domination/time-cap denominator).
const habitable = (w) => w.asteroids.filter((a) => a.habitable && !a.dead);

// Did the per-step event channel record an event of `type` since the last drain?
const hasEvent = (w, type) => {
  for (let i = 0; i < w.events.n; i++)
    if (w.events.type[i] === type) return true;
  return false;
};

// Both players keep presence so ELIMINATION can't fire and pre-empt domination/time-cap:
// give each at least one habitable rock; createWorld also seeds each player's home orbiters.
function ensurePresence(w) {
  const hab = habitable(w);
  hab[0].owner = 0;
  hab[hab.length - 1].owner = 1;
}

// --- 1. Default (no winConfig) = elimination unchanged ------------------------

test("default winConfig reproduces pure elimination (win path)", () => {
  const w = createWorld({
    seed: 1,
    asteroidCount: 6,
    players: [{ id: 0, isAi: false, difficulty: 0 }],
  });
  // No winConfig passed → defaults to elimination, no time limit.
  assert.equal(w.winConfig.mode, "elimination");
  assert.equal(w.winConfig.timeLimitSecs, 0);
  for (const a of w.asteroids) a.owner = 0;
  checkVictory(w);
  assert.equal(w.status, WORLD_STATUS.WON);
  assert.ok(hasEvent(w, EVENT.WIN));
});

test("default winConfig reproduces pure elimination (loss path)", () => {
  const w = createWorld({
    seed: 3,
    asteroidCount: 4,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 1 },
    ],
  });
  for (const a of w.asteroids) a.owner = 1;
  w.seed.count = 0; // wipe every seedling incl. player 0's
  checkVictory(w);
  assert.equal(w.status, WORLD_STATUS.LOST);
  assert.ok(hasEvent(w, EVENT.LOSE));
});

test("default winConfig: domination & time-cap never trigger", () => {
  const w = createWorld({
    seed: 4,
    asteroidCount: 8,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 1 },
    ],
  });
  // Player 0 holds EVERY habitable body — would dominate if domination were active.
  for (const a of habitable(w)) a.owner = 0;
  // But keep an AI seedling alive so elimination also can't fire.
  let aiAlive = false;
  for (let i = 0; i < w.seed.count; i++)
    if (w.seed.owner[i] === 1) aiAlive = true;
  assert.ok(aiAlive, "fixture needs a living AI seedling");
  w.tick = 100000; // way past any plausible cap
  for (let t = 0; t < 25 * 30 + 10; t++) checkVictory(w);
  assert.equal(w.status, WORLD_STATUS.PLAYING);
  for (const p of w.players) assert.equal(p._domTicks ?? 0, 0);
});

// --- 2. Domination win/loss --------------------------------------------------

test("domination: player 0 holds >= pct for the duration ⇒ WON", () => {
  const w = createWorld({
    seed: 5,
    asteroidCount: 10,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 1 },
    ],
    winConfig: { mode: "domination", dominationPct: 0.6, dominationSecs: 5 },
  });
  const hab = habitable(w);
  // Player 0 owns 80% of habitable bodies; AI keeps one (presence → no elimination).
  hab.forEach((a, i) => (a.owner = i < hab.length - 1 ? 0 : 1));
  assert.ok(
    habitable(w).filter((a) => a.owner === 0).length / hab.length >= 0.6,
  );
  const need = 5 * 30;
  for (let t = 0; t < need - 1; t++) checkVictory(w);
  assert.equal(w.status, WORLD_STATUS.PLAYING, "not yet — duration not met");
  checkVictory(w); // the Nth qualifying tick
  assert.equal(w.status, WORLD_STATUS.WON);
  assert.ok(hasEvent(w, EVENT.WIN));
});

test("domination: an AI holds >= pct for the duration ⇒ LOST", () => {
  const w = createWorld({
    seed: 6,
    asteroidCount: 10,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 1 },
    ],
    winConfig: { mode: "domination", dominationPct: 0.6, dominationSecs: 5 },
  });
  const hab = habitable(w);
  hab.forEach((a, i) => (a.owner = i < hab.length - 1 ? 1 : 0)); // AI dominates
  const need = 5 * 30;
  for (let t = 0; t < need; t++) checkVictory(w);
  assert.equal(w.status, WORLD_STATUS.LOST);
  assert.ok(hasEvent(w, EVENT.LOSE));
});

// --- 3. Domination requires CONTINUOUS hold ----------------------------------

test("domination resets when the hold drops below threshold", () => {
  const w = createWorld({
    seed: 7,
    asteroidCount: 10,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 1 },
    ],
    winConfig: { mode: "domination", dominationPct: 0.6, dominationSecs: 5 },
  });
  const hab = habitable(w);
  const dominate = () =>
    hab.forEach((a, i) => (a.owner = i < hab.length - 1 ? 0 : 1));
  const drop = () => hab.forEach((a, i) => (a.owner = i < 2 ? 0 : 1)); // p0 < 60%

  dominate();
  const need = 5 * 30;
  // Hold for almost the full duration (not enough to win).
  for (let t = 0; t < need - 5; t++) checkVictory(w);
  assert.equal(w.status, WORLD_STATUS.PLAYING);
  assert.ok(w.players[0]._domTicks > 0);

  // Drop below threshold for one tick → counter must reset.
  drop();
  checkVictory(w);
  assert.equal(
    w.players[0]._domTicks,
    0,
    "counter reset on dropping below pct",
  );
  assert.equal(w.status, WORLD_STATUS.PLAYING);

  // Re-dominate: must hold the FULL duration again, no premature win.
  dominate();
  for (let t = 0; t < need - 1; t++) checkVictory(w);
  assert.equal(w.status, WORLD_STATUS.PLAYING, "no premature win after reset");
  checkVictory(w);
  assert.equal(w.status, WORLD_STATUS.WON);
});

// --- 4. Time-cap true draw ---------------------------------------------------

test("time-cap: deadlocked equal territory ⇒ DRAW (no event)", () => {
  const w = createWorld({
    seed: 8,
    asteroidCount: 8,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 1 },
    ],
    winConfig: { mode: "elimination", timeLimitSecs: 300 },
  });
  const hab = habitable(w);
  // Split habitable bodies EVENLY: half to p0, half to AI (drop any odd remainder to neutral).
  const half = Math.floor(hab.length / 2);
  hab.forEach((a, i) => {
    a.owner = i < half ? 0 : i < 2 * half ? 1 : -1;
  });
  const p0 = hab.filter((a) => a.owner === 0).length;
  const p1 = hab.filter((a) => a.owner === 1).length;
  assert.equal(p0, p1, "fixture must be an exact territory tie");
  w.events.n = 0; // drain
  w.tick = 300 * 30; // reach the cap
  checkVictory(w);
  assert.equal(w.status, WORLD_STATUS.DRAW);
  assert.ok(!hasEvent(w, EVENT.WIN), "draw emits no WIN");
  assert.ok(!hasEvent(w, EVENT.LOSE), "draw emits no LOSE");
});

// --- 5. Time-cap decisive ----------------------------------------------------

test("time-cap: player 0 strictly leads ⇒ WON (emits WIN)", () => {
  const w = createWorld({
    seed: 9,
    asteroidCount: 8,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 1 },
    ],
    winConfig: { mode: "elimination", timeLimitSecs: 300 },
  });
  const hab = habitable(w);
  // p0 gets the majority, AI one (presence), rest neutral → p0 strictly leads.
  hab.forEach((a, i) => (a.owner = i < hab.length - 1 ? 0 : 1));
  w.events.n = 0;
  w.tick = 300 * 30;
  checkVictory(w);
  assert.equal(w.status, WORLD_STATUS.WON);
  assert.ok(hasEvent(w, EVENT.WIN));
});

test("time-cap: an AI strictly leads ⇒ LOST (emits LOSE)", () => {
  const w = createWorld({
    seed: 10,
    asteroidCount: 8,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 1 },
    ],
    winConfig: { mode: "elimination", timeLimitSecs: 300 },
  });
  const hab = habitable(w);
  hab.forEach((a, i) => (a.owner = i < hab.length - 1 ? 1 : 0)); // AI strictly leads
  w.events.n = 0;
  w.tick = 300 * 30;
  checkVictory(w);
  assert.equal(w.status, WORLD_STATUS.LOST);
  assert.ok(hasEvent(w, EVENT.LOSE));
});

test("time-cap: not reached before the cap tick", () => {
  const w = createWorld({
    seed: 11,
    asteroidCount: 8,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 1 },
    ],
    winConfig: { mode: "elimination", timeLimitSecs: 300 },
  });
  ensurePresence(w);
  w.tick = 300 * 30 - 1; // one tick short
  checkVictory(w);
  assert.equal(w.status, WORLD_STATUS.PLAYING);
});

// --- 6. Multi-AID time-cap draw: top tied among AIs ⇒ DRAW -------------------

test("time-cap: two AIs tie above player 0 ⇒ DRAW", () => {
  const w = createWorld({
    seed: 12,
    asteroidCount: 12,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 1 },
      { id: 2, isAi: true, difficulty: 1 },
    ],
    winConfig: { mode: "elimination", timeLimitSecs: 300 },
  });
  const hab = habitable(w);
  // p0 = 1, AI1 = 3, AI2 = 3 (tie for the lead) → stalemate.
  hab.forEach((a, i) => {
    if (i === 0) a.owner = 0;
    else if (i <= 3) a.owner = 1;
    else if (i <= 6) a.owner = 2;
    else a.owner = -1;
  });
  assert.equal(hab.filter((a) => a.owner === 1).length, 3);
  assert.equal(hab.filter((a) => a.owner === 2).length, 3);
  w.events.n = 0;
  w.tick = 300 * 30;
  checkVictory(w);
  assert.equal(w.status, WORLD_STATUS.DRAW);
  assert.ok(!hasEvent(w, EVENT.WIN));
  assert.ok(!hasEvent(w, EVENT.LOSE));
});

// --- Serializability of winConfig + counters ---------------------------------

test("winConfig + _domTicks are plain-JSON-serializable", () => {
  const w = createWorld({
    seed: 13,
    asteroidCount: 8,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 1 },
    ],
    winConfig: { mode: "domination", dominationSecs: 2 },
  });
  ensurePresence(w);
  checkVictory(w); // initializes _domTicks on every player
  const wcRound = JSON.parse(JSON.stringify(w.winConfig));
  assert.deepEqual(wcRound, w.winConfig);
  for (const p of w.players) assert.equal(typeof p._domTicks, "number");
});
