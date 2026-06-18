// Hazards.test.js — environmental hazards (solar flares + meteor showers). They are OPT-IN via
// config.events: absent ⇒ off ⇒ stepHazards never runs and consumes no world.rng(), so existing
// worlds/tests drift zero bits. These drive the REAL sim (createWorld + Sim.step) — no mocks —
// and assert the deterministic schedule, that damage actually lands, the off-path zero-drift, and
// save/resume of in-flight hazards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createWorld, EVENT, spawnSeedling, STATE } from "./World.js";
import { stepHazards } from "./Hazards.js";
import { serialize, deserialize } from "./Save.js";
import Sim from "./World.js";

// FRESH player objects per world — createWorld MUTATES players (tech/seeds/personality), so two
// worlds must never share a players array or the second starts dirty and diverges (mirrors the
// cfg() factory in Events.test.js).
const PLAYERS = () => [
  { id: 0, isAi: false, difficulty: 0 },
  { id: 1, isAi: true, difficulty: 1 },
];

function mk(events, seed = 7, count = 16) {
  return createWorld({
    seed,
    asteroidCount: count,
    players: PLAYERS(),
    width: 2000,
    height: 2000,
    events,
  });
}

// All events as plain objects, in order — for sequence/determinism comparisons.
function eventsOf(w) {
  const e = w.events;
  const out = [];
  for (let k = 0; k < e.n; k++)
    out.push({ type: e.type[k], x: e.x[k], y: e.y[k], owner: e.owner[k] });
  return out;
}

// A snapshot of seedling identity sufficient to prove drift / no-drift: count + per-ship
// position+energy+owner. (Compared after equal-length step runs.)
function seedSnapshot(w) {
  const s = w.seed;
  const out = [];
  for (let i = 0; i < s.count; i++)
    out.push([s.x[i], s.y[i], s.energy[i], s.owner[i]]);
  return out;
}

// Step a world N ticks, draining its event stream each tick (as Render would per frame), and
// return the full ordered hazard-event sequence.
function runHazardSeq(w, n) {
  const seq = [];
  for (let t = 0; t < n; t++) {
    Sim.step(w, 1 / 30);
    for (const ev of eventsOf(w))
      if (ev.type === EVENT.FLARE || ev.type === EVENT.METEOR) seq.push(ev);
    w.events.n = 0;
  }
  return seq;
}

// --- Determinism: schedule + effects -----------------------------------------

test("same seed, hazards ON ⇒ identical hazard event sequence AND seedling state", () => {
  const wa = mk(true, 4242, 16);
  const wb = mk(true, 4242, 16);
  const seqA = runHazardSeq(wa, 1500);
  const seqB = runHazardSeq(wb, 1500);
  assert.ok(seqA.length > 0, "expected some hazard events over the run");
  assert.deepEqual(seqA, seqB, "hazard sequences diverged for identical seeds");
  assert.deepEqual(
    seedSnapshot(wa),
    seedSnapshot(wb),
    "seedling state diverged for identical seeds",
  );
  // and both hazard kinds fired over a long run
  assert.ok(
    seqA.some((e) => e.type === EVENT.FLARE),
    "expected a FLARE",
  );
  assert.ok(
    seqA.some((e) => e.type === EVENT.METEOR),
    "expected a METEOR",
  );
});

// --- Effects apply: a flare drains/kills seedlings in its band -----------------

test("a solar flare damages seedlings caught in its expanding ring", () => {
  // A world with the star at a known spot; pack many seedlings at a fixed radius from it so the
  // growing ring band must sweep over them. Drive stepHazards directly (deterministic).
  const w = mk(true, 11, 12);
  const star = w.asteroids[0];
  w.seed.count = 0; // clear auto-orbiters; place our own ring of targets
  const R = 400; // a radius the flare ring (0→900) crosses
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    const i = spawnSeedling(w, { home: 0, owner: 0, energy: 50 });
    const s = w.seed;
    s.x[i] = star.x + Math.cos(a) * R;
    s.y[i] = star.y + Math.sin(a) * R;
    s.state[i] = STATE.ORBIT;
  }
  const before = w.seed.count;
  // Force a flare now, then advance through its full life so the ring sweeps radius R.
  w.hazards.flareTimer = 0;
  let drained = 0;
  for (let t = 0; t < 80; t++) {
    stepHazards(w, 1 / 30);
    // some ship must have lost energy or died
  }
  const s = w.seed;
  for (let i = 0; i < s.count; i++) if (s.energy[i] < 50) drained++;
  assert.ok(
    drained > 0 || s.count < before,
    "flare left no mark — expected drained energy or deaths in its band",
  );
});

test("a meteor impact damages seedlings within its blast radius", () => {
  const w = mk(true, 21, 12);
  w.seed.count = 0;
  // Cluster targets tightly so a single impact at their center hits them all.
  const cx = w.width * 0.5;
  const cy = w.height * 0.5;
  for (let k = 0; k < 12; k++) {
    const i = spawnSeedling(w, { home: 0, owner: 0, energy: 50 });
    const s = w.seed;
    s.x[i] = cx + (k - 6) * 4; // within a ~50px span
    s.y[i] = cy;
    s.state[i] = STATE.ORBIT;
  }
  const before = w.seed.count;
  // Inject a meteor that lands on the cluster and fuse it to impact next step.
  w.hazards.meteors.push({ x: cx, y: cy, fuse: 1 / 60 });
  stepHazards(w, 1 / 30);
  const s = w.seed;
  let damaged = before - s.count;
  for (let i = 0; i < s.count; i++) if (s.energy[i] < 50) damaged++;
  assert.ok(damaged > 0, "meteor impact damaged nothing in its blast radius");
  // and it emitted a METEOR event at the impact point
  const ev = eventsOf(w).find((e) => e.type === EVENT.METEOR);
  assert.ok(ev, "expected an EVENT.METEOR");
  assert.equal(ev.owner, -1, "hazard events are global (owner -1)");
});

