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

// Symbiosis tree: a mature one emits a per-tick AURA that buffs each ADJACENT same-owner rock.
// Per qualifying neighbor, that rock's symAura grows by SYM_BONUS; consumers read rock.symAura
// (default 1) for combat strength, energy regen, and seedling production speed. The aura is the
// tree's only effect — it is INERT in updateTrees (no orbiters, no flower), like bombard.
export const SYM_BONUS = 0.15; // per adjacent mature symbiosis neighbor

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

// True if `rock` carries at least one MATURE symbiosis tree (growth >= 1) — the aura emitter test.
function hasMatureSymbiosis(rock) {
  const trees = rock.trees;
  for (let i = 0; i < trees.length; i++)
    if (trees[i].type === "symbiosis" && (trees[i].growth ?? 0) >= 1)
      return true;
  return false;
}

// updateAura — rng-free per-tick pass: set rock.symAura on EVERY asteroid (index order) so consumers
// (Combat/Economy/Trees) can read it unconditionally. A non-dead owned rock gains SYM_BONUS for each
// of its neighbors that is same-owner, non-dead, and carries a mature symbiosis tree; neutral/dead
// rocks and rocks with no qualifying neighbor → 1 (neutral). DERIVED from the trees (which serialize)
// — symAura itself is TRANSIENT (recomputed each tick, never serialized). Default-neutral: with no
// mature symbiosis adjacent, every symAura is 1, so all consumers are byte-identical to before.
export function updateAura(world) {
  const asts = world.asteroids;
  for (let a = 0; a < asts.length; a++) {
    const rock = asts[a];
    if (rock.dead || rock.owner === OWNER_NEUTRAL) {
      rock.symAura = 1;
      continue;
    }
    let count = 0;
    const nb = rock.neighbors;
    for (let k = 0; k < nb.length; k++) {
      const other = asts[nb[k]];
      if (
        other &&
        !other.dead &&
        other.owner === rock.owner &&
        hasMatureSymbiosis(other)
      )
        count++;
    }
    rock.symAura = 1 + SYM_BONUS * count;
  }
}

// plantTree — owner must own the rock and afford both seeds + energy. Deducts both and
// A starting seedling tree for spawn homes — created MATURE so the home produces seedlings from
// the start (no plant cost, no grow-in wait). Single source of truth for the seedling-tree shape.
export function seedlingTree() {
  return {
    type: "seedling",
    level: 1,
    growth: 1,
    cooldown: PRODUCE_INTERVAL,
    flowerCd: FLOWER_INTERVAL,
  };
}

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

// clearTrees — remove ALL trees from an owned rock so the player can repurpose it. No refund
// (planting already spent the resources). Cancels any bombard charge + armed state too (mirrors a
// destroyed body's cleanup), so a cleared rock isn't left armed with no battery. Returns the count
// removed (0 = no-op: not owned, dead, or already bare). Deterministic — consumes no world.rng.
export function clearTrees(world, asteroidId, owner) {
  const rock = world.asteroids[asteroidId];
  if (!rock || rock.dead || rock.owner !== owner) return 0;
  const n = rock.trees ? rock.trees.length : 0;
  if (n === 0) return 0;
  rock.trees = [];
  rock.bombard = undefined;
  rock.armed = false;
  return n;
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
    // Live defenders home'd here — computed lazily on the first firing defense tree this tick
    // and shared across them (avoids a full SoA rescan per firing tree). -1 = not yet counted.
    let defNow = -1;
    for (let t = 0; t < trees.length; t++) {
      const tree = trees[t];
      if (tree.growth < 1) {
        tree.growth = Math.min(1, tree.growth + dt / GROW_TIME);
        if (tree.growth < 1) continue; // only mature trees produce
      }
      // Bombard + symbiosis trees are inert once mature: bombard only arms the battery (firing is
      // in Bombard.js); symbiosis only emits its aura (updateAura). Neither produces orbiters/flower.
      if (tree.type === "bombard" || tree.type === "symbiosis") continue;
      if (tree.type === "defense") {
        tree.cooldown -= dt;
        if (tree.cooldown <= 0) {
          tree.cooldown = DEFENSE_INTERVAL;
          if (defCap > 0) {
            if (defNow < 0) defNow = defenderCount(world, rock.id, rock.owner);
            // Spawn FIRST, charge only on a real spawn — at the global SoA cap spawnOrbiter
            // returns -1, and charging then would silently drain the rock for nothing (mirrors
            // the seedling path below). The rock-can-afford gate stands in for the old
            // spendEnergy() boolean guard (spendEnergy refuses when energy < cost).
            if (defNow < defCap && rock.energy >= DEFENDER_ENERGY_COST) {
              const i = spawnOrbiter(world, rock, KIND.DEFENDER);
              if (i >= 0) {
                spendEnergy(rock, DEFENDER_ENERGY_COST);
                defNow++;
              }
            }
          }
        }
        continue;
      }
      // Seedling tree: produce orbiters (energy-gated) + flower into seeds.
      tree.cooldown -= dt;
      if (tree.cooldown <= 0) {
        // Symbiosis aura speeds production: shorter cooldown reset on an aura'd rock (factor 1 →
        // exactly PRODUCE_INTERVAL → byte-identical when no symbiosis is adjacent).
        tree.cooldown = PRODUCE_INTERVAL / (rock.symAura || 1);
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

export default { plantTree, clearTrees, updateTrees, updateAura };
