// Sim/Trees.js — tree growth, seedling production, flowering→seeds, defender spawning.
// NO three.js (headless). Deterministic: timers live on each tree object; no randomness
// except via spawnSeedling (which uses world.rng for orbit placement).
//
// Seedling trees: ramp growth → maturity, then periodically spend rock energy to spawn an
// orbiter, and on a separate timer flower into seeds for the owning player.
// Defense trees: periodically spawn defender orbiters (normal seedlings) up to a cap; the
// T4 combat layer makes them auto-attack intruders by proximity.
import { spawnSeedling, OWNER_NEUTRAL, KIND } from "./World.js";
import { spendEnergy } from "./Economy.js";
import { launchSeedling } from "./Seedlings.js";
import { RICH_SEED_BONUS } from "./MapGen.js";
import {
  BATTERY_SIZE,
  BOMBARD_SEED_COST,
  BOMBARD_ENERGY_COST,
  countBombard,
  matureBombardCount,
} from "./Bombard.js";

// Re-export the bombard counters so callers (AI/UI/tests) can read battery state via Trees.
export { countBombard, matureBombardCount, BATTERY_SIZE };

export const TREE_SEED_COST = 5; // player seeds to plant any (non-bombard) tree
export const TREE_ENERGY_COST = 30; // asteroid energy to plant any (non-bombard) tree
export const GROW_TIME = 8; // seconds for growth 0 → 1 (maturity)

export const PRODUCE_INTERVAL = 4; // seedling tree: seconds between orbiter spawns
export const SEEDLING_ENERGY_COST = 8; // energy spent per produced orbiter
export const FLOWER_INTERVAL = 6; // seconds between flower→seeds payouts
export const FLOWER_SEEDS = 2; // seeds added to owner per flower

export const DEFENSE_INTERVAL = 5; // defense tree: seconds between defender spawns
export const DEFENDER_ENERGY_COST = 6; // energy per defender spawn
export const DEFENDERS_PER_TREE = 6; // defenders per mature defense tree

function playerById(world, id) {
  const ps = world.players;
  for (let i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i];
  return null;
}

// Count living defenders (KIND.DEFENDER) owned by `owner` home'd at `rockId`, any state
// (in-transit defenders still count — same rationale as the old homedCount).
function defenderCount(world, rockId, owner) {
  const s = world.seed;
  let n = 0;
  for (let i = 0; i < s.count; i++) {
    if (
      s.home[i] === rockId &&
      s.owner[i] === owner &&
      s.kind[i] === KIND.DEFENDER
    )
      n++;
  }
  return n;
}

// Mature defense trees on a rock (growth >= 1). Mirrors matureBombardCount.
function matureDefenseCount(rock) {
  const trees = rock.trees;
  let n = 0;
  for (let i = 0; i < trees.length; i++)
    if (trees[i].type === "defense" && (trees[i].growth ?? 0) >= 1) n++;
  return n;
}

// plantTree — owner must own the rock and afford both seeds + energy. Deducts both and
// appends a fresh tree on success. Returns true; otherwise no mutation and returns false.
export function plantTree(world, asteroidId, type, owner) {
  const rock = world.asteroids[asteroidId];
  if (
    !rock ||
    rock.dead ||
    rock.owner === OWNER_NEUTRAL ||
    rock.owner !== owner
  )
    return false;
  const player = playerById(world, owner);
  if (!player) return false;
  // Bombard trees: escalating cost by current battery count, capped at BATTERY_SIZE. They only
  // grow to maturity (no produce/flower) — see updateTrees. Cost is NOT the flat seedling cost.
  if (type === "bombard") {
    const count = countBombard(rock);
    if (count >= BATTERY_SIZE) return false; // battery full
    const seedCost = BOMBARD_SEED_COST[count];
    const energyCost = BOMBARD_ENERGY_COST[count];
    if ((player.seeds ?? 0) < seedCost || rock.energy < energyCost)
      return false;
    player.seeds -= seedCost;
    spendEnergy(rock, energyCost);
    rock.trees.push({ type: "bombard", level: 1, growth: 0 });
    return true;
  }
  if ((player.seeds ?? 0) < TREE_SEED_COST) return false;
  if (rock.energy < TREE_ENERGY_COST) return false;
  player.seeds -= TREE_SEED_COST;
  spendEnergy(rock, TREE_ENERGY_COST);
  rock.trees.push({
    type,
    level: 1,
    growth: 0,
    cooldown: type === "defense" ? DEFENSE_INTERVAL : PRODUCE_INTERVAL,
    flowerCd: FLOWER_INTERVAL,
  });
  return true;
}

