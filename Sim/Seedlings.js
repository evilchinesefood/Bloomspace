// Sim/Seedlings.js — per-tick seedling movement (orbit/transit), sending, and arrival
// colonization. NO three.js. Combat (COMBAT/DEAD) is deferred to T4.
import {
  STATE,
  OWNER_NEUTRAL,
  KIND,
  EVENT,
  pushEvent,
  MAX_PLAYERS,
} from "./World.js";
import { ownerSpeedMult } from "./Tech.js";
import { NEBULA_SLOW } from "./MapGen.js";

const TAU = Math.PI * 2;
const ORBIT_BASE = 1.2; // max angular speed (rad/sec) — caps tiny rocks from whirling
const ORBIT_LINEAR = 70; // target tangential speed (units/sec): keeps big-radius (planet)
//                          orbits from sweeping fast. angular = ORBIT_LINEAR / orbitRadius.
const TRANSIT_BASE = 120; // base linear speed (world units/sec)
const ARRIVE_GAP = 24; // orbit gap added to target.radius for "arrived"
const SLING_ARC = 0.7 * TAU; // slingshot: sweep ~70% around a passed body before breaking off

const speedFactor = (a) => 0.5 + (a ? a.speedStat : 50) / 100;

// Per-owner speed-tech multiplier, recomputed once per updateSeedlings tick (indexed by owner
// id 0..MAXO-1; neutral -1 → 1.0). Avoids a per-player lookup inside the per-ship loop. MAXO
// is read lazily on first tick, NOT at module load (World.js imports this before its own
// MAX_PLAYERS export initializes — reading it at eval time would throw a TDZ error).
let SPD_MAXO = 0;
let spdMult = new Float32Array(0);
function loadSpdMult(world) {
  if (SPD_MAXO === 0) SPD_MAXO = MAX_PLAYERS;
  if (spdMult.length < SPD_MAXO) spdMult = new Float32Array(SPD_MAXO);
  for (let o = 0; o < SPD_MAXO; o++) spdMult[o] = ownerSpeedMult(world, o);
}
// Owner-keyed speed-tech multiplier for one seedling slot (1.0 for neutral/out-of-range).
function spdOf(s, i) {
  const o = s.owner[i];
  return o >= 0 && o < SPD_MAXO ? spdMult[o] : 1;
}

// Nebula transit penalty for a ship at (px,py): NEBULA_SLOW if inside any nebula, else 1.
// Allocation-free inline loop over the ≤2 regions. Callers guard on world.nebulae?.length so
// a specials-off world (empty nebulae) does ZERO extra work here — bit-identical to before.
function nebulaSlow(neb, px, py) {
  for (let k = 0; k < neb.length; k++) {
    const z = neb[k];
    const dx = px - z.x;
    const dy = py - z.y;
    if (dx * dx + dy * dy <= z.radius * z.radius) return NEBULA_SLOW;
  }
  return 1;
}

// Next asteroid to fly to when routing from `fromId` toward final `destId`, using the
// precomputed nearest-neighbor nav table. Falls back to going direct if no graph exists.
function nextHop(world, fromId, destId) {
  const nav = world.nav;
  if (!nav || !nav[fromId]) return destId;
  return nav[fromId][destId];
}

// Aim seedling i's velocity at `node` (its current waypoint) at transit speed.
function aimAt(world, i, node) {
  const s = world.seed;
  const dx = node.x - s.x[i];
  const dy = node.y - s.y[i];
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  const speed = TRANSIT_BASE * speedFactor(world.asteroids[s.home[i]] || node);
  s.vx[i] = (dx / d) * speed;
  s.vy[i] = (dy / d) * speed;
}

