// Sim/Ai.js — AI opponent controller + win/lose resolution. NO three.js (headless).
// Deterministic: every choice flows through world.rng(); never Math.random. The AI is a
// pure controller — it issues the SAME commands a human would (sendSeedlings, plantTree)
// and never mutates SoA arrays or asteroid ownership directly.
import {
  OWNER_NEUTRAL,
  STATE,
  WORLD_STATUS,
  EVENT,
  pushEvent,
} from "./World.js";
import { sendSeedlings } from "./Seedlings.js";
import { plantTree, countBombard, BATTERY_SIZE } from "./Trees.js";
import {
  fireBombard,
  isArmed,
  BOMBARD_SEED_COST,
  BOMBARD_ENERGY_COST,
} from "./Bombard.js";
import { buyTech, techCost, TECH_TRACKS, MAX_TIER } from "./Tech.js";
import { knownOwner, UNKNOWN } from "./Fog.js";

// Difficulty knobs. 0 Easy · 1 Normal · 2 Hard · 3 Brutal. Higher = decides faster, commits
// more orbiters, and presses attacks harder. Normal and up DEVELOP (plant trees); Easy never
// does. Tuned so each step is clearly harder, Normal expands-and-builds before raiding (it no
// longer rushes attacks with no economy), Hard sits between Normal and Brutal, and Brutal is
// the relentless rusher (the old Hard's aggression, dialled up).
//   interval  — seconds between decisions (lower = acts more often)
//   fraction  — share of orbiters committed per command
//   attack    — willing to attack enemy-held rocks at all (boolean — personality never flips this)
//   plant     — willing to plant growth/defense trees (boolean — personality never flips this)
//   aggression— bias toward attacking over neutral expansion
//   techChance— per-decision odds of buying a tech tier when comfortably affordable
//   techBuffer— extra seeds (beyond the tier cost) that must remain after a tech buy, so
//               tech investment never starves expansion/tree-planting. Higher difficulty
//               invests MORE (higher chance, smaller required buffer).
const KNOBS = [
  {
    interval: 3.4,
    fraction: 0.4,
    attack: false,
    plant: false,
    aggression: 0.0,
    techChance: 0,
    techBuffer: 0,
  },
  {
    interval: 2.7,
    fraction: 0.46,
    attack: true,
    plant: true,
    aggression: 0.22,
    techChance: 0.12,
    techBuffer: 30,
  },
  {
    interval: 1.5,
    fraction: 0.64,
    attack: true,
    plant: true,
    aggression: 0.55,
    techChance: 0.3,
    techBuffer: 20,
  },
  {
    interval: 0.9,
    fraction: 0.78,
    attack: true,
    plant: true,
    aggression: 0.82,
    techChance: 0.45,
    techBuffer: 12,
  },
];
// Personality presets — multiplicative/additive modifiers on the NUMERIC knobs only.
// attack/plant booleans are NEVER touched (Easy stays passive regardless of personality).
// "neutral" is the default; absent/unknown personality → no change, regression-safe.
//   aggrMul   — multiplier on aggression
//   fracMul   — multiplier on fraction
//   intMul    — multiplier on interval (>1 slows decisions, <1 speeds them up)
//   techMul   — multiplier on techChance
//   bufAdd    — additive delta on techBuffer (positive = more cautious tech spending)
//   planMul   — multiplier on BOMB_KNOBS.planEvery (>1 plants battery trees less often)
//   fireMul   — multiplier on BOMB_KNOBS.fireEvery (>1 fires less often)
//   beAdd     — additive delta on BOMB_KNOBS.buildEnergy threshold
export const PERSONALITIES = {
  neutral: {
    aggrMul: 1.0,
    fracMul: 1.0,
    intMul: 1.0,
    techMul: 1.0,
    bufAdd: 0,
    planMul: 1.0,
    fireMul: 1.0,
    beAdd: 0,
  },
  rusher: {
    aggrMul: 1.6,
    fracMul: 1.3,
    intMul: 0.7,
    techMul: 0.6,
    bufAdd: -8,
    planMul: 1.5,
    fireMul: 0.7,
    beAdd: -15,
  },
  turtle: {
    aggrMul: 0.4,
    fracMul: 0.7,
    intMul: 1.5,
    techMul: 1.2,
    bufAdd: 20,
    planMul: 0.7,
    fireMul: 1.5,
    beAdd: 25,
  },
  expander: {
    aggrMul: 0.6,
    fracMul: 1.2,
    intMul: 0.9,
    techMul: 0.9,
    bufAdd: 5,
    planMul: 1.2,
    fireMul: 1.2,
    beAdd: 10,
  },
  "superweapon-fiend": {
    aggrMul: 1.1,
    fracMul: 0.9,
    intMul: 1.0,
    techMul: 1.8,
    bufAdd: -5,
    planMul: 0.5,
    fireMul: 0.4,
    beAdd: -20,
  },
};
export const PERSONALITY_NAMES = Object.keys(PERSONALITIES).filter(
  (k) => k !== "neutral",
);