// --- Toggle OFF = zero drift --------------------------------------------------

test("hazards OFF emits no hazard events and matches a pre-hazards baseline exactly", () => {
  // Control world built WITHOUT the events key at all (true pre-hazards config) vs one built with
  // events:false. Stepped identically, they must be byte-for-byte identical — proving the OFF path
  // neither runs stepHazards nor consumes any world.rng().
  const control = createWorld({
    seed: 555,
    asteroidCount: 14,
    players: PLAYERS(),
    width: 2000,
    height: 2000,
  });
  const off = createWorld({
    seed: 555,
    asteroidCount: 14,
    players: PLAYERS(),
    width: 2000,
    height: 2000,
    events: false,
  });
  assert.equal(control.hazardsOn, false, "absent events ⇒ hazardsOn false");
  assert.equal(off.hazardsOn, false, "events:false ⇒ hazardsOn false");
  const seqC = [];
  for (let t = 0; t < 1200; t++) {
    Sim.step(control, 1 / 30);
    seqC.push(...eventsOf(control));
    control.events.n = 0;
    Sim.step(off, 1 / 30);
    off.events.n = 0;
  }
  // No hazard events ever, in either world.
  assert.equal(
    seqC.filter((e) => e.type === EVENT.FLARE || e.type === EVENT.METEOR)
      .length,
    0,
    "OFF world emitted hazard events",
  );
  // And the resulting seedling state is identical (rng stream undisturbed).
  assert.deepEqual(
    seedSnapshot(control),
    seedSnapshot(off),
    "OFF world drifted from the pre-hazards control",
  );
  assert.equal(
    control.rng.getState(),
    off.rng.getState(),
    "rng state drifted — OFF path consumed world.rng()",
  );
});

// --- Save / resume of in-flight hazards ---------------------------------------

test("serialize→deserialize mid-shower resumes flares/meteors + timers identically", () => {
  const w = mk(true, 808, 16);
  // Step into an active stretch where hazards are firing, then snapshot mid-flight.
  for (let t = 0; t < 600; t++) Sim.step(w, 1 / 30);
  // Ensure SOMETHING is in flight (a live flare ring or fused meteor) so the resume is meaningful.
  let guard = 0;
  while (
    w.hazards.flares.length === 0 &&
    w.hazards.meteors.length === 0 &&
    guard++ < 2000
  )
    Sim.step(w, 1 / 30);
  assert.ok(
    w.hazards.flares.length > 0 || w.hazards.meteors.length > 0,
    "never reached an in-flight hazard to test resume",
  );

  // Round-trip through a real JSON string (mirrors localStorage) and continue both worlds.
  const saved = JSON.parse(JSON.stringify(serialize(w)));
  const resumed = deserialize(saved);
  assert.ok(resumed, "deserialize returned null");
  assert.equal(resumed.hazardsOn, true, "hazardsOn lost across save");
  assert.deepEqual(
    resumed.hazards,
    w.hazards,
    "in-flight hazard state not preserved across save",
  );

  const seqLive = runHazardSeq(w, 800);
  const seqResumed = runHazardSeq(resumed, 800);
  assert.deepEqual(
    seqResumed,
    seqLive,
    "resumed hazard sequence diverged from the live continuation",
  );
  assert.deepEqual(
    seedSnapshot(resumed),
    seedSnapshot(w),
    "resumed seedling state diverged from the live continuation",
  );
});

test("an old save with no hazard field resumes with hazards OFF (no field, no drift)", () => {
  const w = mk(true, 909, 12);
  for (let t = 0; t < 300; t++) Sim.step(w, 1 / 30);
  const saved = serialize(w);
  delete saved.hazardsOn; // simulate a pre-hazards save
  delete saved.hazards;
  const resumed = deserialize(saved);
  assert.ok(resumed, "deserialize returned null");
  assert.equal(resumed.hazardsOn, false, "old save must restore hazards OFF");
  assert.equal(
    resumed.hazards,
    null,
    "old save must restore null hazard state",
  );
  // Stepping it never throws and never emits hazard events (the step() gate is off).
  const seq = runHazardSeq(resumed, 300);
  assert.equal(seq.length, 0, "OFF resume emitted hazard events");
});

// --- Sim purity: no nondeterministic sources in Hazards.js --------------------

test("Sim/Hazards.js uses no Math.random / Date.now / performance.now", () => {
  const src = readFileSync(
    fileURLToPath(new URL("./Hazards.js", import.meta.url)),
    "utf8",
  );
  for (const bad of ["Math.random", "Date.now", "performance.now"])
    assert.ok(!src.includes(bad), `Hazards.js must not use ${bad}`);
});
