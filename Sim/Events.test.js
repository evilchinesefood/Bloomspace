// Events.test.js — the world.events channel: the deterministic contract Render drains each
// frame for FX + audio. Every assertion drives the REAL sanctioned sim functions / step() so
// the channel stays a faithful, load-bearing record (audio relies on exact, ordered triggers).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWorld,
  spawnSeedling,
  EVENT,
  pushEvent,
  OWNER_NEUTRAL,
  STATE,
} from "./World.js";
import { sendSeedlings } from "./Seedlings.js";
import { resolveCombat } from "./Combat.js";
import { checkVictory } from "./Ai.js";
import Sim from "./World.js";

const PLAYERS = [
  { id: 0, isAi: false, difficulty: 0 },
  { id: 1, isAi: true, difficulty: 1 },
];

function mk(seed = 7, count = 20, players = PLAYERS) {
  return createWorld({
    seed,
    asteroidCount: count,
    players,
    width: 2000,
    height: 2000,
  });
}

// All events as plain objects, in order — for sequence/determinism comparisons.
function eventsOf(w) {
  const e = w.events;
  const out = [];
  for (let k = 0; k < e.n; k++)
    out.push({
      type: e.type[k],
      x: e.x[k],
      y: e.y[k],
      x2: e.x2[k],
      y2: e.y2[k],
      owner: e.owner[k],
    });
  return out;
}

// Step until a predicate holds or a guard trips. Like the Seedlings.test helper.
function stepUntil(w, pred, max = 4000) {
  for (let i = 0; i < max; i++) {
    if (pred()) return i;
    Sim.step(w, 1 / 30);
  }
  return -1;
}

const neutralColonizable = (w) =>
  w.asteroids.find(
    (a) => a.owner === OWNER_NEUTRAL && a.kind === "asteroid" && !a.moon,
  );

// events.x/y are Float32Array — compare positions with an f32 tolerance, not strict ===
// (a full-precision JS number won't equal its f32-truncated storage).
const near = (a, b, eps = 1e-2) => Math.abs(a - b) <= eps;

// --- Channel shape ----------------------------------------------------------

test("fresh world has an empty events channel sized to capacity", () => {
  const cap = 256;
  const w = createWorld({ seed: 1, asteroidCount: 8, capacity: cap });
  const e = w.events;
  assert.equal(e.n, 0);
  assert.equal(e.capacity, cap);
  for (const k of ["type", "x", "y", "x2", "y2", "owner"])
    assert.equal(e[k].length, cap, `events.${k} length`);
  assert.equal(
    e.x.length,
    w.seed.x.length,
    "events capacity tracks seed capacity",
  );
});

// --- pushEvent append + overflow --------------------------------------------

test("pushEvent appends, lands fields in the right slots, increments n", () => {
  const w = createWorld({ seed: 1, asteroidCount: 4, capacity: 64 });
  w.events.n = 0;
  pushEvent(w, EVENT.FIRE, 10, 20, 3, 30, 40);
  assert.equal(w.events.n, 1);
  assert.equal(w.events.type[0], EVENT.FIRE);
  assert.equal(w.events.x[0], 10);
  assert.equal(w.events.y[0], 20);
  assert.equal(w.events.owner[0], 3);
  assert.equal(w.events.x2[0], 30);
  assert.equal(w.events.y2[0], 40);
  pushEvent(w, EVENT.SEND, 1, 2, 0);
  assert.equal(w.events.n, 2);
  assert.equal(w.events.type[1], EVENT.SEND);
  assert.equal(w.events.x[1], 1);
  assert.equal(w.events.y[1], 2);
  assert.equal(w.events.owner[1], 0);
  // defaulted aux fields
  assert.equal(w.events.x2[1], 0);
  assert.equal(w.events.y2[1], 0);
});

test("overflow beyond capacity is silently dropped (n never exceeds capacity)", () => {
  const cap = 8;
  const w = createWorld({ seed: 1, asteroidCount: 4, capacity: cap });
  w.events.n = 0;
  for (let i = 0; i < cap + 20; i++) pushEvent(w, EVENT.DEATH, i, i, 0);
  assert.equal(w.events.n, cap, "n clamps at capacity");
  // the first `cap` writes survived (in order), the rest were dropped
  for (let i = 0; i < cap; i++) assert.equal(w.events.x[i], i);
});

// --- DEATH (integration: real death via the sim) ----------------------------

test("a real death emits an EVENT.DEATH at the ship's position", () => {
  // Drive a genuine combat death: two strong enemies co-homed with tiny energy die fast.
  const w = createWorld({
    seed: 3,
    asteroidCount: 1,
    players: [{ id: 0, isAi: false, difficulty: 0 }],
    width: 4000,
    height: 4000,
  });
  w.seed.count = 0; // drop the auto-seeded orbiters
  w.events.n = 0;
  const place = (x, y, owner) => {
    const i = spawnSeedling(w, { home: 0, owner, strength: 90, energy: 4 });
    const s = w.seed;
    s.x[i] = x;
    s.y[i] = y;
    s.px[i] = x;
    s.py[i] = y;
    s.state[i] = STATE.ORBIT;
    return i;
  };
  place(0, 0, 0);
  place(0.2, 0, 1);
  let death = null;
  for (let t = 0; t < 50 && !death; t++) {
    resolveCombat(w, 1 / 30);
    death = eventsOf(w).find((ev) => ev.type === EVENT.DEATH) || null;
  }
  assert.ok(death, "expected at least one DEATH event from combat");
  // plausible coords: the ships sat at ~(0,0)
  assert.ok(
    Math.abs(death.x) < 5 && Math.abs(death.y) < 5,
    "death near the fight",
  );
  assert.ok(
    death.owner === 0 || death.owner === 1,
    "death carries the ship owner",
  );
});