// Personalities only spice up the harder AIs (Hard+). Easy/Normal play the calibrated baseline so
// they stay predictable and beatable — a Normal AI never randomly rolls into an aggressive rusher.
const PERSONALITY_MIN_DIFFICULTY = 2;
function personalityOf(player) {
  return (player.difficulty | 0) >= PERSONALITY_MIN_DIFFICULTY
    ? (PERSONALITIES[player.personality] ?? PERSONALITIES.neutral)
    : PERSONALITIES.neutral;
}

// Compute effective numeric knobs for a player, blending difficulty base with personality.
// Returns a plain object (not the original) so callers can freely read without aliasing concerns.
// Boolean gates (attack, plant) are copied verbatim — personality cannot flip them.
export function effKnobs(player) {
  const base = KNOBS[Math.max(0, Math.min(3, player.difficulty | 0))];
  const pm = personalityOf(player);
  return {
    interval: Math.max(0.3, base.interval * pm.intMul),
    fraction: Math.min(1.0, Math.max(0.1, base.fraction * pm.fracMul)),
    attack: base.attack,
    plant: base.plant,
    aggression: Math.min(1.0, Math.max(0.0, base.aggression * pm.aggrMul)),
    techChance: Math.min(1.0, Math.max(0.0, base.techChance * pm.techMul)),
    techBuffer: Math.max(0, base.techBuffer + pm.bufAdd),
  };
}

// Bombardment is a top-difficulty-only threat: ONLY the hardest AI (Brutal) runs a battery
// program. Easy/Normal/Hard never bombard, regardless of personality (so a Normal
// superweapon-fiend can't wipe you with batteries) — keeps lower difficulties beatable.
const BOMBARD_MIN_DIFFICULTY = 3;

// Effective BOMB_KNOBS for a player, blending difficulty base with personality.
// Returns null below BOMBARD_MIN_DIFFICULTY (and for Easy's null base) — no bombard program.
export function effBombKnobs(player) {
  const diff = Math.max(0, Math.min(3, player.difficulty | 0));
  if (diff < BOMBARD_MIN_DIFFICULTY) return null;
  const base = BOMB_KNOBS[diff];
  if (!base) return null;
  const pm = personalityOf(player);
  return {
    buildEnergy: Math.max(60, base.buildEnergy + pm.beAdd),
    buildBuffer: base.buildBuffer,
    planEvery: Math.max(1, Math.round(base.planEvery * pm.planMul)),
    fireEvery: Math.max(1, Math.round(base.fireEvery * pm.fireMul)),
  };
}

// Count ORBITing seedlings of `owner` home'd at `rockId` — the pool a send can draw from.
// Orbit-only (unlike Trees.homedCount, which counts all states for the defender cap).
function deployableAt(world, rockId, owner) {
  const s = world.seed;
  let n = 0;
  for (let i = 0; i < s.count; i++) {
    if (
      s.home[i] === rockId &&
      s.owner[i] === owner &&
      s.state[i] === STATE.ORBIT
    )
      n++;
  }
  return n;
}

const dist2 = (a, b) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};

