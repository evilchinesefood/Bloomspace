import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, OWNER_NEUTRAL, STATE } from "./World.js";
import Sim from "./World.js";
import { STAT_MIN } from "./MapGen.js";
import { fireBombard, CHARGE_TICKS } from "./Bombard.js";
import { plantTree, BATTERY_SIZE } from "./Trees.js";

const TWO = [
  { id: 0, isAi: false, difficulty: 0 },
  { id: 1, isAi: true, difficulty: 1 },
];

function mk(seed, count = 16, players = TWO) {
  return createWorld({
    seed,
    asteroidCount: count,
    players,
    width: 2000, // roomy enough for the wider spacing + large planets
    height: 2000,
  });
}

test("asteroid id === array index (load-bearing SoA invariant)", () => {
  // Every seedling home/target/dest is an index that doubles as asteroid.id; Combat,
  // Picking, AsteroidView and Hud all rely on asteroids[i].id === i. A future reorder
  // (sort/filter/splice) would silently corrupt all game state — assert it can't drift.
  for (const seed of [1, 42, 1337, 9001]) {
    for (const count of [8, 16, 26, 44]) {
      const w = mk(seed, count);
      assert.ok(
        w.asteroids.every((a, i) => a.id === i),
        `id===index broken for seed=${seed} count=${count}`,
      );
    }
  }
});

test("id===index STILL holds after a bombard destroys a body (dead, never spliced)", () => {
  // The dead-body operation marks a body dead in place — it must NEVER splice/reorder
  // world.asteroids, or every seedling home/target/dest index (and asteroids[i].id===i)
  // would silently corrupt. Drive a real bombard through the public fire path and re-assert.
  const w = mk(13, 16);
  const rock = w.asteroids.find((a) => a.owner === 0);
  const target = w.asteroids.find(
    (a) => a.owner === OWNER_NEUTRAL && a.kind === "asteroid" && !a.moon,
  );
  const len0 = w.asteroids.length;
  // arm a full battery on the home rock
  for (let k = 0; k < BATTERY_SIZE; k++) {
    rock.energy = 2000;
    w.players[0].seeds = 2000;
    assert.equal(plantTree(w, rock.id, "bombard", 0), true);
  }
  for (const t of rock.trees) t.growth = 1;
  assert.equal(fireBombard(w, rock.id, target.id, 0), true);
  for (let t = 0; t < CHARGE_TICKS + 2; t++) Sim.step(w, 1 / 30);
  assert.equal(target.dead, true, "target should be destroyed");
  assert.equal(w.asteroids.length, len0, "array length unchanged (no splice)");
  assert.ok(
    w.asteroids.every((a, i) => a.id === i),
    "id===index broke after bombard destroy",
  );
  // every surviving seedling still points at a valid in-range body
  const s = w.seed;
  for (let i = 0; i < s.count; i++) {
    assert.ok(s.home[i] >= 0 && s.home[i] < len0, "home index still valid");
    assert.ok(s.target[i] < len0, "target index still in range");
    assert.ok(s.dest[i] < len0, "dest index still in range");
  }
});

test("same seed => identical layout", () => {
  const a = mk(42);
  const b = mk(42);
  assert.equal(a.asteroids.length, b.asteroids.length);
  for (let i = 0; i < a.asteroids.length; i++) {
    const x = a.asteroids[i];
    const y = b.asteroids[i];
    assert.equal(x.x, y.x);
    assert.equal(x.y, y.y);
    assert.equal(x.radius, y.radius);
    assert.equal(x.energyStat, y.energyStat);
    assert.equal(x.strengthStat, y.strengthStat);
    assert.equal(x.speedStat, y.speedStat);
    assert.equal(x.owner, y.owner);
  }
  assert.equal(a.seed.count, b.seed.count);
});