// updateSeedlings — advance every live seedling one tick.
export function updateSeedlings(world, dt) {
  const s = world.seed;
  loadSpdMult(world); // per-owner speed-tech factor (1.0 = no tech), constant this tick
  // Nebula regions (Feature 7a): slow transiting/slinging ships passing through. Null/empty
  // when specials are off ⇒ the per-ship nebula check is skipped entirely (no drift).
  const neb = world.nebulae && world.nebulae.length ? world.nebulae : null;
  for (let i = 0; i < s.count; i++) {
    const st = s.state[i];
    if (st === STATE.ORBIT) {
      const a = world.asteroids[s.home[i]];
      if (!a) continue;
      // Angular speed derived from a target tangential speed so seedlings orbit big planets
      // at the same visual pace as small asteroids (capped so tiny rocks don't whirl).
      const r = s.orbitRadius[i] || 1;
      const av = Math.min(ORBIT_BASE, ORBIT_LINEAR / r) * speedFactor(a);
      let ang = s.orbitAngle[i] + dt * av;
      if (ang >= TAU) ang -= TAU;
      s.orbitAngle[i] = ang;
      s.x[i] = a.x + Math.cos(s.orbitAngle[i]) * s.orbitRadius[i];
      s.y[i] = a.y + Math.sin(s.orbitAngle[i]) * s.orbitRadius[i];
    } else if (st === STATE.TRANSIT) {
      const t = world.asteroids[s.target[i]];
      if (!t || t.dead) {
        // Waypoint vanished (or its body was destroyed) — park back into orbit around home.
        s.state[i] = STATE.ORBIT;
        s.target[i] = -1;
        s.dest[i] = -1;
        continue;
      }
      const dx = t.x - s.x[i];
      const dy = t.y - s.y[i];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= t.radius + ARRIVE_GAP) {
        // Reached this waypoint. The FINAL destination resolves (colonize/fight); an
        // intermediate body is slung around (~70%) before continuing — fighting anything
        // stationed there during the arc (Combat treats SLING ships as engaging that body).
        if (t.id === s.dest[i]) resolveArrival(world, i, t);
        else enterSling(world, i, t);
        continue;
      }
      const speed =
        TRANSIT_BASE *
        speedFactor(world.asteroids[s.home[i]] || t) *
        spdOf(s, i) *
        (neb ? nebulaSlow(neb, s.x[i], s.y[i]) : 1);
      const move = Math.min(d, speed * dt);
      s.vx[i] = (dx / d) * speed;
      s.vy[i] = (dy / d) * speed;
      s.x[i] += (dx / d) * move;
      s.y[i] += (dy / d) * move;
    } else if (st === STATE.SLING) {
      const t = world.asteroids[s.target[i]];
      if (!t) {
        s.state[i] = STATE.TRANSIT;
        s.slingRem[i] = 0;
        continue;
      }
      const rad = s.orbitRadius[i] || t.radius + ARRIVE_GAP;
      const dir = s.slingRem[i] >= 0 ? 1 : -1;
      const speed =
        TRANSIT_BASE *
        speedFactor(world.asteroids[s.home[i]] || t) *
        spdOf(s, i) *
        (neb ? nebulaSlow(neb, s.x[i], s.y[i]) : 1);
      let dAng = (speed / Math.max(1, rad)) * dt;
      if (dAng > Math.abs(s.slingRem[i])) dAng = Math.abs(s.slingRem[i]);
      s.orbitAngle[i] += dir * dAng;
      s.slingRem[i] -= dir * dAng; // shrink the signed remainder toward 0
      s.x[i] = t.x + Math.cos(s.orbitAngle[i]) * rad;
      s.y[i] = t.y + Math.sin(s.orbitAngle[i]) * rad;
      // tangential velocity → ship orients along its curve
      s.vx[i] = -Math.sin(s.orbitAngle[i]) * dir * speed;
      s.vy[i] = Math.cos(s.orbitAngle[i]) * dir * speed;
      if (Math.abs(s.slingRem[i]) <= 1e-4) breakOff(world, i, t);
      continue;
    }
    // COMBAT / DEAD: handled in Combat; no movement here.
  }
}

// Re-home an arriving seedling into a fresh orbit around the target asteroid.
function joinOrbit(world, i, target) {
  const s = world.seed;
  s.home[i] = target.id;
  s.target[i] = -1;
  s.dest[i] = -1;
  s.state[i] = STATE.ORBIT;
  s.orbitRadius[i] = target.radius + 30 + world.rng() * 20;
  s.orbitAngle[i] = world.rng() * Math.PI * 2;
  s.vx[i] = 0;
  s.vy[i] = 0;
  s.x[i] = target.x + Math.cos(s.orbitAngle[i]) * s.orbitRadius[i];
  s.y[i] = target.y + Math.sin(s.orbitAngle[i]) * s.orbitRadius[i];
}

function resolveArrival(world, i, target) {
  const s = world.seed;
  const owner = s.owner[i];
  if (!target.habitable) {
    // Star / black hole: never colonized — ships just orbit it (a black hole's orbiters are
    // reaped by World.destroyInBlackHoles next tick).
    joinOrbit(world, i, target);
    return;
  }
  if (target.owner === OWNER_NEUTRAL) {
    // Colonize: first arrival flips ownership, then join the orbit.
    target.owner = owner;
    pushEvent(world, EVENT.CAPTURE, target.x, target.y, owner);
    joinOrbit(world, i, target);
  } else if (target.owner === owner) {
    // Reinforce: just join the orbit.
    joinOrbit(world, i, target);
  } else {
    // Enemy-held: park into the shared orbit and let T4 combat resolve it. Damage is
    // applied on contact by Combat.resolveCombat; ownership only flips once the defenders
    // are gone (Combat.flipOwnership), never here. Attackers that lose the fight die.
    joinOrbit(world, i, target);
  }
}

// enterSling — begin a partial slingshot orbit around intermediate waypoint `t`. The ship
// keeps its final dest; it swings ~70% of the way around t (in the direction it's already
// curving) then breaks off toward the next hop. Combat makes it fight ships stationed at t.
function enterSling(world, i, t) {
  const s = world.seed;
  const dx = s.x[i] - t.x;
  const dy = s.y[i] - t.y;
  const rad = Math.sqrt(dx * dx + dy * dy) || t.radius + ARRIVE_GAP;
  s.orbitRadius[i] = rad;
  s.orbitAngle[i] = Math.atan2(dy, dx);
  // Continue rotating the way the incoming velocity curves around t (sign of r × v).
  const dir = dx * s.vy[i] - dy * s.vx[i] >= 0 ? 1 : -1;
  s.slingRem[i] = dir * SLING_ARC;
  s.state[i] = STATE.SLING;
  s.target[i] = t.id; // the sling center (already t)
}

