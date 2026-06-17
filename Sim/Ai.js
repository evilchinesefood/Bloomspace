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
import { plantTree } from "./Trees.js";
import { buyTech, techCost, TECH_TRACKS, MAX_TIER } from "./Tech.js";

// Difficulty knobs. 0 Easy · 1 Normal · 2 Hard · 3 Brutal. Higher = decides faster, commits
// more orbiters, and presses attacks harder. Normal and up DEVELOP (plant trees); Easy never
// does. Tuned so each step is clearly harder, Normal expands-and-builds before raiding (it no
// longer rushes attacks with no economy), Hard sits between Normal and Brutal, and Brutal is
// the relentless rusher (the old Hard's aggression, dialled up).
//   interval  — seconds between decisions (lower = acts more often)
//   fraction  — share of orbiters committed per command
//   attack    — willing to attack enemy-held rocks at all
//   plant     — willing to plant growth/defense trees (develops an economy)
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
    interval: 2.3,
    fraction: 0.52,
    attack: true,
    plant: true,
    aggression: 0.3,
    techChance: 0.18,
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
function knobs(difficulty) {
  return KNOBS[Math.max(0, Math.min(3, difficulty | 0))];
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

// Nearest asteroid to `from` matching pred; rng breaks exact ties deterministically.
function nearestMatch(world, from, pred) {
  const asts = world.asteroids;
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < asts.length; i++) {
    const a = asts[i];
    if (a.id === from.id || !pred(a)) continue;
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

// One decision for a single AI player: scan owned rocks, expand/attack/grow.
function decide(world, player) {
  const k = knobs(player.difficulty);
  const id = player.id;
  const asts = world.asteroids;

  const owned = [];
  for (let i = 0; i < asts.length; i++)
    if (asts[i].owner === id) owned.push(asts[i]);
  if (owned.length === 0) return 0; // wiped — nothing to command

  // Plant on a strong owned rock first (growth → more seedlings over time).
  if (k.plant && (player.seeds ?? 0) >= 5) {
    let host = null;
    for (let i = 0; i < owned.length; i++) {
      const r = owned[i];
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
  const neutral = nearestMatch(world, from, (a) => a.owner === OWNER_NEUTRAL);
  const enemy = nearestMatch(
    world,
    from,
    (a) => a.owner !== id && a.owner !== OWNER_NEUTRAL,
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
      player._aiCd = knobs(player.difficulty).interval;
      player._aiSends = 0; // count of dispatch actions taken (observable, deterministic)
    }
    player._aiCd -= dt;
    if (player._aiCd <= 0) {
      player._aiCd = knobs(player.difficulty).interval;
      if (decide(world, player) > 0) player._aiSends++;
    }
  }
}

// checkVictory — set terminal world.status. Once 'won'/'lost' it stays put. Victory is about
// ELIMINATING THE ENEMY, not occupying every body: neutral rocks (and the non-habitable star)
// don't need to be taken.
//   'lost' : player 0 has ZERO asteroids AND ZERO living seedlings.
//   'won'  : no AI (owner >= 1) holds any asteroid AND has no living seedlings.
//   else   : 'playing'.
function hasPresence(world, pred) {
  const asts = world.asteroids;
  for (let i = 0; i < asts.length; i++) if (pred(asts[i].owner)) return true;
  const s = world.seed;
  for (let i = 0; i < s.count; i++) if (pred(s.owner[i])) return true;
  return false;
}

export function checkVictory(world) {
  if (world.status === WORLD_STATUS.WON || world.status === WORLD_STATUS.LOST)
    return;
  // Status latches, so this transition fires exactly once — emit the matching event here.
  if (!hasPresence(world, (o) => o === 0)) {
    world.status = WORLD_STATUS.LOST;
    pushEvent(world, EVENT.LOSE);
    return;
  }
  if (!hasPresence(world, (o) => o >= 1)) {
    world.status = WORLD_STATUS.WON;
    pushEvent(world, EVENT.WIN);
  }
}

export default { updateAi, checkVictory };
