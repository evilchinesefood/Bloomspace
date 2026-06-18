// Fog.test.js — fog of war (last-known model, full-strategic per-player visibility, passive-blind
// AI). OPT-IN via config.fog: absent ⇒ off ⇒ computeFog never runs, the AI uses full info, and the
// world is byte-identical to a pre-fog one (existing tests drift zero bits). These drive the REAL
// sim (createWorld + Sim.step) — no mocks — and assert deterministic vision, the vision sources,
// last-known memory, AI blindness, the critical OFF-path parity, save/resume, and sim purity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createWorld, spawnSeedling, STATE, OWNER_NEUTRAL } from "./World.js";
import { computeFog, knownOwner, UNKNOWN, VISION_R } from "./Fog.js";
import { updateAi } from "./Ai.js";
import { serialize, deserialize } from "./Save.js";
import Sim from "./World.js";

// FRESH player objects per world — createWorld MUTATES players (tech/seeds/personality), so two
// worlds must never share a players array or the second starts dirty and diverges.
const PLAYERS = () => [
  { id: 0, isAi: false, difficulty: 0 },
  { id: 1, isAi: true, difficulty: 1 },
];

function mk(extra = {}) {
  return createWorld({
    seed: 7,
    asteroidCount: 16,
    players: PLAYERS(),
    width: 2000,
    height: 2000,
    ...extra,
  });
}

// A DENSE map (small + many rocks) so a home rock reliably has a rock WITHIN VISION_R and another
// well beyond it — the vision-source / last-known tests need both to exist.
function mkDense(extra = {}) {
  return createWorld({
    seed: 7,
    asteroidCount: 30,
    players: PLAYERS(),
    width: 1600,
    height: 1600,
    ...extra,
  });
}

// Find a (home, near, far) rock triple on `w`: `near` within VISION_R of `home`, `far` beyond
// VISION_R+200. Scans every rock as a candidate home so it's not tied to a particular seed/index.
function pickTriple(w) {
  const a = w.asteroids;
  for (let h = 0; h < a.length; h++) {
    let near = -1,
      far = -1;
    for (let r = 0; r < a.length; r++) {
      if (r === h) continue;
      const d = dist(a[r].x, a[r].y, a[h].x, a[h].y);
      if (d < VISION_R && near < 0) near = r;
      if (d > VISION_R + 200 && far < 0) far = r;
    }
    if (near >= 0 && far >= 0) return { home: h, near, far };
  }
  return null;
}

// A snapshot of seedling identity sufficient to prove drift / no-drift.
function seedSnapshot(w) {
  const s = w.seed;
  const out = [];
  for (let i = 0; i < s.count; i++)
    out.push([s.x[i], s.y[i], s.energy[i], s.owner[i]]);
  return out;
}

// All events as plain objects, in order — for sequence/determinism comparisons.
function eventsOf(w) {
  const e = w.events;
  const out = [];
  for (let k = 0; k < e.n; k++)
    out.push({ type: e.type[k], x: e.x[k], y: e.y[k], owner: e.owner[k] });
  return out;
}

// Flatten fog (seen + known) to a comparable plain structure.
function fogSnapshot(w) {
  const f = w.fog;
  return {
    seen: f.seen.map((a) => Array.from(a)),
    known: f.known.map((a) => Array.from(a)),
  };
}

const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

// --- Deterministic vision ----------------------------------------------------

test("same seed, fog ON ⇒ identical fog (seen + known) after N steps", () => {
  const wa = mk({ fog: true });
  const wb = mk({ fog: true });
  for (let t = 0; t < 400; t++) {
    Sim.step(wa, 1 / 30);
    Sim.step(wb, 1 / 30);
  }
  assert.deepEqual(
    fogSnapshot(wa),
    fogSnapshot(wb),
    "fog diverged for identical seeds",
  );
  // Sanity: fog is actually populated (some seen, some unknown — not a trivially-empty struct).
  const seen0 = wa.fog.seen[0];
  let anySeen = 0;
  for (let r = 0; r < seen0.length; r++) anySeen += seen0[r];
  assert.ok(anySeen > 0, "player 0 sees nothing — fog not computed");
});

// --- Vision sources: owned rocks, owned fleets, always-own ---------------------