// breakOff — slingshot complete: head to the next hop (or resolve if t was the destination).
function breakOff(world, i, t) {
  const s = world.seed;
  s.slingRem[i] = 0;
  if (t.id === s.dest[i]) {
    resolveArrival(world, i, t);
    return;
  }
  const hop = nextHop(world, t.id, s.dest[i]);
  const node = world.asteroids[hop];
  if (!node || hop === t.id) {
    resolveArrival(world, i, t);
    return;
  }
  s.target[i] = hop;
  s.state[i] = STATE.TRANSIT;
  aimAt(world, i, node);
}

// launchSeedling — route seedling i toward final destination `dest`, flying along the
// nearest-neighbor network (first hop now, the rest resolved waypoint by waypoint). Shared
// by player sends and tree-production rally routing. No-op if already home or unreachable.
export function launchSeedling(world, i, dest) {
  const s = world.seed;
  if (!dest || dest.dead || dest.id === s.home[i]) return; // dead target → no-op
  const hop = nextHop(world, s.home[i], dest.id);
  const node = world.asteroids[hop];
  if (!node) return;
  s.dest[i] = dest.id;
  s.target[i] = hop;
  s.state[i] = STATE.TRANSIT;
  aimAt(world, i, node);
}

// setRally — set or clear an asteroid's rally (anchor) point. While a rally is set, the rock
// continuously funnels its orbiting fighters to the anchor (see updateRally). Clears when the
// target is the rock itself or invalid. Only the rock's owner may set it.
export function setRally(world, fromId, toId, owner) {
  const rock = world.asteroids[fromId];
  if (!rock || rock.owner !== owner) return false;
  rock.rally = toId === fromId || !world.asteroids[toId] ? -1 : toId;
  return true;
}

// RALLY_INTERVAL — how often a rallied rock pushes a wave of orbiters forward. Throttled so
// the funnel reads as a steady stream rather than a single-frame teleport of the whole orbit.
const RALLY_INTERVAL = 0.35;

// updateRally — what actually makes a rally point DO something: every rallied rock launches
// its currently-orbiting FIGHTERS (kind 0) toward the anchor, draining both the rock's
// existing seedlings and anything newly produced/arrived. Defenders (kind 1) stay to guard.
// Arrivals re-home to the target (joinOrbit), so they aren't re-grabbed here — no loop.
export function updateRally(world, dt) {
  const s = world.seed;
  for (const rock of world.asteroids) {
    if (!rock || rock.rally == null || rock.rally < 0 || rock.owner < 0)
      continue;
    const tgt = world.asteroids[rock.rally];
    if (!tgt || tgt.id === rock.id) {
      rock.rally = -1;
      continue;
    }
    rock.rallyCd = (rock.rallyCd ?? 0) - dt;
    if (rock.rallyCd > 0) continue;
    rock.rallyCd = RALLY_INTERVAL;
    for (let i = 0; i < s.count; i++) {
      if (s.state[i] !== STATE.ORBIT) continue;
      if (s.home[i] !== rock.id || s.owner[i] !== rock.owner) continue;
      if (s.kind[i] !== KIND.FIGHTER) continue; // keep defenders home
      launchSeedling(world, i, tgt);
    }
  }
}

// sendSeedlings — dispatch floor(eligible * fraction) ORBITing seedlings of `owner`
// from `fromId` toward `toId`. Returns count sent. Safe no-op on bad args.
// Note: floor is intentional — a low slider fraction can deliberately send 0 (tested).
export function sendSeedlings(world, fromId, toId, fraction, owner) {
  if (fromId === toId) return 0;
  const s = world.seed;
  const target = world.asteroids[toId];
  if (!target || target.dead) return 0; // can't send to a destroyed body
  const f = Math.max(0, Math.min(1, fraction));
  if (f === 0) return 0;

  const eligible = [];
  for (let i = 0; i < s.count; i++) {
    if (
      s.state[i] === STATE.ORBIT &&
      s.home[i] === fromId &&
      s.owner[i] === owner
    ) {
      eligible.push(i);
    }
  }
  const n = Math.floor(eligible.length * f);
  for (let k = 0; k < n; k++) launchSeedling(world, eligible[k], target);
  // One SEND event per real dispatch, at the origin rock — the sanctioned send path for both
  // human and AI, so AI sends get audio too. 0-send (floored fraction) emits nothing.
  if (n > 0) {
    const from = world.asteroids[fromId];
    if (from) pushEvent(world, EVENT.SEND, from.x, from.y, owner);
  }
  return n;
}

export default { updateSeedlings, sendSeedlings };