// --- Passive-blind fog reads (gated on world.fogOn) --------------------------------------------
// Under fog the AI acts ONLY on what it currently sees + last-known memory: it never considers a
// rock it has no knowledge of, and it reads a rock's owner as its LAST-KNOWN owner (possibly stale)
// rather than the true current owner. When fog is OFF both helpers collapse to the true owner / full
// knowledge, so the AI code path is exactly as before (the OFF path consumes no fog state at all).

// True if the AI `id` may consider rock `a` as a target: always when fog is off; under fog only
// when it has knowledge of the rock (seen now or remembered).
function aiKnows(world, id, a) {
  if (!world.fogOn) return true;
  return knownOwner(world, id, a.id) !== UNKNOWN;
}
// The owner of rock `a` as the AI `id` perceives it: true owner when fog is off; under fog the
// last-known owner (stale if currently unseen).
function aiOwner(world, id, a) {
  return world.fogOn ? knownOwner(world, id, a.id) : a.owner;
}

// Nearest asteroid to `from` matching pred; rng breaks exact ties deterministically.
function nearestMatch(world, from, pred) {
  const asts = world.asteroids;
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < asts.length; i++) {
    const a = asts[i];
    if (a.id === from.id || a.dead || !pred(a)) continue; // dead bodies are untargetable
    const d = dist2(from, a);
    if (d < bestD || (d === bestD && world.rng() < 0.5)) {
      bestD = d;
      best = a;
    }
  }
  return best;
}

// maybeBuyTech — deterministic, develop-only tech investment. Picks the lowest-level affordable
// track (round-robin tiebreak via a per-player counter), buys it on a difficulty-paced cadence,
// and only spends when seeds comfortably exceed cost + buffer (so tech never starves expansion).
//
// Deliberately consumes NO world.rng — it reads only player state + a per-player decision
// counter. This keeps the shared rng stream untouched, so existing AI tests that don't seed
// extra seeds (and so never cross the buffer threshold) drift zero bits; only the new feature's
// observable spend differs. techChance is reinterpreted as a deterministic cadence: buy on
// roughly every Nth qualifying decision, N = round(1/techChance).
function maybeBuyTech(world, player, k) {
  if (k.techChance <= 0) return false;
  const tech = player.tech;
  if (!tech) return false;
  // Find the lowest-level track that's affordable with the buffer; round-robin tiebreak so the
  // empire spreads investment instead of maxing one line. start advances per qualifying call.
  const start = player._techRR | 0;
  let pick = -1;
  let pickLevel = MAX_TIER;
  for (let n = 0; n < TECH_TRACKS.length; n++) {
    const ti = (start + n) % TECH_TRACKS.length;
    const track = TECH_TRACKS[ti];
    const level = tech[track] | 0;
    if (level >= MAX_TIER) continue;
    const cost = techCost(level);
    if (cost == null || (player.seeds ?? 0) < cost + k.techBuffer) continue;
    if (level < pickLevel) {
      pickLevel = level;
      pick = ti;
    }
  }
  if (pick < 0) return false; // nothing affordable/available this decision
  // Deterministic cadence: only act every Nth qualifying decision (N from techChance).
  const period = Math.max(1, Math.round(1 / k.techChance));
  player._techTick = (player._techTick | 0) + 1;
  if (player._techTick % period !== 0) return false;
  player._techRR = (start + 1) % TECH_TRACKS.length;
  return buyTech(world, player.id, TECH_TRACKS[pick]);
}

// --- Bombard battery AI (rng-free, deterministic — mirrors maybeBuyTech's F3 principle) ------
// Same develop gate as planting (Easy never builds). Picks a "safe rear" rock — the highest-
// energy owned rock with NO adjacent enemy (falls back to the highest-energy owned rock if the
// whole empire is frontline) — and slowly assembles a battery there, only spending when the
// economy is comfortably strong so a battery never bankrupts normal expansion. Once armed, it
// fires at the player's strongest rock (most orbiters, energy tiebreak; home rock as fallback).
// Higher difficulty builds/fires more readily. All paced by serialize-ready _-prefixed counters;
// NO world.rng is consumed (ties are broken by id), so existing determinism tests don't drift.
//
// Design choice (documented per the contract): "safe rear" = no neighbor owned by an enemy.
// "strongest player rock" = max orbiter count, then max energy, then lowest id — all rng-free.

