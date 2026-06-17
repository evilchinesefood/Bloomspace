import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, OWNER_NEUTRAL } from "./World.js";
import {
  TECH,
  MAX_TIER,
  TECH_COST,
  techCost,
  buyTech,
  ownerStrengthMult,
  ownerSpeedMult,
  ownerRegenMult,
} from "./Tech.js";
import { resolveCombat } from "./Combat.js";
import { updateEconomy } from "./Economy.js";
import { updateSeedlings } from "./Seedlings.js";
import { STATE } from "./World.js";
import Sim from "./World.js";

const DT = 1 / 30;

function world(seed = 1, players) {
  return createWorld({
    seed,
    asteroidCount: 8,
    players: players ?? [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 1 },
    ],
    width: 4000,
    height: 4000,
  });
}

// --- 1. cost gating ---------------------------------------------------------

test("buyTech: insufficient seeds → false + NO mutation", () => {
  const w = world();
  const p = w.players[0];
  p.seeds = 10; // first tier costs 15
  const before = p.seeds;
  assert.equal(buyTech(w, 0, TECH.STRENGTH), false);
  assert.equal(p.seeds, before, "seeds unchanged");
  assert.equal(p.tech.strength, 0, "level unchanged");
});

test("buyTech: affordable → true, deducts EXACTLY TECH_COST[level], increments level", () => {
  const w = world();
  const p = w.players[0];
  p.seeds = 100;
  assert.equal(buyTech(w, 0, TECH.STRENGTH), true);
  assert.equal(p.seeds, 100 - TECH_COST[0], "deducts exactly first-tier cost");
  assert.equal(p.tech.strength, 1, "level +1");
});

test("buyTech: invalid track / unknown player → false, no mutation", () => {
  const w = world();
  const p = w.players[0];
  p.seeds = 100;
  assert.equal(buyTech(w, 0, "bogus"), false);
  assert.equal(buyTech(w, 99, TECH.STRENGTH), false);
  assert.equal(p.seeds, 100);
  assert.equal(p.tech.strength, 0);
});

// --- 2. escalating cost + max-tier guard ------------------------------------

test("escalating cost: 15, 30, 60 across the three tiers; 4th buy at MAX → false", () => {
  const w = world();
  const p = w.players[0];
  p.seeds = 1000;
  let spent = 0;
  for (let i = 0; i < MAX_TIER; i++) {
    const before = p.seeds;
    assert.equal(buyTech(w, 0, TECH.SPEED), true, `tier ${i} should buy`);
    spent += before - p.seeds;
    assert.equal(
      before - p.seeds,
      TECH_COST[i],
      `tier ${i} costs ${TECH_COST[i]}`,
    );
  }
  assert.equal(spent, 15 + 30 + 60, "total spend 105");
  assert.equal(p.tech.speed, MAX_TIER);
  // 4th buy at MAX_TIER → false, no mutation
  const beforeSeeds = p.seeds;
  assert.equal(buyTech(w, 0, TECH.SPEED), false, "no buy past MAX_TIER");
  assert.equal(p.seeds, beforeSeeds, "seeds unchanged at max");
  assert.equal(p.tech.speed, MAX_TIER, "level pinned at MAX_TIER");
});

test("techCost returns null at/above MAX_TIER", () => {
  assert.equal(techCost(0), 15);
  assert.equal(techCost(2), 60);
  assert.equal(techCost(MAX_TIER), null);
  assert.equal(techCost(MAX_TIER + 5), null);
});

// --- 3. multipliers keyed to the RIGHT owner --------------------------------

test("strength mult keyed to owner: L3 owner 0 → 1.45, un-teched owner 1 → 1.0", () => {
  const w = world();
  w.players[0].seeds = 1000;
  buyTech(w, 0, TECH.STRENGTH);
  buyTech(w, 0, TECH.STRENGTH);
  buyTech(w, 0, TECH.STRENGTH);
  assert.ok(Math.abs(ownerStrengthMult(w, 0) - 1.45) < 1e-9, "owner 0 = 1.45");
  assert.equal(ownerStrengthMult(w, 1), 1, "owner 1 (no tech) = 1.0");
  assert.equal(ownerStrengthMult(w, OWNER_NEUTRAL), 1, "neutral = 1.0");
});

