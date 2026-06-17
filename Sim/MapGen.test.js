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