// Tuning by difficulty index (0 Easy never builds). buildBuffer = spare seeds that must remain
// after a bombard plant; planEvery / fireEvery = decisions between a plant / a fire attempt.
const BOMB_KNOBS = [
  null, // Easy: no bombard program
  { buildEnergy: 150, buildBuffer: 60, planEvery: 4, fireEvery: 2 }, // Normal
  { buildEnergy: 130, buildBuffer: 45, planEvery: 3, fireEvery: 1 }, // Hard
  { buildEnergy: 110, buildBuffer: 30, planEvery: 2, fireEvery: 1 }, // Brutal
];
// Count ORBITing seedlings of any owner home'd at a rock — the "strength" proxy for targeting.
function orbitersAt(world, rockId) {
  const s = world.seed;
  let n = 0;
  for (let i = 0; i < s.count; i++)
    if (s.home[i] === rockId && s.state[i] === STATE.ORBIT) n++;
  return n;
}

// True if any neighbor of `rock` is held by a live enemy of `id`. Under fog this reads each
// neighbor's LAST-KNOWN owner (aiOwner): an unknown neighbor is treated as not-an-enemy (the AI
// can't know it's hostile), and a stale-known enemy still counts (the AI plays safe on memory).
function hasEnemyNeighbor(world, rock, id) {
  const asts = world.asteroids;
  for (const nb of rock.neighbors || []) {
    const a = asts[nb];
    if (!a || a.dead) continue;
    const o = aiOwner(world, id, a);
    if (o !== OWNER_NEUTRAL && o !== UNKNOWN && o !== id) return true;
  }
  return false;
}

// Pick the AI's battery host. To AVOID scattering bombard trees across rocks (which never
// completes a battery), COMMIT to a rock that already has a partial battery (0<count<5) — the
// one furthest along, lowest id as tiebreak. Only when NO battery is in progress does it open a
// new one on the best "safe rear" rock: highest-energy owned, habitable, non-frontline rock;
// falling back to the highest-energy owned rock overall if the whole empire is frontline.
function pickBatteryHost(world, owned, id) {
  // Finish an in-progress battery first.
  let partial = null;
  for (const r of owned) {
    if (r.dead || !r.habitable) continue;
    const c = countBombard(r);
    if (c <= 0 || c >= BATTERY_SIZE) continue;
    if (
      !partial ||
      c > countBombard(partial) ||
      (c === countBombard(partial) && r.id < partial.id)
    )
      partial = r;
  }
  if (partial) return partial;
  // Otherwise open a new battery on a safe rear rock (or the strongest rock if none is safe).
  let safe = null;
  let any = null;
  for (const r of owned) {
    if (r.dead || !r.habitable) continue;
    if (
      !any ||
      r.energy > any.energy ||
      (r.energy === any.energy && r.id < any.id)
    )
      any = r;
    if (hasEnemyNeighbor(world, r, id)) continue;
    if (
      !safe ||
      r.energy > safe.energy ||
      (r.energy === safe.energy && r.id < safe.id)
    )
      safe = r;
  }
  return safe || any;
}

// Pick the human (player 0) target rock to bombard: most orbiters, then most energy, then lowest
// id (all rng-free). Falls back to any live habitable player-0 rock. Returns null if none.
function pickBombTarget(world) {
  const asts = world.asteroids;
  let best = null;
  let bestO = -1;
  for (let i = 0; i < asts.length; i++) {
    const a = asts[i];
    if (a.dead || a.owner !== 0 || !a.habitable) continue;
    const o = orbitersAt(world, a.id);
    if (
      o > bestO ||
      (o === bestO && best && a.energy > best.energy) ||
      (o === bestO && best && a.energy === best.energy && a.id < best.id)
    ) {
      bestO = o;
      best = a;
    }
  }
  return best;
}