test("speed mult keyed to owner: a speed-teched owner's ship covers more ground", () => {
  // Two identical worlds (same seed/map). Give owner 0 max speed tech in one. Put one of each
  // world's owner-0 ships into TRANSIT toward the same far body from the same start, step ONLY
  // the seedling system, and confirm the teched ship travels measurably farther per tick.
  const cfg = () => ({
    seed: 5,
    asteroidCount: 8,
    players: [{ id: 0, isAi: false, difficulty: 0 }],
    width: 4000,
    height: 4000,
  });
  const slow = createWorld(cfg());
  const fast = createWorld(cfg());
  fast.players[0].seeds = 1000;
  buyTech(fast, 0, TECH.SPEED);
  buyTech(fast, 0, TECH.SPEED);
  buyTech(fast, 0, TECH.SPEED);
  assert.ok(
    Math.abs(ownerSpeedMult(fast, 0) - 1.36) < 1e-9,
    "owner 0 speed = 1.36",
  );
  assert.equal(ownerSpeedMult(slow, 0), 1, "no-tech speed = 1.0");

  const firstOwned = (w) => {
    const s = w.seed;
    for (let i = 0; i < s.count; i++) if (s.owner[i] === 0) return i;
    return -1;
  };
  const launchToFar = (w, idx) => {
    const s = w.seed;
    const home = s.home[idx];
    const ha = w.asteroids[home];
    let dest = 0,
      bestD = -1;
    for (let a = 0; a < w.asteroids.length; a++) {
      if (a === home) continue;
      const dx = w.asteroids[a].x - ha.x;
      const dy = w.asteroids[a].y - ha.y;
      const d = dx * dx + dy * dy;
      if (d > bestD) {
        bestD = d;
        dest = a;
      }
    }
    s.state[idx] = STATE.TRANSIT;
    s.target[idx] = dest;
    s.dest[idx] = dest;
    s.x[idx] = ha.x;
    s.y[idx] = ha.y;
  };
  const is = firstOwned(slow);
  const ifa = firstOwned(fast);
  launchToFar(slow, is);
  launchToFar(fast, ifa);
  const x0s = slow.seed.x[is],
    y0s = slow.seed.y[is];
  const x0f = fast.seed.x[ifa],
    y0f = fast.seed.y[ifa];
  for (let t = 0; t < 10; t++) {
    updateSeedlings(slow, DT);
    updateSeedlings(fast, DT);
  }
  const distSlow = Math.hypot(slow.seed.x[is] - x0s, slow.seed.y[is] - y0s);
  const distFast = Math.hypot(fast.seed.x[ifa] - x0f, fast.seed.y[ifa] - y0f);
  assert.ok(
    distFast > distSlow * 1.3,
    `speed-teched ship covers more ground: fast ${distFast.toFixed(1)} vs slow ${distSlow.toFixed(1)}`,
  );
});

test("combat: a strength-teched owner's ships deal more damage to the right enemy", () => {
  // Two enemy ships adjacent. Damage to the enemy = attacker.strength * mult. Give owner 0
  // strength tech and confirm owner 1's ship takes MORE damage than the symmetric un-teched case.
  function setup() {
    const w = world(3, [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: false, difficulty: 0 },
    ]);
    const s = w.seed;
    s.count = 0; // clear auto-seeded ships; build a clean 2-ship duel
    // ship 0 owner 0, ship 1 owner 1, placed within CONTACT_RADIUS, same strength/energy.
    const mk = (owner, x) => {
      const i = s.count++;
      s.owner[i] = owner;
      s.x[i] = x;
      s.y[i] = 0;
      s.px[i] = x;
      s.py[i] = 0;
      s.home[i] = 0;
      s.target[i] = -1;
      s.dest[i] = -1;
      s.state[i] = 0; // ORBIT
      s.strength[i] = 50;
      s.energy[i] = 100;
      s.kind[i] = 0;
      s.orbitRadius[i] = 80;
      s.orbitAngle[i] = 0;
      s.slingRem[i] = 0;
      return i;
    };
    mk(0, 0);
    mk(1, 5); // 5 units apart < CONTACT_RADIUS (14)
    return w;
  }
  const base = setup();
  resolveCombat(base, DT);
  // energy of owner-1 ship after one tick, no tech
  const baseEnemyEnergy = base.seed.energy[1];

  const teched = setup();
  teched.players[0].seeds = 1000;
  buyTech(teched, 0, TECH.STRENGTH); // owner 0 now hits harder
  resolveCombat(teched, DT);
  const techEnemyEnergy = teched.seed.energy[1];

  assert.ok(
    techEnemyEnergy < baseEnemyEnergy - 1e-9,
    `strength-teched owner 0 should deplete enemy faster: ${techEnemyEnergy} < ${baseEnemyEnergy}`,
  );
  // And owner 0's own ship (the defender vs un-teched enemy) takes the SAME damage in both —
  // the tech buffs only owner 0's outgoing damage, keyed to the right owner.
  assert.ok(
    Math.abs(teched.seed.energy[0] - base.seed.energy[0]) < 1e-9,
    "owner 0's own ship takes identical damage (enemy un-teched in both)",
  );
});

