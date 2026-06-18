import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld } from "./World.js";
import {
  UPGRADE,
  MAX_TIER,
  UPGRADE_COST,
  STAT_DELTA,
  upgradeCost,
  upgradeTier,
  canUpgrade,
  buyUpgrade,
} from "./Upgrade.js";
import { serialize, deserialize } from "./Save.js";

function world(seed = 1) {
  return createWorld({
    seed,
    asteroidCount: 8,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 1 },
    ],
    width: 4000,
    height: 4000,
  });
}

// Return the first rock owned by `owner` that is habitable and not dead.
function ownedRock(w, owner) {
  return w.asteroids.find((a) => a.owner === owner && !a.dead && a.habitable);
}

// Give player seeds and return the rock id.
function setup(w, owner = 0, seeds = 500) {
  const p = w.players.find((p) => p.id === owner);
  p.seeds = seeds;
  const rock = ownedRock(w, owner);
  assert.ok(rock, `player ${owner} must own a habitable rock`);
  return rock;
}

// --- 1. Cost gating ---------------------------------------------------------

test("buyUpgrade: insufficient seeds → false, no stat change, no deduction", () => {
  const w = world();
  const rock = setup(w, 0, 5); // first tier costs 20
  const before = rock.energyStat;
  const beforeSeeds = w.players[0].seeds;
  assert.equal(buyUpgrade(w, rock.id, UPGRADE.ENERGY, 0), false);
  assert.equal(rock.energyStat, before, "energyStat unchanged");
  assert.equal(w.players[0].seeds, beforeSeeds, "seeds unchanged");
  assert.equal(upgradeTier(rock, UPGRADE.ENERGY), 0, "tier unchanged");
});

// --- 2. Applied per tier ----------------------------------------------------

test("buyUpgrade: success raises stat by STAT_DELTA and deducts escalating cost; tier increments", () => {
  const w = world();
  const rock = setup(w, 0, 1000);
  const base = rock.energyStat;

  // tier 0 → 1
  assert.equal(buyUpgrade(w, rock.id, UPGRADE.ENERGY, 0), true);
  assert.equal(
    rock.energyStat,
    base + STAT_DELTA,
    "energyStat +STAT_DELTA after tier 1",
  );
  assert.equal(
    w.players[0].seeds,
    1000 - UPGRADE_COST[0],
    "deducted tier-0 cost",
  );
  assert.equal(upgradeTier(rock, UPGRADE.ENERGY), 1);

  // tier 1 → 2
  const seeds1 = w.players[0].seeds;
  assert.equal(buyUpgrade(w, rock.id, UPGRADE.ENERGY, 0), true);
  assert.equal(rock.energyStat, base + STAT_DELTA * 2);
  assert.equal(w.players[0].seeds, seeds1 - UPGRADE_COST[1]);
  assert.equal(upgradeTier(rock, UPGRADE.ENERGY), 2);

  // tier 2 → 3
  const seeds2 = w.players[0].seeds;
  assert.equal(buyUpgrade(w, rock.id, UPGRADE.ENERGY, 0), true);
  assert.equal(rock.energyStat, base + STAT_DELTA * 3);
  assert.equal(w.players[0].seeds, seeds2 - UPGRADE_COST[2]);
  assert.equal(upgradeTier(rock, UPGRADE.ENERGY), MAX_TIER);
});

test("buyUpgrade: all three stats upgrade independently", () => {
  const w = world();
  const rock = setup(w, 0, 1000);
  const eb = rock.energyStat,
    sb = rock.strengthStat,
    spb = rock.speedStat;
  assert.equal(buyUpgrade(w, rock.id, UPGRADE.ENERGY, 0), true);
  assert.equal(buyUpgrade(w, rock.id, UPGRADE.STRENGTH, 0), true);
  assert.equal(buyUpgrade(w, rock.id, UPGRADE.SPEED, 0), true);
  assert.equal(rock.energyStat, eb + STAT_DELTA);
  assert.equal(rock.strengthStat, sb + STAT_DELTA);
  assert.equal(rock.speedStat, spb + STAT_DELTA);
});

// --- 3. Max-tier cap --------------------------------------------------------

