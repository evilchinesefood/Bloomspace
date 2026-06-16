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

// Planets: rarer, much larger bodies with richer stats and faster energy. Two looks.
const PLANET_CHANCE = 0.45;
const PLANET_MIN_R = 112; // ~2x asteroids; planets dominate their neighborhood
const PLANET_MAX_R = 184;
const PLANET_STAT_MIN = 55; // planets roll in a higher band than asteroids
const PLANET_ENERGY_MULT = 2.5; // planets generate energy this much faster
const planetStat = (rng) =>
  PLANET_STAT_MIN + Math.round(rng() * (100 - PLANET_STAT_MIN));

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
    const isPlanet = rng() < PLANET_CHANCE;
    const radius = isPlanet
      ? PLANET_MIN_R + rng() * (PLANET_MAX_R - PLANET_MIN_R)
      : MIN_RADIUS + rng() * (MAX_RADIUS - MIN_RADIUS);
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
    const sfn = isPlanet ? planetStat : stat;
    out.push({
      id: id++,
      x,
      y,
      radius,
      energyStat: sfn(rng),
      strengthStat: sfn(rng),
      speedStat: sfn(rng),
      owner: OWNER_NEUTRAL,
      energy: 0,
      trees: [],
      rally: -1, // anchor point: -1 none, else target asteroid id for new production
      kind: isPlanet ? "planet" : "asteroid",
      ptype: isPlanet ? (rng() < 0.5 ? "gas" : "terran") : null,
      energyMult: isPlanet ? PLANET_ENERGY_MULT : 1,
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

const NEIGHBORS_K = 4; // each asteroid links to its ~K nearest (symmetric)

// Build a symmetric nearest-neighbor graph, then guarantee it's fully connected by adding
// the shortest cross-component edges (so every asteroid is reachable for routing).
function buildNeighbors(asteroids) {
  const n = asteroids.length;
  const adj = asteroids.map(() => new Set());
  for (let i = 0; i < n; i++) {
    const order = [];
    for (let j = 0; j < n; j++)
      if (j !== i) order.push([dist(asteroids[i], asteroids[j]), j]);
    order.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (let m = 0; m < Math.min(NEIGHBORS_K, order.length); m++) {
      const j = order[m][1];
      adj[i].add(j);
      adj[j].add(i);
    }
  }
  // Union-find to detect + bridge disconnected components.
  const parent = asteroids.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const union = (a, b) => (parent[find(a)] = find(b));
  for (let i = 0; i < n; i++) for (const j of adj[i]) union(i, j);
  const componentCount = () => {
    const roots = new Set();
    for (let i = 0; i < n; i++) roots.add(find(i));
    return roots.size;
  };
  while (componentCount() > 1) {
    let bi = -1,
      bj = -1,
      bd = Infinity;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        if (find(i) === find(j)) continue;
        const d = dist(asteroids[i], asteroids[j]);
        if (d < bd) {
          bd = d;
          bi = i;
          bj = j;
        }
      }
    if (bi < 0) break;
    adj[bi].add(bj);
    adj[bj].add(bi);
    union(bi, bj);
  }
  return adj.map((s) => Array.from(s).sort((a, b) => a - b));
}

// All-pairs first-hop table via BFS from each node: nav[s][t] = the neighbor of s that is
// the first step on a shortest path to t (s for t===s, -1 if unreachable).
function buildNav(asteroids, neighbors) {
  const n = asteroids.length;
  const nav = [];
  for (let s = 0; s < n; s++) {
    const firstHop = new Int32Array(n).fill(-1);
    firstHop[s] = s;
    const seen = new Uint8Array(n);
    seen[s] = 1;
    const queue = [s];
    let qi = 0;
    while (qi < queue.length) {
      const cur = queue[qi++];
      for (const nb of neighbors[cur]) {
        if (seen[nb]) continue;
        seen[nb] = 1;
        firstHop[nb] = cur === s ? nb : firstHop[cur];
        queue.push(nb);
      }
    }
    nav.push(firstHop);
  }
  return nav;
}

// generateMap — populate world.asteroids and seed each player's home orbit.
// Returns the world (mutated in place).
export function generateMap(world, config = {}, spawnSeedling) {
  const players = world.players;
  const asteroidCount = config.asteroidCount ?? 20;
  const asteroids = placeAsteroids(world, asteroidCount);
  world.asteroids = asteroids;

  // Nearest-neighbor network + routing table (multi-hop travel runs along these links).
  const neighbors = buildNeighbors(asteroids);
  for (let i = 0; i < asteroids.length; i++)
    asteroids[i].neighbors = neighbors[i];
  world.nav = buildNav(asteroids, neighbors);

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
