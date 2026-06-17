// Sim/Specials.test.js — Feature 7a terrain specials (RESOURCE-RICH + NEBULA).
// Gated behind config.specials (default OFF) so the existing tests don't drift. Covers:
// deterministic generation, OFF=no-drift (same base layout), the rich economy/flower effect,
// the nebula transit slowdown, and invariants under specials.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, STATE } from "./World.js";
import { updateEconomy } from "./Economy.js";
import { updateTrees, FLOWER_SEEDS } from "./Trees.js";
import { updateSeedlings } from "./Seedlings.js";
import {
  RICH_ENERGY_MULT,
  RICH_SEED_BONUS,
  NEBULA_SLOW,
  BELT_SLOW,
  applyBeltEdgeRemoval,
} from "./MapGen.js";

const DT = 1 / 30;
const PLAYERS = [
  { id: 0, isAi: false, difficulty: 0 },
  { id: 1, isAi: true, difficulty: 1 },
];

function mk(seed, specials, count = 26) {
  return createWorld({
    seed,
    asteroidCount: count,
    players: PLAYERS.map((p) => ({ ...p })),
    width: 2000,
    height: 2000,
    specials,
  });
}

const richIds = (w) =>
  w.asteroids.filter((a) => a.special === "rich").map((a) => a.id);

// --- 1. Deterministic generation ------------------------------------------------------------
test("same seed + specials:true ⇒ identical rich set and identical nebulae", () => {
  const a = mk(1234, true);
  const b = mk(1234, true);
  assert.deepEqual(richIds(a), richIds(b), "rich set must be deterministic");
  assert.deepEqual(a.nebulae, b.nebulae, "nebulae must be deterministic");
  assert.ok(a.nebulae.length >= 1, "at least one nebula generated");
});

test("a different seed produces a different specials layout", () => {
  const a = mk(1234, true);
  const c = mk(9999, true);
  const differ =
    JSON.stringify(richIds(a)) !== JSON.stringify(richIds(c)) ||
    JSON.stringify(a.nebulae) !== JSON.stringify(c.nebulae);
  assert.ok(differ, "rich set or nebulae should differ across seeds");
});

test("nebula entries are plain {x,y,radius} numbers (JSON-serializable for save/resume)", () => {
  const w = mk(1234, true);
  for (const z of w.nebulae) {
    assert.equal(Object.keys(z).sort().join(","), "radius,x,y");
    for (const k of ["x", "y", "radius"]) {
      assert.equal(typeof z[k], "number");
      assert.ok(Number.isFinite(z[k]));
    }
  }
  // round-trips cleanly
  assert.deepEqual(JSON.parse(JSON.stringify(w.nebulae)), w.nebulae);
});

// --- 2. Default OFF = no drift; specials only ADD -------------------------------------------
test("specials OFF (default): no rich rocks, empty nebulae, empty belts", () => {
  const off = mk(1234, false);
  assert.equal(richIds(off).length, 0, "no rich rocks when off");
  assert.deepEqual(off.nebulae, [], "nebulae empty when off");
  assert.deepEqual(off.belts, [], "belts empty when off");
  const dflt = createWorld({
    seed: 1234,
    asteroidCount: 26,
    players: PLAYERS.map((p) => ({ ...p })),
    width: 2000,
    height: 2000,
  });
  assert.equal(richIds(dflt).length, 0, "omitting specials = off");
  assert.deepEqual(dflt.nebulae, []);
  assert.deepEqual(dflt.belts, []);
});

