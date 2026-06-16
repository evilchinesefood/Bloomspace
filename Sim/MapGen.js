// Sim/MapGen.js — seeded procedural asteroid layout + per-rock stats. NO three.js.
// Deterministic: all randomness flows through world.rng() (seeded in World.js).
import { OWNER_NEUTRAL } from "./World.js";

const MIN_RADIUS = 18;
const MAX_RADIUS = 46;
const MIN_GAP = 60; // min space between rock edges
const EDGE_PAD = 30; // keep rocks off the map border
const HOME_SEEDLINGS = 10; // starting orbiters per home rock
const HOME_ENERGY = 100; // starting stored energy on a home rock
// Floor for the three rock stats. A near-0 energyStat would make a rock's seedlings
// dead-on-arrival in combat (they inherit energyStat as starting energy), so clamp the
// usable range to ~STAT_MIN..100 without changing the number of rng() calls.
export const STAT_MIN = 20;
const stat = (rng) => STAT_MIN + Math.round(rng() * (100 - STAT_MIN));

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Scatter asteroids via rejection sampling; degrade gracefully if the map is dense.
function placeAsteroids(world, count) {
  const { width, height, rng } = world;
  const out = [];
  let id = 0;
  let attempts = 0;
  const maxAttempts = count * 200;
  while (out.length < count && attempts < maxAttempts) {
    attempts++;
    const radius = MIN_RADIUS + rng() * (MAX_RADIUS - MIN_RADIUS);
    const x = EDGE_PAD + radius + rng() * (width - 2 * (EDGE_PAD + radius));
    const y = EDGE_PAD + radius + rng() * (height - 2 * (EDGE_PAD + radius));
    const cand = { x, y, radius };
    let ok = true;
    for (const a of out) {
      if (dist(a, cand) < a.radius + radius + MIN_GAP) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    out.push({
      id: id++,
      x,
      y,
      radius,
      energyStat: stat(rng),
      strengthStat: stat(rng),
      speedStat: stat(rng),
      owner: OWNER_NEUTRAL,
      energy: 0,
      trees: [],
      rally: -1, // anchor point: -1 none, else target asteroid id for new production
    });
  }
  return out;
}

// Pick one home rock per player, spread apart via farthest-point seeding.
function pickHomes(asteroids, playerCount, rng) {
  if (asteroids.length === 0 || playerCount === 0) return [];
  const homes = [];
  // Seed with a deterministic-but-rng-chosen first rock.
  const first = Math.floor(rng() * asteroids.length);
  homes.push(first);
  while (homes.length < playerCount && homes.length < asteroids.length) {
    let best = -1;
    let bestMin = -1;
    for (let i = 0; i < asteroids.length; i++) {
      if (homes.includes(i)) continue;
      let minD = Infinity;
      for (const h of homes)
        minD = Math.min(minD, dist(asteroids[i], asteroids[h]));
      if (minD > bestMin) {
        bestMin = minD;
        best = i;
      }
    }
    homes.push(best);
  }
  return homes;
}

// generateMap — populate world.asteroids and seed each player's home orbit.
// Returns the world (mutated in place).
export function generateMap(world, config = {}, spawnSeedling) {
  const players = world.players;
  const asteroidCount = config.asteroidCount ?? 20;
  const asteroids = placeAsteroids(world, asteroidCount);
  world.asteroids = asteroids;

  const homes = pickHomes(asteroids, players.length, world.rng);
  for (let p = 0; p < homes.length; p++) {
    const a = asteroids[homes[p]];
    const owner = players[p].id;
    a.owner = owner;
    a.energy = HOME_ENERGY;
    for (let k = 0; k < HOME_SEEDLINGS; k++) {
      spawnSeedling(world, {
        home: a.id,
        owner,
        orbitRadius: a.radius + 30 + world.rng() * 20,
        orbitAngle: (k / HOME_SEEDLINGS) * Math.PI * 2,
        // Seedlings grown on a rock inherit its stats.
        strength: a.strengthStat,
        energy: a.energyStat,
      });
    }
  }
  return world;
}

export default { generateMap };