test("different seed => different layout", () => {
  const a = mk(1);
  const b = mk(2);
  const same =
    a.asteroids.length === b.asteroids.length &&
    a.asteroids.every(
      (x, i) => x.x === b.asteroids[i].x && x.y === b.asteroids[i].y,
    );
  assert.equal(same, false);
});

test("asteroid count and stat ranges", () => {
  const w = mk(7, 20);
  // Every map has exactly one central star (extra, non-habitable) plus the requested bodies.
  const stars = w.asteroids.filter(
    (a) => a.kind === "star" || a.kind === "blackhole",
  );
  assert.equal(stars.length, 1);
  assert.equal(
    w.asteroids.filter((a) => a.kind !== "star" && a.kind !== "blackhole")
      .length,
    20,
  );
  for (const a of w.asteroids) {
    for (const s of [a.energyStat, a.strengthStat, a.speedStat]) {
      assert.ok(s >= 0 && s <= 100, `stat ${s} out of range`);
      // Balance floor: no near-0 rock that dooms its seedlings on arrival.
      assert.ok(s >= STAT_MIN && s <= 100, `stat ${s} below floor ${STAT_MIN}`);
    }
  }
});

test("exactly one home per player, homes owned with energy", () => {
  const w = mk(9, 16, TWO);
  const homes = w.asteroids.filter((a) => a.owner !== OWNER_NEUTRAL);
  assert.equal(homes.length, 2);
  const owners = new Set(homes.map((a) => a.owner));
  assert.equal(owners.size, 2);
  assert.ok(owners.has(0) && owners.has(1));
  for (const h of homes) assert.ok(h.energy > 0);
});

test("homes have orbiting seedlings inheriting home stats", () => {
  const w = mk(11, 16, TWO);
  const s = w.seed;
  assert.ok(s.count > 0);
  const homes = w.asteroids.filter((a) => a.owner !== OWNER_NEUTRAL);
  for (const h of homes) {
    let n = 0;
    for (let i = 0; i < s.count; i++) {
      if (s.home[i] === h.id) {
        n++;
        assert.equal(s.state[i], STATE.ORBIT);
        assert.equal(s.owner[i], h.owner);
        assert.equal(s.strength[i], h.strengthStat);
        assert.equal(s.energy[i], h.energyStat);
      }
    }
    assert.ok(n >= 8, `home ${h.id} has ${n} orbiters`);
  }
});

test("no two asteroids overlap", () => {
  const w = mk(123, 24);
  const A = w.asteroids;
  for (let i = 0; i < A.length; i++) {
    for (let j = i + 1; j < A.length; j++) {
      // Moons orbit their planet and intentionally pass near other bodies — skip them.
      if (A[i].moon || A[j].moon) continue;
      const d = Math.hypot(A[i].x - A[j].x, A[i].y - A[j].y);
      assert.ok(d > A[i].radius + A[j].radius, `asteroids ${i},${j} overlap`);
    }
  }
});

test("homes spread apart (farthest-point seeding)", () => {
  const w = mk(55, 20, TWO);
  const homes = w.asteroids.filter((a) => a.owner !== OWNER_NEUTRAL);
  const d = Math.hypot(homes[0].x - homes[1].x, homes[0].y - homes[1].y);
  // Should be comfortably non-adjacent on a 1000x1000 map.
  assert.ok(d > 300, `homes only ${d} apart`);
});

// ── Map topology tests ──────────────────────────────────────────────────────

function mkLayout(seed, layout, count = 20) {
  return createWorld({
    seed,
    asteroidCount: count,
    layout,
    players: TWO,
    width: 2000,
    height: 2000,
  });
}

// BFS over neighbors to count connected components (non-dead bodies only).
function componentCount(asteroids) {
  const n = asteroids.length;
  const seen = new Uint8Array(n);
  let comps = 0;
  for (let start = 0; start < n; start++) {
    if (seen[start]) continue;
    comps++;
    const q = [start];
    seen[start] = 1;
    let qi = 0;
    while (qi < q.length) {
      const cur = q[qi++];
      for (const nb of asteroids[cur].neighbors) {
        if (!seen[nb]) {
          seen[nb] = 1;
          q.push(nb);
        }
      }
    }
  }
  return comps;
}