// maybeBombard — develop-only, rng-free battery program. Builds a battery on the committed `host`
// rock (chosen in decide so normal planting can leave that rock alone to bank energy), then fires
// it at the human's strongest rock. Paced by per-player decision counters. Returns the host rock
// id while a battery is being BUILT there (so decide skips it for normal trees), else -1.
function maybeBombard(world, player, host, bk) {
  if (!bk) return -1; // Easy: no bombard
  const id = player.id;

  // 1. Fire any already-armed battery (difficulty-paced) at the human's strongest rock.
  let armed = null;
  const owned = world.asteroids;
  for (let i = 0; i < owned.length; i++) {
    const r = owned[i];
    if (r.owner === id && !r.dead && !r.bombard && isArmed(r)) {
      armed = r;
      break;
    }
  }
  if (armed) {
    player._bombFireTick = (player._bombFireTick | 0) + 1;
    if (player._bombFireTick % bk.fireEvery === 0) {
      const target = pickBombTarget(world);
      if (target && fireBombard(world, armed.id, target.id, id))
        player._bombFires = (player._bombFires | 0) + 1;
    }
    return -1; // a finished/armed battery isn't "building" — don't reserve the rock
  }

  // 2. Otherwise grow a battery on the committed host — only when the economy is strong enough
  //    that the spend won't starve expansion. Paced so it doesn't plant every single decision.
  if (!host) return -1;
  const count = countBombard(host);
  if (count >= BATTERY_SIZE) return host.id; // full battery maturing — keep reserving the rock
  const nextEnergy = BOMBARD_ENERGY_COST[count];
  const nextSeeds = BOMBARD_SEED_COST[count];
  // Can the player afford the next tree's SEEDS plus its develop buffer? If not, the AI is NOT in
  // "battery mode" — return -1 so decide doesn't reserve the rock (this keeps default games, where
  // surplus seeds never build up, bit-identical: the bombard path makes no observable change).
  // Once a battery is already in progress (count>0) we keep reserving so it can complete.
  const canAfford = (player.seeds ?? 0) >= nextSeeds + bk.buildBuffer;
  if (count === 0 && !canAfford) return -1;
  if (!canAfford) return host.id; // mid-battery but seed-starved — hold the rock, wait for seeds
  // Energy gate: opening a NEW battery (count 0) demands the higher buildEnergy reserve so a
  // battery only starts on a genuinely strong rock; FINISHING one (count>0) just needs to afford
  // the next tree plus a small cushion, so an in-progress battery completes instead of stalling.
  const energyGate =
    count === 0 ? Math.max(bk.buildEnergy, nextEnergy) : nextEnergy + 20;
  if (host.energy < energyGate) return host.id; // bank energy (rock reserved, no normal trees)
  player._bombPlanTick = (player._bombPlanTick | 0) + 1;
  if (player._bombPlanTick % bk.planEvery !== 0) return host.id;
  if (plantTree(world, host.id, "bombard", id))
    player._bombPlants = (player._bombPlants | 0) + 1;
  return host.id;
}