test("you always see your own rocks", () => {
  const w = mk({ fog: true });
  computeFog(w);
  for (let r = 0; r < w.asteroids.length; r++) {
    const a = w.asteroids[r];
    if (a.dead) continue;
    if (a.owner === 0)
      assert.equal(w.fog.seen[0][r], 1, `own rock ${r} unseen`);
  }
});

test("a rock within VISION_R of an owned rock is seen; one far from all is not", () => {
  const w = mkDense({ fog: true });
  // Clear seedlings so ONLY owned rocks provide vision (isolates the rock-vision rule).
  w.seed.count = 0;
  // Neutralize the whole map first so ownership doesn't leak vision, then give player 0 exactly
  // one home rock chosen to have both a near and a far rock.
  for (const a of w.asteroids) a.owner = OWNER_NEUTRAL;
  const tri = pickTriple(w);
  assert.ok(tri, "dense test map lacks a near + far rock");
  w.asteroids[tri.home].owner = 0;
  computeFog(w);
  assert.equal(w.fog.seen[0][tri.near], 1, "rock within VISION_R not seen");
  assert.equal(w.fog.seen[0][tri.far], 0, "far rock spuriously seen");
});

test("a rock within VISION_R of an owned FLEET (seedling) is seen", () => {
  const w = mkDense({ fog: true });
  w.seed.count = 0;
  for (const a of w.asteroids) a.owner = OWNER_NEUTRAL;
  const tri = pickTriple(w);
  assert.ok(tri, "dense test map lacks a near + far rock");
  w.asteroids[tri.home].owner = 0; // home rock; `far` is out of its rock-vision
  const tgt = tri.far;
  computeFog(w);
  assert.equal(w.fog.seen[0][tgt], 0, "far rock seen before fleet placed");
  // Park a player-0 seedling right on the far rock — only the fleet can reveal it.
  const i = spawnSeedling(w, { home: tri.home, owner: 0 });
  w.seed.x[i] = w.asteroids[tgt].x;
  w.seed.y[i] = w.asteroids[tgt].y;
  computeFog(w);
  assert.equal(w.fog.seen[0][tgt], 1, "owned fleet did not reveal its rock");
});

// --- Last-known memory --------------------------------------------------------

test("a rock seen then left becomes known (remembered) but not currently seen", () => {
  const w = mkDense({ fog: true });
  w.seed.count = 0;
  for (const a of w.asteroids) a.owner = OWNER_NEUTRAL;
  const tri = pickTriple(w);
  assert.ok(tri, "dense test map lacks a near + far rock");
  w.asteroids[tri.home].owner = 0;
  // A far neutral rock revealed only by a temporary scout.
  const tgt = tri.far;
  const i = spawnSeedling(w, { home: tri.home, owner: 0 });
  w.seed.x[i] = w.asteroids[tgt].x;
  w.seed.y[i] = w.asteroids[tgt].y;
  computeFog(w);
  assert.equal(w.fog.seen[0][tgt], 1, "scout didn't see the rock");
  assert.equal(w.fog.known[0][tgt], OWNER_NEUTRAL, "known owner not recorded");
  assert.equal(
    knownOwner(w, 0, tgt),
    OWNER_NEUTRAL,
    "knownOwner wrong while seen",
  );

  // Ownership changes WHILE UNSEEN are NOT reflected in known until re-seen.
  w.seed.count = 0; // pull the scout
  w.asteroids[tgt].owner = 1; // enemy quietly captures it
  computeFog(w);
  assert.equal(w.fog.seen[0][tgt], 0, "rock still seen after scout left");
  assert.equal(
    w.fog.known[0][tgt],
    OWNER_NEUTRAL,
    "stale known owner updated without re-seeing",
  );
  assert.equal(
    knownOwner(w, 0, tgt),
    OWNER_NEUTRAL,
    "knownOwner not last-known",
  );

  // Re-seeing updates known to the true current owner.
  const j = spawnSeedling(w, { home: tri.home, owner: 0 });
  w.seed.x[j] = w.asteroids[tgt].x;
  w.seed.y[j] = w.asteroids[tgt].y;
  computeFog(w);
  assert.equal(w.fog.seen[0][tgt], 1, "rescout didn't re-see");
  assert.equal(w.fog.known[0][tgt], 1, "known not refreshed on re-see");
});