// MIN_GAP clearance check. Moons and binaries are repositioned post-placement (they orbit
// their parent/midpoint) and may end up inside MIN_GAP of other bodies by design — skip them.
function noOverlaps(asteroids) {
  const MIN_GAP = 150;
  for (let i = 0; i < asteroids.length; i++) {
    if (asteroids[i].moon || asteroids[i].binary) continue;
    for (let j = i + 1; j < asteroids.length; j++) {
      if (asteroids[j].moon || asteroids[j].binary) continue;
      const d = Math.hypot(
        asteroids[i].x - asteroids[j].x,
        asteroids[i].y - asteroids[j].y,
      );
      if (d < asteroids[i].radius + asteroids[j].radius + MIN_GAP)
        return { ok: false, i, j };
    }
  }
  return { ok: true };
}

for (const layout of ["scatter", "loop", "linear", "hub", "random"]) {
  test(`layout ${layout}: deterministic (same seed → identical bodies)`, () => {
    const a = mkLayout(77, layout);
    const b = mkLayout(77, layout);
    assert.equal(a.asteroids.length, b.asteroids.length);
    for (let i = 0; i < a.asteroids.length; i++) {
      assert.equal(a.asteroids[i].x, b.asteroids[i].x, `x mismatch at ${i}`);
      assert.equal(a.asteroids[i].y, b.asteroids[i].y, `y mismatch at ${i}`);
      assert.equal(
        a.asteroids[i].radius,
        b.asteroids[i].radius,
        `r mismatch at ${i}`,
      );
      assert.equal(
        a.asteroids[i].kind,
        b.asteroids[i].kind,
        `kind mismatch at ${i}`,
      );
    }
  });

  test(`layout ${layout}: connected graph`, () => {
    for (const seed of [7, 42, 123]) {
      const w = mkLayout(seed, layout, 20);
      const comps = componentCount(w.asteroids);
      assert.equal(comps, 1, `seed=${seed} has ${comps} components`);
    }
  });

  test(`layout ${layout}: no non-moon overlaps`, () => {
    for (const seed of [7, 42, 123]) {
      const w = mkLayout(seed, layout, 20);
      const r = noOverlaps(w.asteroids);
      assert.ok(r.ok, `seed=${seed} overlap at bodies ${r.i},${r.j}`);
    }
  });

  test(`layout ${layout}: id === index`, () => {
    const w = mkLayout(99, layout, 20);
    assert.ok(
      w.asteroids.every((a, i) => a.id === i),
      "id===index broken",
    );
  });
}