// One decision for a single AI player: scan owned rocks, expand/attack/grow.
function decide(world, player) {
  const k = effKnobs(player);
  const bk = effBombKnobs(player);
  const id = player.id;
  const asts = world.asteroids;

  const owned = [];
  for (let i = 0; i < asts.length; i++)
    if (asts[i].owner === id && !asts[i].dead) owned.push(asts[i]);
  if (owned.length === 0) return 0; // wiped — nothing to command

  // Bombard battery program — same develop gate (Easy never builds). Run FIRST so it can reserve
  // its committed host rock; normal tree-planting then skips that rock, letting it bank the energy
  // a battery needs. Rng-free + buffered so it never starves expansion. Returns the reserved host
  // id (or -1). Only AIs that can plant + have >1 owned rock pursue a battery (keep a base intact).
  let reserved = -1;
  if (k.plant && owned.length >= 2) {
    const bombHost = pickBatteryHost(world, owned, id);
    reserved = maybeBombard(world, player, bombHost, bk);
  }

  // Plant on a strong owned rock first (growth → more seedlings over time). Skip the reserved
  // bombard host so it isn't drained by seedling-tree production before the battery completes.
  if (k.plant && (player.seeds ?? 0) >= 5) {
    let host = null;
    for (let i = 0; i < owned.length; i++) {
      const r = owned[i];
      if (r.id === reserved) continue;
      if (r.energy >= 30 && (!host || r.energy > host.energy)) host = r;
    }
    if (host) {
      const hasSeedling = host.trees.some((t) => t.type === "seedling");
      const type = hasSeedling ? "defense" : "seedling";
      plantTree(world, host.id, type, id);
    }
  }

  // Empire-wide tech investment — same develop gate as planting (Easy never develops). The
  // seed buffer inside keeps this from starving expansion.
  if (k.plant) maybeBuyTech(world, player, k);

  // Find the owned rock with the largest deployable orbiter pool to attack/expand from.
  let from = null;
  let pool = 0;
  for (let i = 0; i < owned.length; i++) {
    const n = deployableAt(world, owned[i].id, id);
    if (n > pool) {
      pool = n;
      from = owned[i];
    }
  }
  if (!from || pool < 2) return 0; // keep a minimum garrison; nothing to send

  // Target selection (economy-first): grab the nearest neutral rock to grow. Only attack
  // when there are no neutrals left to take, OR — for aggressive (higher-difficulty) AI
  // that already holds a base of rocks — as extra opportunistic pressure. This keeps higher
  // difficulty strictly stronger: it expands at least as readily AND fights, rather than
  // trading expansion away for early long-range raids.
  // Target predicates read the AI's PERCEIVED ownership (true owner when fog is off; last-known
  // when on) and, under fog, only consider rocks the AI has knowledge of — it never targets a rock
  // it has never seen. A known-but-stale rock is judged by its last-known owner (so the AI may, by
  // design, strike a rock it last saw weakly held even if it has since changed hands).
  const neutral = nearestMatch(
    world,
    from,
    (a) => aiKnows(world, id, a) && aiOwner(world, id, a) === OWNER_NEUTRAL,
  );
  const enemy = nearestMatch(
    world,
    from,
    (a) =>
      aiKnows(world, id, a) &&
      aiOwner(world, id, a) !== id &&
      aiOwner(world, id, a) !== OWNER_NEUTRAL,
  );

  let target = neutral;
  const canAttack = k.attack && enemy;
  const opportunistic =
    canAttack && owned.length >= 2 && world.rng() < k.aggression;
  if (!target || opportunistic) target = enemy || neutral;
  if (!target) return 0; // no valid target — no-op

  return sendSeedlings(world, from.id, target.id, k.fraction, id);
}

// updateAi — tick every AI player's decision timer; act only when it elapses.
export function updateAi(world, dt) {
  if (world.status !== WORLD_STATUS.PLAYING) return;
  const players = world.players;
  for (let p = 0; p < players.length; p++) {
    const player = players[p];
    if (!player.isAi) continue;
    if (player._aiCd === undefined) {
      player._aiCd = effKnobs(player).interval;
      player._aiSends = 0; // count of dispatch actions taken (observable, deterministic)
    }
    player._aiCd -= dt;
    if (player._aiCd <= 0) {
      player._aiCd = effKnobs(player).interval;
      if (decide(world, player) > 0) player._aiSends++;
    }
  }
}

// checkVictory — set terminal world.status. Once terminal (won/lost/draw) it stays put. Three
// win paths, checked in order each call; the first to fire latches:
//   1. ELIMINATION (always active) — about wiping the enemy, not occupying every body:
//        'lost' : player 0 has ZERO asteroids AND ZERO living seedlings.
//        'won'  : no AI (owner >= 1) holds any asteroid AND has no living seedlings.
//   2. DOMINATION (winConfig.mode === "domination") — hold >= dominationPct of habitable bodies
//        for dominationSecs CONTINUOUS seconds (counted in ticks). Player 0 → won; an AI → lost.
//   3. TIME-CAP (winConfig.timeLimitSecs > 0) — at tick >= timeLimitSecs*30, resolve by habitable
//        territory: player 0 strictly leads → won; an AI strictly leads → lost; top tied → draw.
// Habitable counts are written defensively as (habitable && !dead) so a later `dead` flag works.
function hasPresence(world, pred) {
  const asts = world.asteroids;
  for (let i = 0; i < asts.length; i++) if (pred(asts[i].owner)) return true;
  const s = world.seed;
  for (let i = 0; i < s.count; i++) if (pred(s.owner[i])) return true;
  return false;
}

