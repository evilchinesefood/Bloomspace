// Sim/Seedlings.js — per-tick seedling movement (orbit/transit), sending, and arrival
// colonization. NO three.js. Combat (COMBAT/DEAD) is deferred to T4.
import { STATE, OWNER_NEUTRAL } from "./World.js";

const TAU = Math.PI * 2;
const ORBIT_BASE = 1.2; // base angular speed (rad/sec)
const TRANSIT_BASE = 120; // base linear speed (world units/sec)
const ARRIVE_GAP = 24; // orbit gap added to target.radius for "arrived"

const speedFactor = (a) => 0.5 + (a ? a.speedStat : 50) / 100;

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
  const d = Math.hypot(dx, dy) || 1;
  const speed = TRANSIT_BASE * speedFactor(world.asteroids[s.home[i]] || node);
  s.vx[i] = (dx / d) * speed;
  s.vy[i] = (dy / d) * speed;
}

// updateSeedlings — advance every live seedling one tick.
export function updateSeedlings(world, dt) {
  const s = world.seed;
  for (let i = 0; i < s.count; i++) {
    const st = s.state[i];
    if (st === STATE.ORBIT) {
      const a = world.asteroids[s.home[i]];
      if (!a) continue;
      let ang = s.orbitAngle[i] + dt * ORBIT_BASE * speedFactor(a);
      if (ang >= TAU) ang -= TAU;
      s.orbitAngle[i] = ang;
      s.x[i] = a.x + Math.cos(s.orbitAngle[i]) * s.orbitRadius[i];
      s.y[i] = a.y + Math.sin(s.orbitAngle[i]) * s.orbitRadius[i];
    } else if (st === STATE.TRANSIT) {
      const t = world.asteroids[s.target[i]];
      if (!t) {
        // Waypoint vanished — park back into orbit around home.
        s.state[i] = STATE.ORBIT;
        s.target[i] = -1;
        s.dest[i] = -1;
        continue;
      }
      const dx = t.x - s.x[i];
      const dy = t.y - s.y[i];
      const d = Math.hypot(dx, dy);
      if (d <= t.radius + ARRIVE_GAP) {
        // Reached this waypoint. If it's the final destination, resolve (colonize/fight);
        // otherwise advance to the next hop and keep flying along the network.
        if (t.id === s.dest[i]) {
          resolveArrival(world, i, t);
        } else {
          const hop = nextHop(world, t.id, s.dest[i]);
          const node = world.asteroids[hop];
          if (!node || hop === t.id) resolveArrival(world, i, t);
          else {
            s.target[i] = hop;
            aimAt(world, i, node);
          }
        }
        continue;
      }
      const speed = TRANSIT_BASE * speedFactor(world.asteroids[s.home[i]] || t);
      const move = Math.min(d, speed * dt);
      s.vx[i] = (dx / d) * speed;
      s.vy[i] = (dy / d) * speed;
      s.x[i] += (dx / d) * move;
      s.y[i] += (dy / d) * move;
    }
    // COMBAT / DEAD: left for T4; no-op here so nothing breaks.
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
  if (target.owner === OWNER_NEUTRAL) {
    // Colonize: first arrival flips ownership, then join the orbit.
    target.owner = owner;
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

// launchSeedling — route seedling i toward final destination `dest`, flying along the
// nearest-neighbor network (first hop now, the rest resolved waypoint by waypoint). Shared
// by player sends and tree-production rally routing. No-op if already home or unreachable.
export function launchSeedling(world, i, dest) {
  const s = world.seed;
  if (!dest || dest.id === s.home[i]) return;
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
      if (s.kind[i] !== 0) continue; // keep defenders home
      launchSeedling(world, i, tgt);
    }
  }
}

// sendSeedlings — dispatch floor(eligible * fraction) ORBITing seedlings of `owner`
// from `fromId` toward `toId`. Returns count sent. Safe no-op on bad args.
// Note: if fraction>0 and eligible>=1 but floor(eligible*fraction)===0, sends 0.
export function sendSeedlings(world, fromId, toId, fraction, owner) {
  if (fromId === toId) return 0;
  const s = world.seed;
  const target = world.asteroids[toId];
  if (!target) return 0;
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
  return n;
}

export default { updateSeedlings, sendSeedlings };