// Golden snapshot: scatter output must be byte-identical to pre-refactor for the same seeds.
const GOLDEN_S1 = [
  {
    x: 1084.5917904376984,
    y: 1040.7361699454486,
    radius: 176.8974335398525,
    kind: "blackhole",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 587.877729031519,
    y: 1629.6277402259332,
    radius: 146.0068279672414,
    kind: "planet",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 601.1548348091246,
    y: 250.00702415064296,
    radius: 114.27073280513287,
    kind: "planet",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 1275.8304409366428,
    y: 450.04167995447824,
    radius: 23.393842819612473,
    kind: "asteroid",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 1351.6552902638728,
    y: 426.50501701836504,
    radius: 18.88012628816068,
    kind: "asteroid",
    moon: true,
    orbitParent: 3,
  },
  {
    x: 80.52830414301565,
    y: 734.9698202715973,
    radius: 20.44074964337051,
    kind: "asteroid",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 1814.2192436190962,
    y: 584.8118733457301,
    radius: 33.83115633158013,
    kind: "asteroid",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 1941.0660661648194,
    y: 1119.238386109996,
    radius: 20.653036615345627,
    kind: "asteroid",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 1896.7397156597312,
    y: 549.3152771418746,
    radius: 18.479339888319373,
    kind: "asteroid",
    moon: true,
    orbitParent: 6,
  },
  {
    x: 404.193623602789,
    y: 931.8474441129905,
    radius: 37.90506080677733,
    kind: "asteroid",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 821.606158587489,
    y: 1662.3423251149254,
    radius: 14.273047698661685,
    kind: "asteroid",
    moon: true,
    orbitParent: 1,
  },
  {
    x: 1347.990527082309,
    y: 1572.1538081712522,
    radius: 19.044429416768253,
    kind: "asteroid",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 448.32525891966003,
    y: 824.3039899021334,
    radius: 30.34121130267158,
    kind: "asteroid",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 676.100510308483,
    y: 119.75941817749461,
    radius: 19.554379479959607,
    kind: "asteroid",
    moon: true,
    orbitParent: 2,
  },
  {
    x: 1443.148797099437,
    y: 1602.8930932531696,
    radius: 26.358461701776832,
    kind: "asteroid",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 1640.201915065398,
    y: 1742.0146431776698,
    radius: 29.564854849129915,
    kind: "asteroid",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 1454.8152908024413,
    y: 166.51268245779227,
    radius: 36.55024198302999,
    kind: "asteroid",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 502.34818271708997,
    y: 1468.9691514921062,
    radius: 19.813169797882438,
    kind: "asteroid",
    moon: true,
    orbitParent: 1,
  },
  {
    x: 1532.2979713123211,
    y: 431.6588326032627,
    radius: 35.45857181400061,
    kind: "asteroid",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 1704.5975360242328,
    y: 867.6914591901719,
    radius: 19.524560176301748,
    kind: "asteroid",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 1573.0635657657551,
    y: 1050.8580170744967,
    radius: 30.073781343642622,
    kind: "asteroid",
    moon: false,
    orbitParent: -1,
  },
];
const GOLDEN_S2 = [
  {
    x: 954.2396576702595,
    y: 1065.4465574398637,
    radius: 188.08676458429545,
    kind: "star",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 755.2717646919975,
    y: 216.7057189143113,
    radius: 124.41626219823956,
    kind: "planet",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 1449.0844695128378,
    y: 1758.1722657080406,
    radius: 116.51279002986848,
    kind: "planet",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 682.0889544822261,
    y: 73.9554002896059,
    radius: 12.833899991586804,
    kind: "asteroid",
    moon: true,
    orbitParent: 1,
  },
  {
    x: 781.6787736146769,
    y: 1533.2593766664868,
    radius: 34.53530789213255,
    kind: "asteroid",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 1540.5266034463327,
    y: 1184.154958373389,
    radius: 18.15356445265934,
    kind: "asteroid",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 1473.0609060146767,
    y: 1153.379468270144,
    radius: 19.988606810569763,
    kind: "asteroid",
    moon: true,
    orbitParent: 5,
  },
  {
    x: 1604.5040260038982,
    y: 162.06015948553966,
    radius: 26.225295445881784,
    kind: "asteroid",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 554.3215526862698,
    y: 1541.7962541553065,
    radius: 35.48903154022992,
    kind: "asteroid",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 645.5461170597578,
    y: 1534.8448696143294,
    radius: 13.67209898866713,
    kind: "asteroid",
    moon: true,
    orbitParent: 8,
  },
  {
    x: 320.53014931914237,
    y: 1027.5934071280485,
    radius: 23.52287445263937,
    kind: "asteroid",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 1781.2074677172832,
    y: 1129.1213872388712,
    radius: 18.353889126796275,
    kind: "asteroid",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 126.19517338904166,
    y: 1892.13668576058,
    radius: 36.2457709335722,
    kind: "asteroid",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 429.11662174410327,
    y: 1048.3389463891722,
    radius: 39.02756377775222,
    kind: "asteroid",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 1816.1704824645544,
    y: 1222.8101677826594,
    radius: 31.574581728316844,
    kind: "asteroid",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 814.2137482449642,
    y: 1765.8445819456228,
    radius: 23.573225762229413,
    kind: "asteroid",
    moon: false,
    orbitParent: -1,
  },
  {
    x: 1601.1413833171864,
    y: 1746.3889687589003,
    radius: 13.7081687040627,
    kind: "asteroid",
    moon: true,
    orbitParent: 2,
  },
];

