// Sim/Wormhole.test.js — Feature 13: wormhole pairs (a 1-hop cross-map travel shortcut).
// Gated behind config.wormholes (default OFF). Covers: deterministic generation, the routing
// shortcut THROUGH the pair, resume-routes-identically (the neighbors edge + rebuildNav reuse),
// pairing validation on restore, wormholes-OFF byte-identical to a pre-wormhole map, and the
// enemy-held-end contested-gate behavior (emergent intermediate-sling + combat).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, step, OWNER_NEUTRAL, STATE } from "./World.js";
import Sim from "./World.js";
import { serialize, deserialize } from "./Save.js";
import { sendSeedlings } from "./Seedlings.js";

const DT = 1 / 30;
const TWO = [
  { id: 0, isAi: false, difficulty: 0 },
  { id: 1, isAi: true, difficulty: 1 },
];

function mk(seed, wormholes, count = 26) {
  return createWorld({
    seed,
    asteroidCount: count,
    players: TWO.map((p) => ({ ...p })),
    width: 2000,
    height: 2000,
    wormholes,
  });
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const ends = (w) => w.asteroids.filter((a) => a.kind === "wormhole");

// --- 1. Default OFF = no drift; wormholes only ADD ------------------------------------------
test("wormholes OFF (default): no wormhole bodies, empty world.wormholes", () => {
  const off = mk(1234, false);
  assert.equal(ends(off).length, 0, "no wormhole bodies when off");
  assert.deepEqual(off.wormholes, [], "world.wormholes empty when off");
  const dflt = createWorld({
    seed: 1234,
    asteroidCount: 26,
    players: TWO.map((p) => ({ ...p })),
    width: 2000,
    height: 2000,
  });
  assert.equal(ends(dflt).length, 0, "omitting wormholes = off");
  assert.deepEqual(dflt.wormholes, []);
});

// THE GATE: a wormholes-OFF world for a seed must be byte-identical to a pre-wormhole map for that
// seed — the gated rng (drawn only in the ON pass) must not perturb the OFF path. We can't compare
// to "before the change" directly, but the contract is: the OFF map equals a map built WITHOUT the
// wormholes key at all (the rng stream + body array + nav + seedlings all identical).
test("wormholes OFF is byte-identical to a map built with no wormholes key (gated rng never perturbs OFF)", () => {
  for (const seed of [1, 42, 1337, 9001, 271828]) {
    const off = mk(seed, false);
    const none = createWorld({
      seed,
      asteroidCount: 26,
      players: TWO.map((p) => ({ ...p })),
      width: 2000,
      height: 2000,
    });
    assert.equal(
      off.asteroids.length,
      none.asteroids.length,
      `len seed ${seed}`,
    );
    for (let i = 0; i < off.asteroids.length; i++) {
      const a = off.asteroids[i];
      const b = none.asteroids[i];
      for (const f of [
        "id",
        "x",
        "y",
        "radius",
        "owner",
        "energy",
        "energyStat",
        "strengthStat",
        "speedStat",
        "kind",
        "seed",
        "moon",
        "binary",
      ]) {
        assert.equal(a[f], b[f], `body ${i} field ${f} drifted (seed ${seed})`);
      }
      assert.deepEqual(
        a.neighbors,
        b.neighbors,
        `neighbors ${i} (seed ${seed})`,
      );
    }
    assert.equal(off.seed.count, none.seed.count, `seed count (seed ${seed})`);
    for (let i = 0; i < off.seed.count; i++) {
      assert.equal(off.seed.x[i], none.seed.x[i]);
      assert.equal(off.seed.y[i], none.seed.y[i]);
      assert.equal(off.seed.home[i], none.seed.home[i]);
      assert.equal(off.seed.owner[i], none.seed.owner[i]);
    }
    // nav table identical too.
    for (let s = 0; s < off.nav.length; s++)
      assert.deepEqual(
        Array.from(off.nav[s]),
        Array.from(none.nav[s]),
        `nav ${s} seed ${seed}`,
      );
    // And the rng stream continues identically (the OFF pass drew no extra numbers).
    for (let k = 0; k < 20; k++)
      assert.equal(off.rng(), none.rng(), `rng ${k} seed ${seed}`);
  }
});

// --- 2. Deterministic ON generation ---------------------------------------------------------
test("same seed + wormholes:true ⇒ identical wormhole pair + ends", () => {
  const a = mk(2024, true);
  const b = mk(2024, true);
  assert.deepEqual(a.wormholes, b.wormholes, "pair list deterministic");
  const ea = ends(a);
  const eb = ends(b);
  assert.equal(ea.length, 2, "exactly one pair (two ends)");
  for (let i = 0; i < ea.length; i++) {
    assert.equal(ea[i].x, eb[i].x);
    assert.equal(ea[i].y, eb[i].y);
    assert.equal(ea[i].wormholeId, eb[i].wormholeId);
  }
});

test("wormhole ends are habitable, symmetric, id===index preserved, ends far apart", () => {
  for (const seed of [3, 17, 555, 4096]) {
    const w = mk(seed, true);
    assert.ok(
      w.asteroids.every((a, i) => a.id === i),
      `id===index seed ${seed}`,
    );
    const e = ends(w);
    assert.equal(e.length, 2, `one pair seed ${seed}`);
    const [A, B] = e;
    assert.equal(A.habitable, true, "end A capturable");
    assert.equal(B.habitable, true, "end B capturable");
    assert.equal(A.wormholeId, B.id, "A points at B");
    assert.equal(B.wormholeId, A.id, "B points at A");
    assert.ok(
      A.neighbors.includes(B.id),
      "A neighbors include B (the wormhole edge)",
    );
    assert.ok(
      B.neighbors.includes(A.id),
      "B neighbors include A (the wormhole edge)",
    );
    assert.deepEqual(w.wormholes[0], { a: A.id, b: B.id }, "pair recorded");
    // Ends placed far apart (corner-biased opposite halves) so the shortcut is meaningful.
    const diag = Math.hypot(w.width, w.height);
    assert.ok(
      dist(A, B) > diag * 0.3,
      `ends only ${dist(A, B)} apart (seed ${seed})`,
    );
  }
});

// --- 3. Routing THROUGH the wormhole (the 1-hop shortcut) ------------------------------------
test("the wormhole edge is a 1-hop nav shortcut: A→B routes directly across the pair", () => {
  const w = mk(2024, true);
  const [A, B] = ends(w);
  // nav[A][B] === B means the first hop from A toward B IS B — a direct 1-hop edge (the wormhole),
  // even though A and B sit at opposite corners of the map.
  assert.equal(
    w.nav[A.id][B.id],
    B.id,
    "A→B is a single hop (the wormhole edge)",
  );
  assert.equal(
    w.nav[B.id][A.id],
    A.id,
    "B→A is a single hop (the wormhole edge)",
  );
});

test("a route between bodies near the two ends goes THROUGH the wormhole (fewer hops than without)", () => {
  // Build the ON world; pick the local anchor each end spliced into. A route from near-A's anchor
  // to near-B's anchor should pass through A and B (the wormhole), giving FEWER hops than the same
  // route on the OFF graph (no shortcut). Hop-count via BFS over neighbors.
  function hops(w, src, dst) {
    const seen = new Int32Array(w.asteroids.length).fill(-1);
    const q = [src];
    seen[src] = 0;
    let qi = 0;
    while (qi < q.length) {
      const cur = q[qi++];
      if (cur === dst) return seen[cur];
      for (const nb of w.asteroids[cur].neighbors)
        if (seen[nb] < 0) {
          seen[nb] = seen[cur] + 1;
          q.push(nb);
        }
    }
    return Infinity;
  }
  // Find a seed where the route near-A → near-B is genuinely shortcut by the wormhole.
  let proven = false;
  for (let seed = 1; seed <= 30 && !proven; seed++) {
    const on = mk(seed, true);
    const off = mk(seed, false);
    const [A, B] = ends(on);
    // The local anchors each end connected to (its non-wormhole neighbor).
    const anchorA = A.neighbors.find((id) => id !== B.id);
    const anchorB = B.neighbors.find((id) => id !== A.id);
    if (anchorA == null || anchorB == null) continue;
    const onHops = hops(on, anchorA, anchorB);
    const offHops = hops(off, anchorA, anchorB);
    // Through the wormhole: anchorA→A→B→anchorB = 3 hops, regardless of map distance.
    if (onHops < offHops) {
      proven = true;
      // And the on-route's first hops from anchorA head toward A (the wormhole entrance).
      assert.ok(on.nav[anchorA][anchorB] >= 0, "route exists in ON graph");
    }
  }
  assert.ok(
    proven,
    "no seed produced a wormhole that shortened a cross-map route",
  );
});

// --- 4. Resume routes identically (the neighbors edge + rebuildNav reuse) --------------------
test("resume routes identically: serialize→deserialize a wormhole world ⇒ same nav + same pair", () => {
  const w1 = mk(2024, true);
  // Warm it a little so the SoA carries real state.
  for (let i = 0; i < 60; i++) step(w1, DT);
  const w2 = deserialize(serialize(w1));
  assert.ok(w2, "deserialize produced a world");
  // The wormhole pair survived.
  assert.deepEqual(w2.wormholes, w1.wormholes, "pair list round-tripped");
  // Every end's neighbors match (the wormhole edge rode asteroid cloneJson).
  const e1 = ends(w1);
  for (const A of e1) {
    assert.deepEqual(
      w2.asteroids[A.id].neighbors,
      w1.asteroids[A.id].neighbors,
      `end ${A.id} neighbors round-tripped`,
    );
    assert.equal(
      w2.asteroids[A.id].wormholeId,
      w1.asteroids[A.id].wormholeId,
      "wormholeId rode",
    );
  }
  // nav rebuilt IDENTICALLY from the restored neighbors (the resume-routes-identically gate).
  for (let s = 0; s < w1.nav.length; s++)
    assert.deepEqual(
      Array.from(w2.nav[s]),
      Array.from(w1.nav[s]),
      `nav[${s}] mismatch on resume`,
    );
  // The wormhole shortcut still resolves to a 1-hop on the resumed world.
  const [A, B] = ends(w2);
  assert.equal(w2.nav[A.id][B.id], B.id, "resumed A→B still a 1-hop shortcut");
});

// --- 5. Pairing validation on restore -------------------------------------------------------
test("restore drops an asymmetric / out-of-range wormhole pair (no throw); keeps a valid one", () => {
  const w = mk(2024, true);
  const saved = serialize(w);
  const nAst = w.asteroids.length;
  const good = { ...saved.wormholes[0] }; // the real, symmetric pair
  saved.wormholes = [
    good,
    { a: good.a, b: nAst + 5 }, // b out of range
    { a: 0, b: 1 }, // both in range but NOT symmetric (asteroids[0/1] have no wormholeId link)
    { a: good.a, b: good.a }, // a === b
    null, // null entry
    42, // primitive
    { a: good.a }, // missing b
  ];
  let w2;
  assert.doesNotThrow(() => {
    w2 = deserialize(saved);
  }, "deserialize never throws on corrupt wormholes");
  assert.ok(w2, "still produced a world");
  assert.equal(w2.wormholes.length, 1, "only the valid symmetric pair kept");
  assert.deepEqual(w2.wormholes[0], good, "valid pair preserved intact");
});

test("a valid wormhole save round-trips and continues deterministically over N steps", () => {
  const w1 = mk(11, true, 20);
  for (let i = 0; i < 40; i++) step(w1, DT);
  const w2 = deserialize(serialize(w1));
  assert.ok(w2);
  for (let i = 0; i < 200; i++) {
    step(w1, DT);
    step(w2, DT);
  }
  // Compare load-bearing world fields after the continuation.
  assert.equal(w2.tick, w1.tick, "tick matches");
  assert.equal(w2.seed.count, w1.seed.count, "seed count matches");
  for (let i = 0; i < w1.seed.count; i++) {
    assert.equal(w2.seed.x[i], w1.seed.x[i], `seed x[${i}]`);
    assert.equal(w2.seed.state[i], w1.seed.state[i], `seed state[${i}]`);
    assert.equal(w2.seed.home[i], w1.seed.home[i], `seed home[${i}]`);
  }
  for (let i = 0; i < w1.asteroids.length; i++)
    assert.equal(w2.asteroids[i].owner, w1.asteroids[i].owner, `owner[${i}]`);
});

// --- 6. Enemy-held end is a CONTESTED GATE (emergent intermediate-sling + combat) ------------
test("a ship routing THROUGH an enemy-held wormhole end engages it (does NOT pass cleanly)", () => {
  // Pick a seed where a route from the human home passes through end A as an intermediate hop on
  // the way to a body beyond it (i.e. nav[home][dest] === A and dest !== A). Garrison A with the
  // enemy. As the human ship reaches A (an intermediate hop) it enterSlings A and fights the
  // garrison there (existing SLING-combat). Assert casualties occur — the enemy end is not a free
  // pass — and that a slinging ship does NOT capture A just by passing through.
  let proven = false;
  for (let seed = 1; seed <= 40 && !proven; seed++) {
    const w = mk(seed, true, 26);
    const e = ends(w);
    if (e.length < 2) continue;
    const home = w.asteroids.find((a) => a.owner === 0);
    if (!home) continue;
    // A destination whose route from home passes THROUGH a wormhole end (the end is the next hop,
    // but not the final dest).
    let dest = -1;
    let gate = -1;
    for (const A of e) {
      for (const cand of w.asteroids) {
        if (cand.id === home.id || !cand.habitable || cand.moon) continue;
        if (w.nav[home.id][cand.id] === A.id && cand.id !== A.id) {
          dest = cand.id;
          gate = A.id;
          break;
        }
      }
      if (dest >= 0) break;
    }
    if (dest < 0) continue;
    // Garrison the gate with a strong enemy force.
    w.asteroids[gate].owner = 1;
    for (let k = 0; k < 6; k++)
      Sim.spawnSeedling(w, {
        home: gate,
        owner: 1,
        orbitRadius: w.asteroids[gate].radius + 35,
        orbitAngle: k,
        strength: 80,
        energy: 100,
      });
    const before = w.seed.count;
    const launched = sendSeedlings(w, home.id, dest, 1, 0);
    if (launched < 1) continue;
    let sawSling = false;
    for (let t = 0; t < 1200; t++) {
      Sim.step(w, DT);
      for (let i = 0; i < w.seed.count; i++)
        if (w.seed.state[i] === STATE.SLING && w.seed.target[i] === gate)
          sawSling = true;
    }
    // The gate must still be enemy-held (a passing/slinging ship never captures it just by transit).
    if (sawSling && w.seed.count < before) {
      assert.equal(
        w.asteroids[gate].owner,
        1,
        "a slinging ship wrongly captured the enemy-held wormhole end",
      );
      proven = true;
    }
  }
  assert.ok(
    proven,
    "no seed produced a contested wormhole gate (ship slung + fought the enemy-held end)",
  );
});