// Habitable bodies currently held by `owner` (forward-compatible with a future `dead` flag).
function heldHabitable(world, owner) {
  const asts = world.asteroids;
  let n = 0;
  for (let i = 0; i < asts.length; i++) {
    const a = asts[i];
    if (a.habitable && !a.dead && a.owner === owner) n++;
  }
  return n;
}

// Total live habitable bodies on the map (the domination/time-cap denominator).
function totalHabitable(world) {
  const asts = world.asteroids;
  let n = 0;
  for (let i = 0; i < asts.length; i++)
    if (asts[i].habitable && !asts[i].dead) n++;
  return n;
}

// Domination: per call, accumulate each player's continuous-hold tick counter and resolve.
// Returns true if it latched a terminal status (so checkVictory stops).
function checkDomination(world, wc) {
  const need = wc.dominationSecs * 30; // fixed timestep 1/30s → seconds*30 ticks
  const total = totalHabitable(world);
  for (const p of world.players) {
    const held = heldHabitable(world, p.id);
    if (total > 0 && held / total >= wc.dominationPct)
      p._domTicks = (p._domTicks | 0) + 1;
    else p._domTicks = 0; // dropping below the threshold resets the streak
    if ((p._domTicks | 0) >= need) {
      // Player 0 dominating → win; any AI dominating → loss. Emit the matching event.
      if (p.id === 0) {
        world.status = WORLD_STATUS.WON;
        pushEvent(world, EVENT.WIN);
      } else {
        world.status = WORLD_STATUS.LOST;
        pushEvent(world, EVENT.LOSE);
      }
      return true;
    }
  }
  return false;
}

// Time-cap: resolve the match by habitable territory once the tick cap is reached. Tiebreak is
// purely "most habitable bodies held"; if the single highest count is shared by 2+ players it's a
// DRAW (a draw emits NO event). A clear win for player 0 or an AI emits WIN/LOSE.
function resolveTimeCap(world) {
  let p0 = 0;
  let bestAi = -1; // highest habitable count among AI players (-1 = no AI present)
  let bestAiTied = false; // some AI ties the current bestAi
  for (const p of world.players) {
    const held = heldHabitable(world, p.id);
    if (p.id === 0) {
      p0 = held;
    } else if (held > bestAi) {
      bestAi = held;
      bestAiTied = false;
    } else if (held === bestAi) {
      bestAiTied = true;
    }
  }
  if (p0 > bestAi && p0 > 0) {
    // Require actual presence — "no AI present" (bestAi -1) is not an automatic win.
    world.status = WORLD_STATUS.WON;
    pushEvent(world, EVENT.WIN);
  } else if (bestAi > p0 && !bestAiTied) {
    // A single AI strictly leads everyone → human loss.
    world.status = WORLD_STATUS.LOST;
    pushEvent(world, EVENT.LOSE);
  } else {
    // Tie for the lead (p0 == bestAi, or multiple AIs share the top) → stalemate, no event.
    world.status = WORLD_STATUS.DRAW;
  }
}

export function checkVictory(world) {
  const st = world.status;
  if (
    st === WORLD_STATUS.WON ||
    st === WORLD_STATUS.LOST ||
    st === WORLD_STATUS.DRAW
  )
    return;
  // 1. Elimination (always active). Status latches, so this transition fires exactly once —
  // emit the matching event here.
  if (!hasPresence(world, (o) => o === 0)) {
    world.status = WORLD_STATUS.LOST;
    pushEvent(world, EVENT.LOSE);
    return;
  }
  if (!hasPresence(world, (o) => o >= 1)) {
    world.status = WORLD_STATUS.WON;
    pushEvent(world, EVENT.WIN);
    return;
  }
  const wc = world.winConfig;
  if (!wc) return; // pre-winConfig worlds: elimination only (defensive)
  // 2. Domination (opt-in).
  if (wc.mode === "domination" && checkDomination(world, wc)) return;
  // 3. Time-cap (opt-in). Resolve by territory once the cap tick is reached.
  if (wc.timeLimitSecs > 0 && world.tick >= wc.timeLimitSecs * 30)
    resolveTimeCap(world);
}

export default { updateAi, checkVictory };