test("specials ON shares the EXACT base body+seedling layout of specials OFF (belts reshape only the graph)", () => {
  // Specials are tagged at the END, drawing rng only then ⇒ the PLACEMENT layer (positions,
  // stats, owner, homes, seedlings) must be byte-identical between an ON world and an OFF world
  // of the same seed. NOTE: belts (7b) legitimately REMOVE travel edges that cross them, so
  // `neighbors` is NOT asserted equal here — the body layout is untouched, only routing changes.
  // Edge-removal + the always-connected invariant are covered by the belt tests below.
  const off = mk(4242, false);
  const on = mk(4242, true);
  assert.equal(off.asteroids.length, on.asteroids.length);
  for (let i = 0; i < off.asteroids.length; i++) {
    const a = off.asteroids[i];
    const b = on.asteroids[i];
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
      "energyMult",
      "kind",
      "habitable",
      "moon",
      "binary",
      "binarySecondary",
      "seed",
    ]) {
      assert.equal(a[f], b[f], `body ${i} field ${f} drifted with specials on`);
    }
  }
  // Seedlings (homes seeded identically) — same count + positions.
  assert.equal(off.seed.count, on.seed.count, "seedling count drifted");
  for (let i = 0; i < off.seed.count; i++) {
    assert.equal(off.seed.x[i], on.seed.x[i]);
    assert.equal(off.seed.y[i], on.seed.y[i]);
    assert.equal(off.seed.home[i], on.seed.home[i]);
    assert.equal(off.seed.owner[i], on.seed.owner[i]);
  }
});

// --- 3. Resource-rich effect ----------------------------------------------------------------
test("rich owned rock regenerates ≈RICH_ENERGY_MULT× faster than a non-rich twin", () => {
  const w = mk(1234, true);
  // Two identical owned rocks (same energyStat, no planet mult), one tagged rich.
  const base = {
    owner: 0,
    energy: 0,
    energyStat: 100,
    energyMult: 1,
    dead: false,
  };
  const plain = { ...base };
  const rich = { ...base, special: "rich" };
  w.asteroids.push(plain, rich);
  for (let t = 0; t < 30; t++) updateEconomy(w, DT); // stay below the cap
  assert.ok(plain.energy > 0 && rich.energy > 0);
  const ratio = rich.energy / plain.energy;
  assert.ok(
    Math.abs(ratio - RICH_ENERGY_MULT) < 1e-6,
    `expected ratio ≈ ${RICH_ENERGY_MULT}, got ${ratio}`,
  );
});

test("rich rock's flower yields FLOWER_SEEDS + RICH_SEED_BONUS; plain yields FLOWER_SEEDS", () => {
  function flowerOnce(special) {
    const w = mk(1234, true);
    const rock = w.asteroids.find((a) => a.owner === 0);
    if (special) rock.special = "rich";
    else delete rock.special;
    rock.energy = 0; // no produce spend; isolate the flower path
    rock.trees = [
      {
        type: "seedling",
        level: 1,
        growth: 1,
        cooldown: 999,
        flowerCd: 0.0001,
      },
    ];
    const player = w.players.find((p) => p.id === 0);
    const before = player.seeds;
    updateTrees(w, DT); // crosses flowerCd → one payout
    return player.seeds - before;
  }
  assert.equal(flowerOnce(true), FLOWER_SEEDS + RICH_SEED_BONUS);
  assert.equal(flowerOnce(false), FLOWER_SEEDS);
});

// --- 4. Nebula effect -----------------------------------------------------------------------
test("a seedling transiting through a nebula covers less ground than with no nebula", () => {
  // Controlled straight-line transit. One owned home, one neutral target placed far to the
  // right; a nebula straddling the path. Compare distance covered over N ticks with vs without
  // the nebula (same world otherwise).
  function run(withNebula) {
    const w = mk(777, true);
    const s = w.seed;
    // Anchor a clean two-body line: home at (200,1000), target at (1800,1000).
    const home = w.asteroids[0];
    const target = w.asteroids[1];
    home.x = 200;
    home.y = 1000;
    home.radius = 30;
    home.speedStat = 50; // neutral speedFactor across both runs
    target.x = 1800;
    target.y = 1000;
    target.radius = 30;
    target.owner = -1;
    home.owner = 0;
    // Direct nav hop home→target so the ship flies straight.
    w.nebulae = withNebula ? [{ x: 1000, y: 1000, radius: 300 }] : [];
    // Spawn one ship orbiting home, then launch straight at target by hand.
    s.count = 0;
    const i = 0;
    s.count = 1;
    s.home[i] = home.id;
    s.owner[i] = 0;
    s.state[i] = STATE.TRANSIT;
    s.target[i] = target.id;
    s.dest[i] = target.id;
    s.x[i] = home.x;
    s.y[i] = home.y;
    s.energy[i] = 50;
    s.strength[i] = 50;
    let ticks = 0;
    while (s.state[i] === STATE.TRANSIT && ticks < 5000) {
      updateSeedlings(w, DT);
      ticks++;
    }
    return ticks;
  }
  const clear = run(false);
  const fogged = run(true);
  assert.ok(
    fogged > clear,
    `nebula transit should take MORE ticks (clear=${clear}, fogged=${fogged})`,
  );
});