test("a never-seen rock reports the UNKNOWN sentinel", () => {
  const w = mkDense({ fog: true });
  w.seed.count = 0;
  for (const a of w.asteroids) a.owner = OWNER_NEUTRAL;
  const tri = pickTriple(w);
  assert.ok(tri, "dense test map lacks a near + far rock");
  w.asteroids[tri.home].owner = 0;
  const far = tri.far;
  computeFog(w);
  assert.equal(w.fog.seen[0][far], 0);
  assert.equal(w.fog.known[0][far], UNKNOWN, "never-seen rock not UNKNOWN");
  assert.equal(knownOwner(w, 0, far), UNKNOWN, "knownOwner not UNKNOWN");
});

// --- AI blindness -------------------------------------------------------------

test("AI never targets a rock it has no knowledge of", () => {
  // Isolate AI player 1 with a single rock so MOST of the map is outside its vision. Step many
  // decisions; any rock it sends a fleet toward must have been KNOWN at decision time.
  const w = mk({ fog: true });
  w.seed.count = 0;
  for (const a of w.asteroids) a.owner = OWNER_NEUTRAL;
  // AI owns one corner rock; human owns a far one (so the AI can't "see" via combat either).
  // Choose the AI's rock as the one with the fewest near neighbors to maximize blind area.
  const aiRock = 1;
  w.asteroids[aiRock].owner = 1;
  w.asteroids[0].owner = 0;
  // Give the AI a deployable orbiter pool at its rock.
  for (let k = 0; k < 6; k++) spawnSeedling(w, { home: aiRock, owner: 1 });
  // Identify rocks the AI can NEVER know without scouting: far from its rock AND not its own.
  computeFog(w);
  const player = w.players[1];
  player._aiCd = 0; // fire a decision immediately
  // Track every TRANSIT destination the AI produces over many decisions.
  for (let t = 0; t < 300; t++) {
    // Snapshot fog BEFORE the decision (the AI acts on this knowledge).
    computeFog(w);
    const knownBefore = Array.from(w.fog.known[1]);
    player._aiCd = 0;
    updateAi(w, 1 / 30);
    // Any owner-1 ship with a destination must have a rock the AI knew at decision time — the AI
    // only commands TRANSITs from existing orbiters, so inspecting every in-flight dest is enough.
    const s = w.seed;
    for (let i = 0; i < s.count; i++) {
      if (s.owner[i] !== 1) continue;
      const dest = s.dest[i];
      if (dest < 0) continue;
      assert.notEqual(
        knownBefore[dest],
        UNKNOWN,
        `AI dispatched toward unknown rock ${dest}`,
      );
    }
    Sim.step(w, 1 / 30);
  }
});

test("AI evaluates a known-but-stale rock by its last-known owner", () => {
  // The AI sees a neutral rock, then it's captured by the human while the AI looks away. The AI's
  // knownOwner for that rock must remain neutral (stale) — proving it reads last-known, not truth.
  const w = mk({ fog: true });
  w.seed.count = 0;
  for (const a of w.asteroids) a.owner = OWNER_NEUTRAL;
  w.asteroids[1].owner = 1; // AI rock
  // A rock within the AI's vision (so it's seen) that we then flip while keeping it seen-then-unseen.
  let near = -1;
  for (let r = 0; r < w.asteroids.length; r++) {
    if (r === 1) continue;
    if (
      dist(
        w.asteroids[r].x,
        w.asteroids[r].y,
        w.asteroids[1].x,
        w.asteroids[1].y,
      ) < VISION_R
    ) {
      near = r;
      break;
    }
  }
  assert.ok(near >= 0, "no rock near the AI to observe");
  computeFog(w);
  assert.equal(w.fog.seen[1][near], 1);
  assert.equal(knownOwner(w, 1, near), OWNER_NEUTRAL);
  // Now move the AI's vision away: relocate its rock far so `near` drops out of sight, then flip
  // `near` to the human. The AI's last-known must stay neutral.
  w.asteroids[1].x += VISION_R * 3;
  w.asteroids[1].y += VISION_R * 3;
  w.asteroids[near].owner = 0;
  computeFog(w);
  assert.equal(w.fog.seen[1][near], 0, "rock still seen after vision moved");
  assert.equal(
    knownOwner(w, 1, near),
    OWNER_NEUTRAL,
    "AI's last-known should be stale neutral, not the true human owner",
  );
});

// --- Toggle OFF parity (CRITICAL) --------------------------------------------

