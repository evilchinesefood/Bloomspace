import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, OWNER_NEUTRAL, STATE } from "./World.js";

const TWO = [
  { id: 0, isAi: false, difficulty: 0 },
  { id: 1, isAi: true, difficulty: 1 },
];

function mk(seed, count = 16, players = TWO) {
  return createWorld({
    seed,
    asteroidCount: count,
    players,
    width: 1000,
    height: 1000,
  });
}

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
  assert.equal(w.asteroids.length, 20);
  for (const a of w.asteroids) {
    for (const s of [a.energyStat, a.strengthStat, a.speedStat]) {
      assert.ok(s >= 0 && s <= 100, `stat ${s} out of range`);
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