test("buyUpgrade: can't buy past MAX_TIER → returns false, no mutation", () => {
  const w = world();
  const rock = setup(w, 0, 2000);
  for (let i = 0; i < MAX_TIER; i++)
    assert.equal(buyUpgrade(w, rock.id, UPGRADE.STRENGTH, 0), true);
  assert.equal(upgradeTier(rock, UPGRADE.STRENGTH), MAX_TIER);
  assert.equal(canUpgrade(rock, UPGRADE.STRENGTH), false);
  const seedsBefore = w.players[0].seeds;
  const statBefore = rock.strengthStat;
  assert.equal(
    buyUpgrade(w, rock.id, UPGRADE.STRENGTH, 0),
    false,
    "no buy past MAX_TIER",
  );
  assert.equal(rock.strengthStat, statBefore, "stat pinned at MAX");
  assert.equal(w.players[0].seeds, seedsBefore, "seeds unchanged at MAX");
});

// --- 4. Wrong owner ---------------------------------------------------------

test("buyUpgrade: non-owner → false, no mutation", () => {
  const w = world();
  const rock = setup(w, 0, 500);
  // Give player 1 seeds too but try to upgrade player 0's rock as player 1.
  w.players[1].seeds = 500;
  const before = rock.energyStat;
  assert.equal(buyUpgrade(w, rock.id, UPGRADE.ENERGY, 1), false);
  assert.equal(rock.energyStat, before, "stat unchanged");
  // Unknown player also blocked.
  assert.equal(buyUpgrade(w, rock.id, UPGRADE.ENERGY, 99), false);
});

// --- 5. Survives capture ----------------------------------------------------

test("buyUpgrade: boosted stat + rock.upgrades persist after ownership flip", () => {
  const w = world(2);
  const rock = setup(w, 0, 500);
  const baseStat = rock.energyStat;
  assert.equal(buyUpgrade(w, rock.id, UPGRADE.ENERGY, 0), true);
  assert.equal(
    rock.energyStat,
    baseStat + STAT_DELTA,
    "boosted before capture",
  );
  assert.equal(upgradeTier(rock, UPGRADE.ENERGY), 1);

  // Simulate capture by directly setting owner (mirrors how other tests flip ownership).
  rock.owner = 1;
  assert.equal(rock.owner, 1, "rock now owned by player 1");

  // Boosted stat + tier persist on the rock object.
  assert.equal(rock.energyStat, baseStat + STAT_DELTA, "stat survives capture");
  assert.equal(upgradeTier(rock, UPGRADE.ENERGY), 1, "tier survives capture");

  // New owner can continue upgrading from current tier.
  w.players[1].seeds = 500;
  assert.equal(
    buyUpgrade(w, rock.id, UPGRADE.ENERGY, 1),
    true,
    "new owner can upgrade",
  );
  assert.equal(rock.energyStat, baseStat + STAT_DELTA * 2);
  assert.equal(upgradeTier(rock, UPGRADE.ENERGY), 2);
});

// --- 6. Survives save/resume ------------------------------------------------

test("buyUpgrade: boosted stats and rock.upgrades survive serialize → deserialize", () => {
  const w = world(3);
  const rock = setup(w, 0, 500);
  const baseE = rock.energyStat;
  const baseS = rock.strengthStat;

  assert.equal(buyUpgrade(w, rock.id, UPGRADE.ENERGY, 0), true);
  assert.equal(buyUpgrade(w, rock.id, UPGRADE.STRENGTH, 0), true);

  const saved = serialize(w);
  const w2 = deserialize(saved);
  assert.ok(w2, "deserialized ok");

  const r2 = w2.asteroids[rock.id];
  assert.equal(r2.energyStat, baseE + STAT_DELTA, "energyStat round-tripped");
  assert.equal(
    r2.strengthStat,
    baseS + STAT_DELTA,
    "strengthStat round-tripped",
  );
  assert.equal(upgradeTier(r2, UPGRADE.ENERGY), 1, "energy tier round-tripped");
  assert.equal(
    upgradeTier(r2, UPGRADE.STRENGTH),
    1,
    "strength tier round-tripped",
  );
  assert.equal(upgradeTier(r2, UPGRADE.SPEED), 0, "speed tier still 0");

  // Can keep upgrading in the resumed world.
  w2.players[0].seeds = 500;
  assert.equal(buyUpgrade(w2, r2.id, UPGRADE.ENERGY, 0), true);
  assert.equal(r2.energyStat, baseE + STAT_DELTA * 2);
});

// --- 7. upgradeCost helpers -------------------------------------------------

test("upgradeCost returns UPGRADE_COST[tier] for valid tiers, null at/above MAX_TIER", () => {
  for (let i = 0; i < MAX_TIER; i++)
    assert.equal(upgradeCost(i), UPGRADE_COST[i], `tier ${i}`);
  assert.equal(upgradeCost(MAX_TIER), null);
  assert.equal(upgradeCost(MAX_TIER + 1), null);
  assert.equal(upgradeCost(-1), null);
});
