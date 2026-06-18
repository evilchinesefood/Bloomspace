// Sim/Upgrade.js — per-asteroid stat upgrades: spend seeds to permanently boost a single
// rock's energyStat / strengthStat / speedStat over escalating-cost tiers. Upgrades bake
// directly into the rock fields so they persist through capture and serialize automatically
// (Save.js deep-clones the whole asteroid object). Pure/deterministic: no randomness.

export const UPGRADE = {
  ENERGY: "energy",
  STRENGTH: "strength",
  SPEED: "speed",
};
export const UPGRADE_STATS = [UPGRADE.ENERGY, UPGRADE.STRENGTH, UPGRADE.SPEED];
export const MAX_TIER = 3;
export const STAT_DELTA = 10; // raw stat points added per tier
export const UPGRADE_COST = [20, 40, 80]; // seeds to go from tier 0→1, 1→2, 2→3

export function upgradeCost(tier) {
  if (tier < 0 || tier >= MAX_TIER) return null;
  return UPGRADE_COST[tier];
}

// Lazily initialize rock.upgrades so pre-existing saves without it default to 0.
function initUpgrades(rock) {
  if (!rock.upgrades) rock.upgrades = { energy: 0, strength: 0, speed: 0 };
}

export function upgradeTier(rock, stat) {
  if (!rock.upgrades) return 0;
  return rock.upgrades[stat] | 0;
}

export function canUpgrade(rock, stat) {
  return upgradeTier(rock, stat) < MAX_TIER;
}

function playerById(world, id) {
  const ps = world.players;
  for (let i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i];
  return null;
}

const STAT_FIELD = {
  energy: "energyStat",
  strength: "strengthStat",
  speed: "speedStat",
};

// buyUpgrade — the sanctioned mutation. Validates rock + owner + tier headroom + affordability;
// on success deducts seeds, increments rock.upgrades[stat], and applies STAT_DELTA directly to
// the rock's stat field. Returns true on success, false (no mutation) otherwise.
export function buyUpgrade(world, rockId, stat, owner) {
  if (UPGRADE_STATS.indexOf(stat) < 0) return false;
  const rock = world.asteroids[rockId];
  if (!rock || rock.dead) return false;
  if (rock.owner !== owner) return false;
  const player = playerById(world, owner);
  if (!player) return false;
  initUpgrades(rock);
  const tier = rock.upgrades[stat] | 0;
  if (tier >= MAX_TIER) return false;
  const cost = upgradeCost(tier);
  if (cost == null || (player.seeds ?? 0) < cost) return false;
  player.seeds -= cost;
  rock.upgrades[stat] = tier + 1;
  rock[STAT_FIELD[stat]] += STAT_DELTA;
  return true;
}

export default {
  UPGRADE,
  UPGRADE_STATS,
  MAX_TIER,
  STAT_DELTA,
  UPGRADE_COST,
  upgradeCost,
  upgradeTier,
  canUpgrade,
  buyUpgrade,
};
