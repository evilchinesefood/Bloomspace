// Sim/Tech.js — empire-wide tech tiers: a second seed sink that buffs a whole player's
// fleet/economy. NO three.js (headless), pure-data + deterministic (no randomness here;
// any AI choice flows through world.rng in Ai.js). Tech state lives on player.tech as plain
// numbers (JSON-serializable for the later save/resume feature).
//
// Three tracks, 3 tiers each. Level 0 ⇒ multiplier EXACTLY 1.0 — this is load-bearing: the
// existing tests buy no tech, so the hot-path multipliers must be a true no-op at level 0 or
// every un-teched sim would drift one bit. The increments below are the settled contract.
//
// IMPORTANT (TDZ): World.js imports initPlayerTech from this module before its own exports
// finish initializing. This module only declares pure constants/functions and never reads a
// World.js export at module-eval time, so the circular import is safe (mirrors Combat.js's
// MAX_PLAYERS TDZ note).

export const TECH = { STRENGTH: "strength", SPEED: "speed", REGEN: "regen" };
export const TECH_TRACKS = [TECH.STRENGTH, TECH.SPEED, TECH.REGEN];
export const MAX_TIER = 3;

// Per-tier multiplier increments. Level 0 → 1.0; each tier adds the increment.
//   STRENGTH: 1 + 0.15*level  (L3 = 1.45)
//   SPEED:    1 + 0.12*level  (L3 = 1.36)
//   REGEN:    1 + 0.20*level  (L3 = 1.60)
export const strengthMult = (level) => 1 + 0.15 * level;
export const speedMult = (level) => 1 + 0.12 * level;
export const regenMult = (level) => 1 + 0.2 * level;

// Escalating seed cost to go from level L → L+1 (1st/2nd/3rd tier).
export const TECH_COST = [15, 30, 60];

// techCost(level) — seeds to buy the NEXT tier from `level`, or null at/above max.
export function techCost(level) {
  if (level < 0 || level >= MAX_TIER) return null;
  return TECH_COST[level];
}

// initPlayerTech — give a player a zeroed tech record if it lacks one. Called from
// createWorld's player-normalize loop. Idempotent (never clobbers a loaded record).
export function initPlayerTech(player) {
  if (!player.tech) player.tech = { strength: 0, speed: 0, regen: 0 };
  return player;
}

function playerById(world, id) {
  const ps = world.players;
  for (let i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i];
  return null;
}

// buyTech — the sanctioned mutation. Validates the player + track + headroom + affordability;
// on success deducts the EXACT cost, increments that track's level, returns true. Otherwise
// NO mutation and returns false. Both human (via Input) and AI (via Ai.decide) call this.
export function buyTech(world, playerId, track) {
  const player = playerById(world, playerId);
  if (!player) return false;
  if (track !== TECH.STRENGTH && track !== TECH.SPEED && track !== TECH.REGEN)
    return false;
  if (!player.tech) initPlayerTech(player);
  const level = player.tech[track] | 0;
  if (level >= MAX_TIER) return false;
  const cost = techCost(level);
  if (cost == null || (player.seeds ?? 0) < cost) return false;
  player.seeds -= cost;
  player.tech[track] = level + 1;
  return true;
}

// Owner-keyed multiplier accessors. Return EXACTLY 1.0 for a neutral/unknown owner or a
// player with no tech in that track (level 0). Read in the hot paths (Combat/Seedlings/
// Economy) to scale stats by the OWNING player's tech.
function levelOf(world, ownerId, track) {
  if (ownerId < 0) return 0;
  const p = playerById(world, ownerId);
  if (!p || !p.tech) return 0;
  return p.tech[track] | 0;
}

export function ownerStrengthMult(world, ownerId) {
  return strengthMult(levelOf(world, ownerId, TECH.STRENGTH));
}
export function ownerSpeedMult(world, ownerId) {
  return speedMult(levelOf(world, ownerId, TECH.SPEED));
}
export function ownerRegenMult(world, ownerId) {
  return regenMult(levelOf(world, ownerId, TECH.REGEN));
}

export default {
  TECH,
  MAX_TIER,
  TECH_COST,
  techCost,
  initPlayerTech,
  buyTech,
  strengthMult,
  speedMult,
  regenMult,
  ownerStrengthMult,
  ownerSpeedMult,
  ownerRegenMult,
};
