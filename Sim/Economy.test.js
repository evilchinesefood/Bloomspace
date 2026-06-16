import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, OWNER_NEUTRAL } from "./World.js";
import { updateEconomy, spendEnergy, ENERGY_MAX } from "./Economy.js";

const DT = 1 / 30;

function world(seed = 1) {
  return createWorld({
    seed,
    asteroidCount: 6,
    players: [{ id: 0, isAi: false, difficulty: 0 }],
    width: 4000,
    height: 4000,
  });
}

function ownedRock(w) {
  return w.asteroids.find((a) => a.owner === 0);
}
function neutralRock(w) {
  return w.asteroids.find((a) => a.owner === OWNER_NEUTRAL);
}

test("owned asteroid energy rises over time and caps at ENERGY_MAX", () => {
  const w = world();
  const rock = ownedRock(w);
  rock.energyMult = 1; // test plain-asteroid cap (planets store energyMult× more)
  rock.energyStat = 100;
  rock.energy = 0;
  const e0 = rock.energy;
  for (let t = 0; t < 30; t++) updateEconomy(w, DT);
  assert.ok(rock.energy > e0, "energy should rise");
  // run long enough to saturate
  for (let t = 0; t < 100000; t++) updateEconomy(w, DT);
  assert.ok(rock.energy <= ENERGY_MAX + 1e-6, "must not exceed cap");
  assert.ok(rock.energy >= ENERGY_MAX - 1e-6, "should reach cap");
});

test("neutral asteroid energy does NOT rise", () => {
  const w = world();
  const rock = neutralRock(w);
  rock.energy = 0;
  for (let t = 0; t < 1000; t++) updateEconomy(w, DT);
  assert.equal(rock.energy, 0, "neutral rock must not regenerate");
});

test("energyStat scales regen rate", () => {
  const w = world();
  const a = ownedRock(w);
  a.energy = 0;
  a.energyStat = 100;
  // second owned rock via cloning a neutral one
  const b = { ...neutralRock(w), owner: 0, energy: 0, energyStat: 10 };
  w.asteroids.push(b);
  for (let t = 0; t < 30; t++) updateEconomy(w, DT);
  assert.ok(a.energy > b.energy, "higher energyStat regenerates faster");
});

test("spendEnergy deducts when affordable, refuses when not, never negative", () => {
  const rock = { energy: 50 };
  assert.equal(spendEnergy(rock, 20), true);
  assert.equal(rock.energy, 30);
  assert.equal(spendEnergy(rock, 100), false, "can't overspend");
  assert.equal(rock.energy, 30, "no-op on refusal");
  assert.equal(spendEnergy(rock, 30), true);
  assert.equal(rock.energy, 0);
  assert.ok(rock.energy >= 0, "never negative");
  assert.equal(spendEnergy(rock, 1), false, "empty rock refuses");
  assert.equal(rock.energy, 0);
});

test("determinism: same seed ⇒ identical energy after N ticks", () => {
  const wa = world(7);
  const wb = world(7);
  for (let t = 0; t < 500; t++) {
    updateEconomy(wa, DT);
    updateEconomy(wb, DT);
  }
  for (let i = 0; i < wa.asteroids.length; i++) {
    assert.ok(Math.abs(wa.asteroids[i].energy - wb.asteroids[i].energy) < 1e-9);
  }
});