test("regen: a regen-teched owner's rock gains energy faster than an un-teched twin", () => {
  const w = world(4, [{ id: 0, isAi: false, difficulty: 0 }]);
  const base = w.asteroids.find((a) => a.owner === 0);
  base.owner = 0;
  base.energyStat = 100;
  base.energyMult = 1;
  base.energy = 0;
  // build an identical un-teched twin owned by a second player
  w.players.push({
    id: 1,
    isAi: false,
    difficulty: 0,
    seeds: 0,
    tech: { strength: 0, speed: 0, regen: 0 },
  });
  const twin = {
    ...base,
    owner: 1,
    energy: 0,
    trees: [],
  };
  w.asteroids.push(twin);
  ownerRegenMult; // ensure imported
  // give owner 0 regen tech
  w.players[0].seeds = 1000;
  buyTech(w, 0, TECH.REGEN);
  buyTech(w, 0, TECH.REGEN);
  buyTech(w, 0, TECH.REGEN);
  assert.ok(Math.abs(ownerRegenMult(w, 0) - 1.6) < 1e-9, "owner 0 regen = 1.6");
  assert.equal(ownerRegenMult(w, 1), 1, "owner 1 regen = 1.0");
  for (let t = 0; t < 20; t++) updateEconomy(w, DT);
  assert.ok(
    base.energy > twin.energy + 1e-6,
    `regen-teched rock gains faster: ${base.energy} > ${twin.energy}`,
  );
  // ratio should track the multiplier (rate scaled 1.6×, below cap)
  assert.ok(
    Math.abs(base.energy / twin.energy - 1.6) < 1e-6,
    "energy ratio matches the 1.6× regen multiplier",
  );
});

// --- 4. level-0 no-op (guards the existing 83 tests) ------------------------

test("level-0 no-op: all three ownerXMult return EXACTLY 1.0 with no tech", () => {
  const w = world();
  for (const id of [0, 1, OWNER_NEUTRAL, 99]) {
    assert.equal(ownerStrengthMult(w, id), 1, `strength mult 1.0 for ${id}`);
    assert.equal(ownerSpeedMult(w, id), 1, `speed mult 1.0 for ${id}`);
    assert.equal(ownerRegenMult(w, id), 1, `regen mult 1.0 for ${id}`);
  }
});

// --- 5. determinism with tech active ----------------------------------------

test("determinism: same seed + same scripted buyTech ⇒ identical state after N ticks", () => {
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
  // Identical scripted human tech purchases on both.
  const script = [TECH.STRENGTH, TECH.SPEED, TECH.STRENGTH, TECH.REGEN];
  for (const w of [wa, wb]) {
    w.players[0].seeds += 200; // afford the script
    for (const track of script) buyTech(w, 0, track);
  }
  for (let t = 0; t < 1500; t++) {
    Sim.step(wa, DT);
    Sim.step(wb, DT);
  }
  assert.equal(wa.seed.count, wb.seed.count, "seed count diverged");
  assert.equal(wa.status, wb.status, "status diverged");
  for (let i = 0; i < wa.asteroids.length; i++) {
    assert.equal(
      wa.asteroids[i].owner,
      wb.asteroids[i].owner,
      "owner diverged",
    );
    assert.ok(
      Math.abs(wa.asteroids[i].energy - wb.asteroids[i].energy) < 1e-9,
      "energy diverged",
    );
  }
  for (let i = 0; i < wa.seed.count; i++) {
    assert.equal(wa.seed.owner[i], wb.seed.owner[i]);
    assert.ok(Math.abs(wa.seed.x[i] - wb.seed.x[i]) < 1e-6);
    assert.ok(Math.abs(wa.seed.y[i] - wb.seed.y[i]) < 1e-6);
  }
  // And the tech state itself matched.
  for (const track of Object.values(TECH))
    assert.equal(wa.players[0].tech[track], wb.players[0].tech[track]);
});

// --- 6. AI buys tech --------------------------------------------------------

test("AI on a develop-capable difficulty eventually has tech level > 0 (deterministic)", () => {
  function run(seed) {
    const w = createWorld({
      seed,
      asteroidCount: 12,
      players: [
        { id: 0, isAi: false, difficulty: 0 },
        { id: 1, isAi: true, difficulty: 3 }, // Brutal develops + invests most
      ],
    });
    w.players[1].seeds = 200; // seed it with plenty so tech is comfortably affordable
    for (let t = 0; t < 3000; t++) Sim.step(w, DT);
    const tech = w.players[1].tech;
    return tech.strength + tech.speed + tech.regen;
  }
  const total = run(7);
  assert.ok(total > 0, "AI should have bought at least one tech tier");
  // Determinism: same seed ⇒ same outcome.
  assert.equal(run(7), total, "AI tech outcome must be deterministic");
});

test("Easy AI never buys tech (same gate as planting)", () => {
  const w = createWorld({
    seed: 7,
    asteroidCount: 12,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 0 }, // Easy: never develops
    ],
  });
  w.players[1].seeds = 500;
  for (let t = 0; t < 3000; t++) Sim.step(w, DT);
  const tech = w.players[1].tech;
  assert.equal(
    tech.strength + tech.speed + tech.regen,
    0,
    "Easy AI buys no tech",
  );
});