function spawnOrbiter(world, rock, kind = KIND.FIGHTER) {
  return spawnSeedling(world, {
    home: rock.id,
    owner: rock.owner,
    strength: rock.strengthStat,
    energy: rock.energyStat,
    orbitRadius: rock.radius + 30 + world.rng() * 20,
    orbitAngle: world.rng() * Math.PI * 2,
    kind,
  });
}

// updateTrees — advance every tree on every asteroid one tick.
export function updateTrees(world, dt) {
  const asts = world.asteroids;
  for (let a = 0; a < asts.length; a++) {
    const rock = asts[a];
    if (rock.dead || rock.owner === OWNER_NEUTRAL) continue;
    const trees = rock.trees;
    // Compute defender cap once per rock (O(trees) not O(trees²)).
    const defCap = matureDefenseCount(rock) * DEFENDERS_PER_TREE;
    for (let t = 0; t < trees.length; t++) {
      const tree = trees[t];
      if (tree.growth < 1) {
        tree.growth = Math.min(1, tree.growth + dt / GROW_TIME);
        if (tree.growth < 1) continue; // only mature trees produce
      }
      // Bombard trees are inert once mature: they only arm the battery — never produce
      // orbiters or flower seeds. (isArmed reads matureBombardCount; firing is in Bombard.js.)
      if (tree.type === "bombard") continue;
      if (tree.type === "defense") {
        tree.cooldown -= dt;
        if (tree.cooldown <= 0) {
          tree.cooldown = DEFENSE_INTERVAL;
          if (
            defCap > 0 &&
            defenderCount(world, rock.id, rock.owner) < defCap &&
            spendEnergy(rock, DEFENDER_ENERGY_COST)
          ) {
            spawnOrbiter(world, rock, KIND.DEFENDER);
          }
        }
        continue;
      }
      // Seedling tree: produce orbiters (energy-gated) + flower into seeds.
      tree.cooldown -= dt;
      if (tree.cooldown <= 0) {
        tree.cooldown = PRODUCE_INTERVAL;
        if (rock.energy >= SEEDLING_ENERGY_COST) {
          const i = spawnOrbiter(world, rock);
          // Only charge energy on a real spawn — at the seedling cap spawnOrbiter returns
          // -1, and charging then would silently drain the rock for nothing.
          if (i >= 0) {
            spendEnergy(rock, SEEDLING_ENERGY_COST);
            // Rally: route freshly-produced seedlings to the rock's anchor point.
            const tgt = rock.rally >= 0 ? world.asteroids[rock.rally] : null;
            if (tgt && tgt.id !== rock.id) launchSeedling(world, i, tgt);
          }
        }
      }
      tree.flowerCd -= dt;
      if (tree.flowerCd <= 0) {
        tree.flowerCd = FLOWER_INTERVAL;
        const player = playerById(world, rock.owner);
        // Resource-rich rocks pay an extra RICH_SEED_BONUS per flower.
        const payout =
          FLOWER_SEEDS + (rock.special === "rich" ? RICH_SEED_BONUS : 0);
        if (player) player.seeds = (player.seeds ?? 0) + payout;
      }
    }
  }
}

export default { plantTree, updateTrees };
