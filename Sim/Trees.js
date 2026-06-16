// Sim/Trees.js — tree growth, seedling production, flowering→seeds, defender spawning.
// NO three.js (headless). Deterministic: timers live on each tree object; no randomness
// except via spawnSeedling (which uses world.rng for orbit placement).
//
// Seedling trees: ramp growth → maturity, then periodically spend rock energy to spawn an
// orbiter, and on a separate timer flower into seeds for the owning player.
// Defense trees: periodically spawn defender orbiters (normal seedlings) up to a cap; the
// T4 combat layer makes them auto-attack intruders by proximity.
import { spawnSeedling, OWNER_NEUTRAL } from "./World.js";
import { spendEnergy } from "./Economy.js";
import { launchSeedling } from "./Seedlings.js";

export const TREE_SEED_COST = 5; // player seeds to plant any tree
export const TREE_ENERGY_COST = 30; // asteroid energy to plant any tree
export const GROW_TIME = 8; // seconds for growth 0 → 1 (maturity)

export const PRODUCE_INTERVAL = 4; // seedling tree: seconds between orbiter spawns
export const SEEDLING_ENERGY_COST = 8; // energy spent per produced orbiter
export const FLOWER_INTERVAL = 6; // seconds between flower→seeds payouts
export const FLOWER_SEEDS = 2; // seeds added to owner per flower

export const DEFENSE_INTERVAL = 5; // defense tree: seconds between defender spawns
export const DEFENDER_ENERGY_COST = 6; // energy per defender spawn
export const DEFENDERS_MAX = 6; // cap of defenders orbiting one rock

function playerById(world, id) {
  const ps = world.players;
  for (let i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i];
  return null;
}

// Count living seedlings owned by `owner` orbiting asteroid `rockId`.
function orbitersAt(world, rockId, owner) {
  const s = world.seed;
  let n = 0;
  for (let i = 0; i < s.count; i++) {
    if (s.home[i] === rockId && s.owner[i] === owner) n++;
  }
  return n;
}

// plantTree — owner must own the rock and afford both seeds + energy. Deducts both and
// appends a fresh tree on success. Returns true; otherwise no mutation and returns false.
export function plantTree(world, asteroidId, type, owner) {
  const rock = world.asteroids[asteroidId];
  if (!rock || rock.owner === OWNER_NEUTRAL || rock.owner !== owner)
    return false;
  const player = playerById(world, owner);
  if (!player || (player.seeds ?? 0) < TREE_SEED_COST) return false;
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

function spawnOrbiter(world, rock) {
  return spawnSeedling(world, {
    home: rock.id,
    owner: rock.owner,
    strength: rock.strengthStat,
    energy: rock.energyStat,
    orbitRadius: rock.radius + 30 + world.rng() * 20,
    orbitAngle: world.rng() * Math.PI * 2,
  });
}

// updateTrees — advance every tree on every asteroid one tick.
export function updateTrees(world, dt) {
  const asts = world.asteroids;
  for (let a = 0; a < asts.length; a++) {
    const rock = asts[a];
    if (rock.owner === OWNER_NEUTRAL) continue;
    const trees = rock.trees;
    for (let t = 0; t < trees.length; t++) {
      const tree = trees[t];
      if (tree.growth < 1) {
        tree.growth = Math.min(1, tree.growth + dt / GROW_TIME);
        if (tree.growth < 1) continue; // only mature trees produce
      }
      if (tree.type === "defense") {
        tree.cooldown -= dt;
        if (tree.cooldown <= 0) {
          tree.cooldown = DEFENSE_INTERVAL;
          if (
            orbitersAt(world, rock.id, rock.owner) < DEFENDERS_MAX &&
            spendEnergy(rock, DEFENDER_ENERGY_COST)
          ) {
            spawnOrbiter(world, rock);
          }
        }
        continue;
      }
      // Seedling tree: produce orbiters (energy-gated) + flower into seeds.
      tree.cooldown -= dt;
      if (tree.cooldown <= 0) {
        tree.cooldown = PRODUCE_INTERVAL;
        if (rock.energy >= SEEDLING_ENERGY_COST) {
          spendEnergy(rock, SEEDLING_ENERGY_COST);
          const i = spawnOrbiter(world, rock);
          // Rally: route freshly-produced seedlings to the rock's anchor point.
          const tgt = rock.rally >= 0 ? world.asteroids[rock.rally] : null;
          if (i >= 0 && tgt && tgt.id !== rock.id)
            launchSeedling(world, i, tgt);
        }
      }
      tree.flowerCd -= dt;
      if (tree.flowerCd <= 0) {
        tree.flowerCd = FLOWER_INTERVAL;
        const player = playerById(world, rock.owner);
        if (player) player.seeds = (player.seeds ?? 0) + FLOWER_SEEDS;
      }
    }
  }
}

export default { plantTree, updateTrees };
