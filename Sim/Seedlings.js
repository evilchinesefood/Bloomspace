// Sim/Seedlings.js — per-tick seedling movement (orbit/transit), sending, and arrival
// colonization. NO three.js. Combat (COMBAT/DEAD) is deferred to T4.
import { STATE, OWNER_NEUTRAL } from "./World.js";

const ORBIT_BASE = 1.2; // base angular speed (rad/sec)
const TRANSIT_BASE = 120; // base linear speed (world units/sec)
const ARRIVE_GAP = 24; // orbit gap added to target.radius for "arrived"

const speedFactor = (a) => 0.5 + (a ? a.speedStat : 50) / 100;

// updateSeedlings — advance every live seedling one tick.
export function updateSeedlings(world, dt) {
  const s = world.seed;
  for (let i = 0; i < s.count; i++) {
    const st = s.state[i];
    if (st === STATE.ORBIT) {
      const a = world.asteroids[s.home[i]];
      if (!a) continue;
      s.orbitAngle[i] += dt * ORBIT_BASE * speedFactor(a);
      s.x[i] = a.x + Math.cos(s.orbitAngle[i]) * s.orbitRadius[i];
      s.y[i] = a.y + Math.sin(s.orbitAngle[i]) * s.orbitRadius[i];
    } else if (st === STATE.TRANSIT) {
      const t = world.asteroids[s.target[i]];
      if (!t) {
        // Target vanished — park back into orbit around home.
        s.state[i] = STATE.ORBIT;
        s.target[i] = -1;
        continue;
      }
      const home = world.asteroids[s.home[i]];
      const speed = TRANSIT_BASE * speedFactor(home || t);
      const dx = t.x - s.x[i];
      const dy = t.y - s.y[i];
      const d = Math.hypot(dx, dy);
      if (d <= t.radius + ARRIVE_GAP) {
        resolveArrival(world, i, t);
        continue;
      }
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
    // Enemy-held: park into contact, keep alive, leave ownership unchanged.
    // T4: enemy arrival → combat
    joinOrbit(world, i, target);
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
  for (let k = 0; k < n; k++) {
    const i = eligible[k];
    s.target[i] = toId;
    s.state[i] = STATE.TRANSIT;
    const dx = target.x - s.x[i];
    const dy = target.y - s.y[i];
    const d = Math.hypot(dx, dy) || 1;
    const home = world.asteroids[fromId];
    const speed = TRANSIT_BASE * speedFactor(home || target);
    s.vx[i] = (dx / d) * speed;
    s.vy[i] = (dy / d) * speed;
  }
  return n;
}

export default { updateSeedlings, sendSeedlings };