test("nebulaSlow factor matches NEBULA_SLOW (sanity on the constant)", () => {
  assert.ok(
    NEBULA_SLOW > 0 && NEBULA_SLOW < 1,
    "nebula slow must be a slowdown",
  );
});

// --- 4b. Dense belt (Feature 7b) ------------------------------------------------------------
const isLeaf = (a) => a.moon || a.binarySecondary;
// Segment a→b within `r` of belt center (mirror of MapGen.segHitsCircle, for test assertions).
function segHitsCircle(ax, ay, bx, by, cx, cy, r) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((cx - ax) * dx + (cy - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = ax + t * dx - cx;
  const ey = ay + t * dy - cy;
  return ex * ex + ey * ey <= r * r;
}
// True if the travel graph (each body's .neighbors) is one connected component.
function isConnected(w) {
  const n = w.asteroids.length;
  const seen = new Uint8Array(n);
  const q = [0];
  seen[0] = 1;
  let qi = 0;
  while (qi < q.length)
    for (const nb of w.asteroids[q[qi++]].neighbors)
      if (!seen[nb]) {
        seen[nb] = 1;
        q.push(nb);
      }
  return seen.reduce((a, b) => a + b, 0) === n;
}

test("same seed + specials ⇒ identical belts; different seed differs", () => {
  const a = mk(1234, true);
  const b = mk(1234, true);
  const c = mk(9999, true);
  assert.deepEqual(a.belts, b.belts, "belts must be deterministic");
  assert.ok(a.belts.length >= 1, "at least one belt generated");
  assert.notDeepEqual(a.belts, c.belts, "belts should differ across seeds");
});

test("belt entries are plain {x,y,radius} numbers (JSON-serializable for save/resume)", () => {
  const w = mk(1234, true);
  for (const z of w.belts) {
    assert.equal(Object.keys(z).sort().join(","), "radius,x,y");
    for (const k of ["x", "y", "radius"]) {
      assert.equal(typeof z[k], "number");
      assert.ok(Number.isFinite(z[k]));
    }
  }
  assert.deepEqual(JSON.parse(JSON.stringify(w.belts)), w.belts);
});

test("a hand-placed belt removes the direct edge between two anchors but leaves them connected", () => {
  // Controlled scenario: find two NON-leaf neighbors with no belt between them in an OFF world,
  // drop a belt straddling their midpoint, re-run the edge-removal post-pass, and assert their
  // direct edge is gone yet the graph stays fully connected (routing changed, not partitioned).
  const w = mk(31415, false); // OFF ⇒ pristine graph to mutate by hand
  let pi = -1;
  let pj = -1;
  outer: for (let i = 0; i < w.asteroids.length; i++) {
    if (isLeaf(w.asteroids[i])) continue;
    for (const j of w.asteroids[i].neighbors) {
      if (j <= i || isLeaf(w.asteroids[j])) continue;
      pi = i;
      pj = j;
      break outer;
    }
  }
  assert.ok(pi >= 0, "found an anchor-anchor edge to block");
  const A = w.asteroids[pi];
  const B = w.asteroids[pj];
  // Tight belt centered on the A–B midpoint: small enough to hit only this segment cleanly.
  w.belts = [{ x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, radius: 40 }];
  assert.ok(
    segHitsCircle(A.x, A.y, B.x, B.y, w.belts[0].x, w.belts[0].y, 40),
    "belt straddles the A-B segment",
  );
  applyBeltEdgeRemoval(w);
  assert.ok(
    !A.neighbors.includes(pj) && !B.neighbors.includes(pi),
    "the direct A-B edge was removed",
  );
  assert.ok(isConnected(w), "graph still fully connected after removal");
});

test("procedural belt removes ≥1 crossing anchor edge and the graph stays connected", () => {
  // The OFF graph has some anchor edges crossing where the ON belt lands; assert at least one is
  // ABSENT in the ON graph, and the ON graph is fully connected with every leaf keeping its
  // parent edge.
  const seed = 246810;
  const off = mk(seed, false);
  const on = mk(seed, true);
  const belts = on.belts;
  assert.ok(belts.length >= 1);
  // Count anchor-anchor OFF edges that cross a belt but are gone in the ON graph.
  let removed = 0;
  for (let i = 0; i < off.asteroids.length; i++) {
    if (isLeaf(off.asteroids[i])) continue;
    for (const j of off.asteroids[i].neighbors) {
      if (j <= i || isLeaf(off.asteroids[j])) continue;
      const A = off.asteroids[i];
      const B = off.asteroids[j];
      const crosses = belts.some((z) =>
        segHitsCircle(A.x, A.y, B.x, B.y, z.x, z.y, z.radius),
      );
      if (crosses && !on.asteroids[i].neighbors.includes(j)) removed++;
    }
  }
  assert.ok(
    removed >= 1,
    `expected ≥1 belt-crossing edge removed, got ${removed}`,
  );
  assert.ok(
    isConnected(on),
    "ON graph fully connected after belt edge removal",
  );
  // Every leaf still has its single parent edge.
  for (const a of on.asteroids) {
    if (isLeaf(a)) {
      const parent = a.moon ? a.orbitParent : a.binaryPartner;
      assert.ok(
        a.neighbors.includes(parent),
        `leaf ${a.id} lost its parent edge`,
      );
    }
  }
});

test("belt connectivity invariant holds across many seeds (id===index too)", () => {
  for (const seed of [3, 17, 88, 404, 1024, 65535, 271828, 8675309]) {
    const w = mk(seed, true);
    assert.ok(
      w.asteroids.every((a, i) => a.id === i),
      `id===index seed ${seed}`,
    );
    assert.ok(w.belts.length >= 1, `belt placed for seed ${seed}`);
    assert.ok(isConnected(w), `graph connected for seed ${seed}`);
  }
});

// Size-parameterized world (the default mk is 2000×2000). Used to exercise belt routing/
// connectivity across the real skirmish map sizes.
function mkSize(seed, w, h, specials = true) {
  return createWorld({
    seed,
    asteroidCount: 26,
    planetMin: 1,
    planetMax: 2,
    players: PLAYERS.map((p) => ({ ...p })),
    width: w,
    height: h,
    specials,
  });
}
// Set of "i,j" (i<j) anchor–anchor edges in a world's travel graph.
function anchorEdges(w) {
  const s = new Set();
  for (let i = 0; i < w.asteroids.length; i++) {
    if (isLeaf(w.asteroids[i])) continue;
    for (const j of w.asteroids[i].neighbors)
      if (j > i && !isLeaf(w.asteroids[j])) s.add(i + "," + j);
  }
  return s;
}
const edgeCrossesBelt = (w, i, j) => {
  const A = w.asteroids[i];
  const B = w.asteroids[j];
  return (w.belts || []).some((z) =>
    segHitsCircle(A.x, A.y, B.x, B.y, z.x, z.y, z.radius),
  );
};

// Net routing change: the belt must, in the COMMON case across sizes/seeds, remove an
// anchor edge that is NOT re-added (a real detour). This locks in F7b's purpose against a
// regression back to the belt-blind no-op. We don't require EVERY world to change (a belt can
// legitimately land in open space with nothing to cross), but the strong majority must.
test("procedural belt changes routing in the common case (multi-seed × multi-size)", () => {
  const sizes = [
    [1100, 1100],
    [1700, 1700],
    [2400, 2400],
  ];
  const seeds = [1, 2, 3, 7, 13, 42, 101, 777, 2024, 99999, 123456, 654321];
  let worlds = 0;
  let changed = 0;
  let crossingReadds = 0;
  for (const seed of seeds)
    for (const [w, h] of sizes) {
      const off = mkSize(seed, w, h, false);
      const on = mkSize(seed, w, h, true);
      worlds++;
      const offAA = anchorEdges(off);
      const onAA = anchorEdges(on);
      // A real detour exists iff some OFF crossing edge is gone in ON.
      let netRemoved = false;
      for (const e of offAA) {
        const [i, j] = e.split(",").map(Number);
        if (edgeCrossesBelt(on, i, j) && !onAA.has(e)) {
          netRemoved = true;
          break;
        }
      }
      if (netRemoved) changed++;
      // Tally any crossing edge still PRESENT in ON (a re-added/forced gateway).
      for (const e of onAA) {
        const [i, j] = e.split(",").map(Number);
        if (edgeCrossesBelt(on, i, j)) crossingReadds++;
      }
    }
  // Strong majority of worlds get a real routing change (the belt is not a no-op).
  assert.ok(
    changed >= Math.ceil(worlds * 0.6),
    `belt should change routing in ≥60% of worlds, got ${changed}/${worlds} (crossingReadds=${crossingReadds})`,
  );
});

// Belt-aware re-bridge: every belt-crossing anchor edge that SURVIVES in the final ON graph
// must be a genuine GATEWAY — i.e. removing it disconnects the graph. If any surviving crossing
// edge could be dropped while the graph stays connected, the re-bridge was belt-BLIND (it
// re-added an avoidable crossing). This is the regression guard for Fix 1.
test("belt-aware re-bridge re-adds NO avoidable crossing edges (every surviving crossing is a forced gateway)", () => {
  const sizes = [
    [1100, 1100],
    [1700, 1700],
    [2400, 2400],
  ];
  const seeds = [0, 1, 2, 5, 11, 29, 58, 137, 404, 9001, 271828, 8675309];
  // connected ignoring one specific undirected edge (i,j)
  const connectedWithout = (w, ei, ej) => {
    const n = w.asteroids.length;
    const seen = new Uint8Array(n);
    const q = [0];
    seen[0] = 1;
    let qi = 0;
    while (qi < q.length) {
      const cur = q[qi++];
      for (const nb of w.asteroids[cur].neighbors) {
        if ((cur === ei && nb === ej) || (cur === ej && nb === ei)) continue;
        if (!seen[nb]) {
          seen[nb] = 1;
          q.push(nb);
        }
      }
    }
    return seen.reduce((a, b) => a + b, 0) === n;
  };
  for (const seed of seeds)
    for (const [w, h] of sizes) {
      const on = mkSize(seed, w, h, true);
      for (const e of anchorEdges(on)) {
        const [i, j] = e.split(",").map(Number);
        if (!edgeCrossesBelt(on, i, j)) continue;
        // A crossing edge is only acceptable if it's a cut-edge (gateway): removing it MUST
        // disconnect the graph. Otherwise the re-bridge kept an avoidable crossing.
        assert.ok(
          !connectedWithout(on, i, j),
          `avoidable crossing edge ${i}-${j} survived (graph still connected without it) — re-bridge not belt-aware [seed ${seed} ${w}×${h}]`,
        );
      }
    }
});

// Committed connectivity + leaf-edge invariant across many specials-on worlds (multi-seed ×
// multi-size). Encodes the stress test as a real, bounded test (~36 worlds).
test("belt worlds: graph connected, every leaf keeps exactly its parent edge, id===index", () => {
  const sizes = [
    [1100, 1100],
    [1700, 1700],
    [2400, 2400],
  ];
  const seeds = [
    4, 19, 63, 128, 256, 512, 1000, 4096, 31337, 555555, 7777777, 88888888,
  ];
  for (const seed of seeds)
    for (const [w, h] of sizes) {
      const wd = mkSize(seed, w, h, true);
      const tag = `seed ${seed} ${w}×${h}`;
      assert.ok(
        wd.asteroids.every((a, i) => a.id === i),
        `id===index broke (${tag})`,
      );
      assert.ok(wd.belts.length >= 1, `belt placed (${tag})`);
      // BFS over NON-leaf bodies only reaches every non-leaf (leaves hang off their anchor).
      assert.ok(isConnected(wd), `graph not connected (${tag})`);
      for (const a of wd.asteroids) {
        if (isLeaf(a)) {
          const parent = a.moon ? a.orbitParent : a.binaryPartner;
          assert.deepEqual(
            a.neighbors,
            [parent],
            `leaf ${a.id} must have EXACTLY its parent edge (${tag})`,
          );
        }
      }
    }
});

test("a ship transiting through a belt covers less ground than with no belt", () => {
  // Same controlled straight-line transit as the nebula test, but with a belt straddling the
  // path; composes with the existing slow machinery.
  function run(withBelt) {
    const w = mk(555, true);
    const s = w.seed;
    const home = w.asteroids[0];
    const target = w.asteroids[1];
    home.x = 200;
    home.y = 1000;
    home.radius = 30;
    home.speedStat = 50;
    target.x = 1800;
    target.y = 1000;
    target.radius = 30;
    target.owner = -1;
    home.owner = 0;
    w.nebulae = [];
    w.belts = withBelt ? [{ x: 1000, y: 1000, radius: 300 }] : [];
    s.count = 0;
    const i = 0;
    s.count = 1;
    s.home[i] = home.id;
    s.owner[i] = 0;
    s.state[i] = STATE.TRANSIT;
    s.target[i] = target.id;
    s.dest[i] = target.id;
    s.x[i] = home.x;
    s.y[i] = home.y;
    s.energy[i] = 50;
    s.strength[i] = 50;
    let ticks = 0;
    while (s.state[i] === STATE.TRANSIT && ticks < 8000) {
      updateSeedlings(w, DT);
      ticks++;
    }
    return ticks;
  }
  const clear = run(false);
  const dusty = run(true);
  assert.ok(
    dusty > clear,
    `belt transit should take MORE ticks (clear=${clear}, dusty=${dusty})`,
  );
});

test("BELT_SLOW is a slowdown and stronger than NEBULA_SLOW", () => {
  assert.ok(BELT_SLOW > 0 && BELT_SLOW < 1, "belt slow must be a slowdown");
  assert.ok(BELT_SLOW < NEBULA_SLOW, "a belt impedes harder than a nebula");
});

test("belt + nebula slows COMPOSE (overlapping regions multiply)", () => {
  // A ship inside both a nebula AND a belt should be slower than inside either alone.
  function ticksFor(neb, belt) {
    const w = mk(99, true);
    const s = w.seed;
    const home = w.asteroids[0];
    const target = w.asteroids[1];
    home.x = 200;
    home.y = 1000;
    home.radius = 30;
    home.speedStat = 50;
    target.x = 1800;
    target.y = 1000;
    target.radius = 30;
    target.owner = -1;
    home.owner = 0;
    w.nebulae = neb ? [{ x: 1000, y: 1000, radius: 300 }] : [];
    w.belts = belt ? [{ x: 1000, y: 1000, radius: 300 }] : [];
    s.count = 1;
    const i = 0;
    s.home[i] = home.id;
    s.owner[i] = 0;
    s.state[i] = STATE.TRANSIT;
    s.target[i] = target.id;
    s.dest[i] = target.id;
    s.x[i] = home.x;
    s.y[i] = home.y;
    s.energy[i] = 50;
    s.strength[i] = 50;
    let ticks = 0;
    while (s.state[i] === STATE.TRANSIT && ticks < 12000) {
      updateSeedlings(w, DT);
      ticks++;
    }
    return ticks;
  }
  const both = ticksFor(true, true);
  const nebOnly = ticksFor(true, false);
  const beltOnly = ticksFor(false, true);
  assert.ok(both > nebOnly, "belt+nebula slower than nebula alone");
  assert.ok(both > beltOnly, "belt+nebula slower than belt alone");
});

// --- 5. Invariants under specials -----------------------------------------------------------
test("with specials:true, id===index and graph connectivity still hold", () => {
  for (const seed of [1, 42, 1337, 9001]) {
    const w = mk(seed, true);
    assert.ok(
      w.asteroids.every((a, i) => a.id === i),
      `id===index broke for seed ${seed}`,
    );
    // BFS from body 0 reaches every body (connected travel graph).
    const n = w.asteroids.length;
    const seen = new Uint8Array(n);
    const q = [0];
    seen[0] = 1;
    let qi = 0;
    while (qi < q.length) {
      for (const nb of w.asteroids[q[qi++]].neighbors) {
        if (!seen[nb]) {
          seen[nb] = 1;
          q.push(nb);
        }
      }
    }
    assert.equal(
      seen.reduce((a, b) => a + b, 0),
      n,
      `graph not fully connected for seed ${seed}`,
    );
  }
});