test("scatter: byte-identical to pre-refactor golden snapshots", () => {
  const w1 = mkLayout(42, "scatter", 20);
  assert.equal(
    w1.asteroids.length,
    GOLDEN_S1.length,
    "length mismatch seed=42",
  );
  for (let i = 0; i < GOLDEN_S1.length; i++) {
    const g = GOLDEN_S1[i];
    const a = w1.asteroids[i];
    assert.equal(a.x, g.x, `seed=42 body ${i} x`);
    assert.equal(a.y, g.y, `seed=42 body ${i} y`);
    assert.equal(a.radius, g.radius, `seed=42 body ${i} radius`);
    assert.equal(a.kind, g.kind, `seed=42 body ${i} kind`);
    assert.equal(a.moon, g.moon, `seed=42 body ${i} moon`);
    assert.equal(a.orbitParent, g.orbitParent, `seed=42 body ${i} orbitParent`);
  }

  const w2 = mkLayout(999, "scatter", 16);
  assert.equal(
    w2.asteroids.length,
    GOLDEN_S2.length,
    "length mismatch seed=999",
  );
  for (let i = 0; i < GOLDEN_S2.length; i++) {
    const g = GOLDEN_S2[i];
    const a = w2.asteroids[i];
    assert.equal(a.x, g.x, `seed=999 body ${i} x`);
    assert.equal(a.y, g.y, `seed=999 body ${i} y`);
    assert.equal(a.radius, g.radius, `seed=999 body ${i} radius`);
    assert.equal(a.kind, g.kind, `seed=999 body ${i} kind`);
    assert.equal(a.moon, g.moon, `seed=999 body ${i} moon`);
    assert.equal(
      a.orbitParent,
      g.orbitParent,
      `seed=999 body ${i} orbitParent`,
    );
  }
});

// scatter with no explicit layout should also be byte-identical (default path).
test("scatter: default (no layout) matches golden seed=42", () => {
  const w = createWorld({
    seed: 42,
    asteroidCount: 20,
    players: TWO,
    width: 2000,
    height: 2000,
  });
  assert.equal(w.asteroids.length, GOLDEN_S1.length);
  for (let i = 0; i < GOLDEN_S1.length; i++) {
    assert.equal(w.asteroids[i].x, GOLDEN_S1[i].x, `body ${i} x`);
    assert.equal(w.asteroids[i].y, GOLDEN_S1[i].y, `body ${i} y`);
  }
});

test("config.startTree: each spawn home gets one mature seedling tree (opt-in)", () => {
  const cfg = (startTree) => ({
    seed: 5,
    asteroidCount: 20,
    planetMin: 1,
    planetMax: 2,
    startTree,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 1 },
    ],
  });
  // ON (real matches): every player's home owns exactly one MATURE seedling tree.
  const on = createWorld(cfg(true));
  for (const p of on.players) {
    const home = on.asteroids.find((a) => a.owner === p.id);
    const seedlings = home.trees.filter((t) => t.type === "seedling");
    assert.equal(
      seedlings.length,
      1,
      `home of player ${p.id} has one seedling tree`,
    );
    assert.equal(
      seedlings[0].growth,
      1,
      "the starting tree is mature (produces from t=0)",
    );
  }
  // OFF (default — tutorial + unit tests): homes start pristine.
  const off = createWorld(cfg(false));
  for (const p of off.players) {
    const home = off.asteroids.find((a) => a.owner === p.id);
    assert.equal(
      home.trees.length,
      0,
      `home of player ${p.id} is tree-free by default`,
    );
  }
});