// --- SEND -------------------------------------------------------------------

test("a real dispatch emits one EVENT.SEND at the origin rock with the owner", () => {
  const w = mk();
  const from = w.asteroids.find((a) => a.owner === 0);
  const neutral = neutralColonizable(w);
  w.events.n = 0;
  const sent = sendSeedlings(w, from.id, neutral.id, 1, 0);
  assert.ok(sent >= 1, "expected a real dispatch");
  const sends = eventsOf(w).filter((ev) => ev.type === EVENT.SEND);
  assert.equal(sends.length, 1, "exactly one SEND per dispatch");
  assert.equal(sends[0].owner, 0);
  assert.ok(near(sends[0].x, from.x), "SEND at origin rock x");
  assert.ok(near(sends[0].y, from.y), "SEND at origin rock y");
});

test("a 0-send (floored fraction) emits no SEND event", () => {
  const w = mk();
  const from = w.asteroids.find((a) => a.owner === 0);
  const neutral = neutralColonizable(w);
  w.events.n = 0;
  const sent = sendSeedlings(w, from.id, neutral.id, 0, 0);
  assert.equal(sent, 0);
  assert.equal(
    eventsOf(w).filter((ev) => ev.type === EVENT.SEND).length,
    0,
    "no SEND on a 0-send",
  );
});

// --- CAPTURE (neutral colonization) -----------------------------------------

test("neutral colonization emits one EVENT.CAPTURE with the new owner", () => {
  const w = mk();
  const from = w.asteroids.find((a) => a.owner === 0);
  const neutral = neutralColonizable(w);
  const sent = sendSeedlings(w, from.id, neutral.id, 1, 0);
  assert.ok(sent >= 1);
  w.events.n = 0; // ignore the SEND already emitted; watch only the arrival
  const arrived = stepUntil(w, () => neutral.owner === 0);
  assert.notEqual(arrived, -1, "never colonized");
  const caps = eventsOf(w).filter(
    (ev) =>
      ev.type === EVENT.CAPTURE &&
      near(ev.x, neutral.x) &&
      near(ev.y, neutral.y),
  );
  assert.equal(caps.length, 1, "exactly one CAPTURE for the colonized rock");
  assert.equal(caps[0].owner, 0, "CAPTURE carries the NEW owner");
});

// --- WIN / LOSE transition latches ------------------------------------------

test("victory transition emits exactly one WIN, not repeatedly across steps", () => {
  const w = createWorld({
    seed: 2,
    asteroidCount: 5,
    players: [{ id: 0, isAi: false, difficulty: 0 }],
  });
  for (const a of w.asteroids) a.owner = 0;
  w.events.n = 0;
  checkVictory(w);
  assert.equal(w.status, "won");
  let wins = eventsOf(w).filter((ev) => ev.type === EVENT.WIN).length;
  assert.equal(wins, 1, "one WIN on the transition");
  // further checks/steps must not re-emit (status latches)
  for (let t = 0; t < 20; t++) checkVictory(w);
  wins = eventsOf(w).filter((ev) => ev.type === EVENT.WIN).length;
  assert.equal(wins, 1, "WIN fires once and never again");
});

test("loss transition emits exactly one LOSE", () => {
  const w = mk(3, 4);
  for (const a of w.asteroids) a.owner = 1;
  w.seed.count = 0; // wipe player 0's seedlings too
  w.events.n = 0;
  checkVictory(w);
  assert.equal(w.status, "lost");
  const loses = eventsOf(w).filter((ev) => ev.type === EVENT.LOSE);
  assert.equal(loses.length, 1, "one LOSE on the transition");
  // no WIN snuck in
  assert.equal(eventsOf(w).filter((ev) => ev.type === EVENT.WIN).length, 0);
  for (let t = 0; t < 20; t++) checkVictory(w);
  assert.equal(
    eventsOf(w).filter((ev) => ev.type === EVENT.LOSE).length,
    1,
    "LOSE fires once",
  );
});

// --- Determinism (the load-bearing guarantee for audio) ---------------------

test("two worlds, same seed, stepped N times ⇒ identical event sequences", () => {
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
  const seqA = [];
  const seqB = [];
  // Drain per-step (as Render would per frame) so we compare the full ordered stream, not
  // just a final snapshot that overflow could have clipped.
  for (let t = 0; t < 1500; t++) {
    Sim.step(wa, 1 / 30);
    seqA.push(...eventsOf(wa));
    wa.events.n = 0;
    Sim.step(wb, 1 / 30);
    seqB.push(...eventsOf(wb));
    wb.events.n = 0;
  }
  assert.ok(seqA.length > 0, "expected some events over the run");
  assert.deepEqual(seqA, seqB, "event sequences diverged for identical seeds");
});
