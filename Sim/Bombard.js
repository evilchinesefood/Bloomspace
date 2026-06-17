// Sim/Bombard.js — Feature 6a: the Bombardment Battery (SIM CORE). NO three.js (headless).
// Deterministic, pure data. A "bombard" battery is 5 mature bombard trees on one rock; once
// armed it can fire a ~2s charge that DELETES any celestial body (incl. your own, stars, black
// holes). The destroyed body is marked `dead` in place — NEVER spliced — so world.asteroids
// keeps its load-bearing id===index invariant (seedling home/target/dest are indices into it).
//
// All bombard state is plain-JSON-serializable for a later save/resume feature:
//   rock.dead    : boolean
//   rock.armed   : boolean (maintained each tick by updateBombard)
//   rock.bombard : { target:int, charge:int } | undefined
import { OWNER_NEUTRAL, EVENT, pushEvent, killSeedling } from "./World.js";
import { rebuildNav } from "./MapGen.js";

export const BATTERY_SIZE = 5; // mature bombard trees needed to arm
export const CHARGE_TICKS = 60; // ~2s at the fixed 30Hz timestep

// Escalating plant cost for the k-th bombard tree (k = the rock's CURRENT bombard count 0..4).
// Indexed by current count so the first tree is cheap and the fifth is steep — a battery is a
// heavy economic commitment, not a cheap rush. Read by Trees.plantTree for type "bombard".
export const BOMBARD_SEED_COST = [10, 15, 20, 25, 30];
export const BOMBARD_ENERGY_COST = [40, 50, 60, 70, 80];

// countBombard — raw count of bombard trees on a rock (mature or not). Gates planting (max 5).
export function countBombard(rock) {
  const trees = rock.trees;
  let n = 0;
  for (let i = 0; i < trees.length; i++) if (trees[i].type === "bombard") n++;
  return n;
}

// matureBombardCount — bombard trees that have finished growing (growth >= 1). Gates arming.
export function matureBombardCount(rock) {
  const trees = rock.trees;
  let n = 0;
  for (let i = 0; i < trees.length; i++)
    if (trees[i].type === "bombard" && (trees[i].growth ?? 0) >= 1) n++;
  return n;
}

// isArmed — a live rock with a full battery of MATURE bombard trees is armed and ready to fire.
export function isArmed(rock) {
  return !rock.dead && matureBombardCount(rock) >= BATTERY_SIZE;
}

// fireBombard — the sanctioned fire call (shared by player + AI). Validates ownership, armed,
// not-already-charging, and a live target. Self-target and targeting ANY kind (star/blackhole/
// own) are allowed. On success: start the charge + emit EVENT.FIRE at the battery (carrying the
// target coords + owner so Render/audio can draw the beam). Trees are consumed at RESOLVE, not
// here. Returns true on success; otherwise NO mutation and returns false.
export function fireBombard(world, fromRockId, targetId, owner) {
  const rock = world.asteroids[fromRockId];
  if (!rock || rock.dead || rock.owner !== owner) return false;
  if (!isArmed(rock) || rock.bombard) return false; // not armed, or already charging
  const target = world.asteroids[targetId];
  if (!target || target.dead) return false;
  rock.bombard = { target: targetId, charge: CHARGE_TICKS };
  pushEvent(world, EVENT.FIRE, rock.x, rock.y, owner, target.x, target.y);
  return true;
}

// Remove up to BATTERY_SIZE mature bombard trees from a rock (the trees consumed by a shot).
function consumeBatteryTrees(rock) {
  let removed = 0;
  for (let i = rock.trees.length - 1; i >= 0 && removed < BATTERY_SIZE; i--) {
    const t = rock.trees[i];
    if (t.type === "bombard" && (t.growth ?? 0) >= 1) {
      rock.trees.splice(i, 1);
      removed++;
    }
  }
}

// updateBombard — once per tick. (1) Maintain rock.armed for every rock so Render/AI/UI can
// read it. (2) Advance any active charge; on resolve, consume the firing rock's battery trees,
// clear the charge, then destroy the target (unless it already died — then just clear+consume).
export function updateBombard(world, dt) {
  const asts = world.asteroids;
  for (let a = 0; a < asts.length; a++) {
    const rock = asts[a];
    rock.armed = isArmed(rock);
    const b = rock.bombard;
    if (!b) continue;
    b.charge -= 1;
    if (b.charge > 0) continue;
    // RESOLVE. Consume the battery first so a non-self firing rock keeps its OTHER trees; if the
    // target is the firing rock, destroyBody clears all its trees anyway (consume is harmless).
    const targetId = b.target;
    consumeBatteryTrees(rock);
    rock.bombard = undefined;
    rock.armed = false; // battery spent
    const target = asts[targetId];
    if (target && !target.dead) destroyBody(world, targetId);
  }
}

// destroyBody — the dead-body operation. Mark a body dead IN PLACE (no splice), sever it from
// the travel graph, rebuild nav, and reap every seedling tied to it. Idempotent: a no-op on an
// already-dead or missing body. Invalidates the black-hole cache so a destroyed hole stops
// reaping. Emits no special "destroyed" event — the seedling deaths emit DEATH, and FIRE was
// emitted at fire-start; Render detects the dead transition itself in a later pass.
export function destroyBody(world, id) {
  const body = world.asteroids[id];
  if (!body || body.dead) return;
  body.dead = true;
  body.owner = OWNER_NEUTRAL;
  body.trees = [];
  body.rally = -1;
  body.bombard = undefined;
  body.armed = false;

  // Sever from every other body's neighbor list, and empty its own.
  const asts = world.asteroids;
  for (let i = 0; i < asts.length; i++) {
    const nb = asts[i].neighbors;
    if (nb && nb.length && nb.includes(id))
      asts[i].neighbors = nb.filter((x) => x !== id);
  }
  body.neighbors = [];

  // Drop every link touching id, then rebuild the first-hop nav table.
  if (world.links)
    world.links = world.links.filter((e) => e[0] !== id && e[1] !== id);
  rebuildNav(world);

  // Kill every seedling homed/targeting/dest'd at the dead body. killSeedling swap-removes from
  // the dense SoA, so iterate DESCENDING (same pattern as World.destroyInBlackHoles).
  const s = world.seed;
  for (let i = s.count - 1; i >= 0; i--) {
    if (s.home[i] === id || s.target[i] === id || s.dest[i] === id)
      killSeedling(world, i);
  }

  // A destroyed black hole must stop reaping ships — force the memo to recompute next tick.
  if (body.kind === "blackhole") world._blackholes = null;
}

export default {
  BATTERY_SIZE,
  CHARGE_TICKS,
  BOMBARD_SEED_COST,
  BOMBARD_ENERGY_COST,
  countBombard,
  matureBombardCount,
  isArmed,
  fireBombard,
  updateBombard,
  destroyBody,
};