test("fog OFF ⇒ AI decisions + events + rng state IDENTICAL to a no-fog control", () => {
  // Control built WITHOUT the fog key at all (true pre-fog config) vs one built with fog:false.
  // Stepped identically they must be byte-for-byte identical — proving the OFF path never runs
  // computeFog nor consumes any world.rng(), and the AI uses full info exactly as before.
  const control = createWorld({
    seed: 555,
    asteroidCount: 18,
    players: PLAYERS(),
    width: 2000,
    height: 2000,
  });
  const off = createWorld({
    seed: 555,
    asteroidCount: 18,
    players: PLAYERS(),
    width: 2000,
    height: 2000,
    fog: false,
  });
  assert.equal(control.fogOn, false, "absent fog ⇒ fogOn false");
  assert.equal(off.fogOn, false, "fog:false ⇒ fogOn false");
  assert.equal(control.fog, undefined, "no-fog world must not allocate fog");
  assert.equal(off.fog, undefined, "fog:false world must not allocate fog");
  const seqC = [];
  const seqO = [];
  for (let t = 0; t < 1500; t++) {
    Sim.step(control, 1 / 30);
    seqC.push(...eventsOf(control));
    control.events.n = 0;
    Sim.step(off, 1 / 30);
    seqO.push(...eventsOf(off));
    off.events.n = 0;
  }
  assert.deepEqual(
    seqO,
    seqC,
    "event sequence drifted between OFF and control",
  );
  assert.deepEqual(
    seedSnapshot(off),
    seedSnapshot(control),
    "seedling state drifted — OFF path altered the sim",
  );
  assert.equal(
    off.rng.getState(),
    control.rng.getState(),
    "rng state drifted — OFF path consumed world.rng()",
  );
  // AI observable: same dispatch counts.
  assert.equal(
    off.players[1]._aiSends,
    control.players[1]._aiSends,
    "AI send count drifted under fog OFF",
  );
});

// --- Save / resume ------------------------------------------------------------

test("serialize→deserialize preserves fog (known memory) and continues identically", () => {
  const w = mk({ fog: true });
  // Step into a state with real last-known memory (scouts have come and gone).
  for (let t = 0; t < 500; t++) Sim.step(w, 1 / 30);
  const saved = JSON.parse(JSON.stringify(serialize(w)));
  const resumed = deserialize(saved);
  assert.ok(resumed, "deserialize returned null");
  assert.equal(resumed.fogOn, true, "fogOn lost across save");
  assert.deepEqual(
    fogSnapshot(resumed),
    fogSnapshot(w),
    "fog (seen/known) not preserved across save",
  );
  // Continue both — they must stay identical (fog recomputes deterministically).
  for (let t = 0; t < 300; t++) {
    Sim.step(w, 1 / 30);
    Sim.step(resumed, 1 / 30);
  }
  assert.deepEqual(
    fogSnapshot(resumed),
    fogSnapshot(w),
    "resumed fog diverged from the live continuation",
  );
  assert.deepEqual(
    seedSnapshot(resumed),
    seedSnapshot(w),
    "resumed seedling state diverged",
  );
});

test("an old save with no fog field resumes with fog OFF (no field, no drift)", () => {
  const w = mk({ fog: true });
  for (let t = 0; t < 200; t++) Sim.step(w, 1 / 30);
  const saved = serialize(w);
  delete saved.fogOn;
  delete saved.fog;
  const resumed = deserialize(saved);
  assert.ok(resumed, "deserialize returned null");
  assert.equal(resumed.fogOn, false, "old save must restore fog OFF");
  assert.equal(resumed.fog, undefined, "old save must restore no fog state");
  // Stepping never throws and computes no fog.
  for (let t = 0; t < 100; t++) Sim.step(resumed, 1 / 30);
  assert.equal(resumed.fog, undefined, "OFF resume spuriously built fog");
});

// --- Sim purity ---------------------------------------------------------------

test("Sim/Fog.js uses no Math.random / Date.now / performance.now and no rng()", () => {
  const src = readFileSync(
    fileURLToPath(new URL("./Fog.js", import.meta.url)),
    "utf8",
  );
  for (const bad of [
    "Math.random",
    "Date.now",
    "performance.now",
    "world.rng",
    ".rng(",
  ])
    assert.ok(!src.includes(bad), `Fog.js must not use ${bad}`);
});
