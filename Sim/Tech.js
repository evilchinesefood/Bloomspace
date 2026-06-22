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

// Tier-3 capstone FORK. When a track hits MAX_TIER the player picks ONE of its two capstones,
// stored on player.crossroads[track] = capstoneId (plain object, absent/empty by default → it
// auto-clones in Save and contributes nothing, so every multiplier stays its pre-capstone value
// and the sim is byte-identical). Each capstone names a `lever` (which owner-mult it boosts) and a
// multiplicative `factor`. levers: "strength"|"speed"|"regen" fold into the matching ownerXMult;
// "sling" feeds the NEW ownerSlingMult (Combat applies it ONLY to SLING-state ships).
export const CROSSROADS = {
  strength: [
    { id: "overwhelm", lever: "strength", factor: 1.2 },
    { id: "reaver", lever: "sling", factor: 1.5 },
  ],
  speed: [
    { id: "blitz", lever: "speed", factor: 1.2 },
    { id: "slipstream", lever: "sling", factor: 1.3 },
  ],
  regen: [
    { id: "bloom", lever: "regen", factor: 1.3 },
    { id: "fortify", lever: "strength", factor: 1.15 },
  ],
};

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

// chooseCrossroads — the sanctioned capstone-pick mutation. Valid ONLY when the player has the
// track at MAX_TIER AND choiceId is one of that track's two capstones; sets
// player.crossroads[track] = choiceId (init crossroads {} if absent), returns true. Otherwise NO
// mutation, returns false. Both human (via Input) and the (default-off) AI knob route through it.
export function chooseCrossroads(world, playerId, track, choiceId) {
  const player = playerById(world, playerId);
  if (!player) return false;
  const opts = CROSSROADS[track];
  if (!opts) return false;
  if (!player.tech || (player.tech[track] | 0) !== MAX_TIER) return false;
  if (!opts.some((o) => o.id === choiceId)) return false;
  if (!player.crossroads) player.crossroads = {};
  player.crossroads[track] = choiceId;
  return true;
}

// capstoneFactor — the multiplicative bonus a player has earned on a given lever from its chosen
// capstones, or 1.0 (no relevant capstone). Sums across every track whose chosen capstone targets
// that lever (each capstone hits ONE lever, so at most one per track contributes). With no
// crossroads chosen this returns EXACTLY 1.0 → accessors are unchanged → byte-identical.
function capstoneFactor(player, lever) {
  const cr = player && player.crossroads;
  if (!cr) return 1;
  let f = 1;
  for (const track in CROSSROADS) {
    const id = cr[track];
    if (!id) continue;
    const opt = CROSSROADS[track].find((o) => o.id === id);
    if (opt && opt.lever === lever) f *= opt.factor;
  }
  return f;
}

// Owner-keyed multiplier accessors. Return EXACTLY 1.0 for a neutral/unknown owner or a
// player with no tech in that track (level 0) AND no relevant capstone. Read in the hot paths
// (Combat/Seedlings/Economy) to scale stats by the OWNING player's tech.
export function ownerStrengthMult(world, ownerId) {
  if (ownerId < 0) return 1;
  const p = playerById(world, ownerId);
  if (!p || !p.tech) return 1;
  return (
    strengthMult(p.tech[TECH.STRENGTH] | 0) * capstoneFactor(p, "strength")
  );
}
export function ownerSpeedMult(world, ownerId) {
  if (ownerId < 0) return 1;
  const p = playerById(world, ownerId);
  if (!p || !p.tech) return 1;
  return speedMult(p.tech[TECH.SPEED] | 0) * capstoneFactor(p, "speed");
}
export function ownerRegenMult(world, ownerId) {
  if (ownerId < 0) return 1;
  const p = playerById(world, ownerId);
  if (!p || !p.tech) return 1;
  return regenMult(p.tech[TECH.REGEN] | 0) * capstoneFactor(p, "regen");
}
// Sling-damage capstone multiplier (default 1.0 — no relevant capstone). Combat multiplies a
// SLING-state ship's outgoing strength by this; non-SLING ships are unaffected.
export function ownerSlingMult(world, ownerId) {
  if (ownerId < 0) return 1;
  const p = playerById(world, ownerId);
  if (!p) return 1;
  return capstoneFactor(p, "sling");
}

export default {
  TECH,
  MAX_TIER,
  TECH_COST,
  CROSSROADS,
  techCost,
  initPlayerTech,
  buyTech,
  chooseCrossroads,
  strengthMult,
  speedMult,
  regenMult,
  ownerStrengthMult,
  ownerSpeedMult,
  ownerRegenMult,
  ownerSlingMult,
};
