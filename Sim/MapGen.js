// Sim/MapGen.js — seeded procedural body layout + per-rock stats. NO three.js.
// Deterministic: all randomness flows through world.rng() (seeded in World.js).
//
// Bodies: asteroids (small), planets (rare, large, rich, gas/terran, count capped per map
// size), and moons (small asteroids that ORBIT a planet and only connect to that planet in
// the travel network). Moons are drawn from the asteroid budget (total bodies = asteroidCount).
import { OWNER_NEUTRAL } from "./World.js";

const MIN_RADIUS = 18;
const MAX_RADIUS = 46;
const MIN_GAP = 120; // min space between body edges (bodies sit well apart)
const EDGE_PAD = 30; // keep bodies off the map border
const HOME_SEEDLINGS = 10;
const HOME_ENERGY = 100;
export const STAT_MIN = 20;
const stat = (rng) => STAT_MIN + Math.round(rng() * (100 - STAT_MIN));

const PLANET_MIN_R = 112; // ~2x asteroids
const PLANET_MAX_R = 184;
const PLANET_STAT_MIN = 55;
const PLANET_ENERGY_MULT = 2.5;
const planetStat = (rng) =>
  PLANET_STAT_MIN + Math.round(rng() * (100 - PLANET_STAT_MIN));
const TAU = Math.PI * 2;

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Place `total` bodies: `planetCount` planets first, then asteroids, via rejection sampling.
function placeBodies(world, total, planetCount) {
  const { width, height, rng } = world;
  const out = [];
  let id = 0;
  const tryPlace = (isPlanet) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const radius = isPlanet
        ? PLANET_MIN_R + rng() * (PLANET_MAX_R - PLANET_MIN_R)
        : MIN_RADIUS + rng() * (MAX_RADIUS - MIN_RADIUS);
      const x = EDGE_PAD + radius + rng() * (width - 2 * (EDGE_PAD + radius));
      const y = EDGE_PAD + radius + rng() * (height - 2 * (EDGE_PAD + radius));
      let ok = true;
      for (const a of out)
        if (dist(a, { x, y }) < a.radius + radius + MIN_GAP) {
          ok = false;
          break;
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
        rally: -1,
        kind: isPlanet ? "planet" : "asteroid",
        ptype: isPlanet ? (rng() < 0.5 ? "gas" : "terran") : null,
        // Per-planet seed → unique look (no two planets render the same).
        seed: isPlanet ? Math.floor(rng() * 1e9) : 0,
        energyMult: isPlanet ? PLANET_ENERGY_MULT : 1,
        moon: false,
        parent: -1,
      });
      return true;
    }
    return false;
  };
  for (let p = 0; p < planetCount; p++) tryPlace(true);
  while (out.length < total) if (!tryPlace(false)) break;
  return out;
}

// Pick one home rock per player, spread apart via farthest-point seeding.
function pickHomes(asteroids, playerCount, rng) {
  if (asteroids.length === 0 || playerCount === 0) return [];
  const homes = [Math.floor(rng() * asteroids.length)];
  while (homes.length < playerCount && homes.length < asteroids.length) {
    let best = -1,
      bestMin = -1;
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

// Convert some free asteroids into moons of each planet (1–3 by planet size), repositioning
// them into a tight orbit. Moons stay fully playable asteroids; they just revolve + move.
function assignMoons(asteroids, homeSet, rng) {
  const planets = asteroids.filter((a) => a.kind === "planet");
  const used = new Set();
  for (const p of planets) {
    const frac = (p.radius - PLANET_MIN_R) / (PLANET_MAX_R - PLANET_MIN_R);
    const want = Math.max(1, Math.min(3, 1 + Math.round(frac * 2)));
    const cands = asteroids
      .filter(
        (a) =>
          a.kind === "asteroid" &&
          !a.moon &&
          !homeSet.has(a.id) &&
          !used.has(a.id),
      )
      .map((a) => ({ a, d: dist(a, p) }))
      .sort((x, y) => x.d - y.d)
      .slice(0, want);
    let idx = 0;
    for (const { a } of cands) {
      a.moon = true;
      a.parent = p.id;
      a.orbitDist = p.radius + a.radius + 28 + idx * 40;
      a.orbitAng = rng() * TAU;
      a.orbitSpeed = (0.12 + rng() * 0.16) * (rng() < 0.5 ? -1 : 1);
      a.x = p.x + Math.cos(a.orbitAng) * a.orbitDist;
      a.y = p.y + Math.sin(a.orbitAng) * a.orbitDist;
      used.add(a.id);
      idx++;
    }
  }
}

// Symmetric nearest-neighbor graph among NON-moon bodies, then a single edge from each moon
// to its parent planet (moons are only reachable through their planet). Guaranteed connected.
function buildNeighbors(asteroids) {
  const n = asteroids.length;
  const adj = asteroids.map(() => new Set());
  const isMoon = (i) => asteroids[i].moon;
  for (let i = 0; i < n; i++) {
    if (isMoon(i)) continue;
    const order = [];
    for (let j = 0; j < n; j++)
      if (j !== i && !isMoon(j))
        order.push([dist(asteroids[i], asteroids[j]), j]);
    order.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (let m = 0; m < Math.min(4, order.length); m++) {
      const j = order[m][1];
      adj[i].add(j);
      adj[j].add(i);
    }
  }
  for (let i = 0; i < n; i++)
    if (isMoon(i) && asteroids[i].parent >= 0) {
      adj[i].add(asteroids[i].parent);
      adj[asteroids[i].parent].add(i);
    }
  // Bridge disconnected NON-moon components (moons are leaves on their parent).
  const parent = asteroids.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const union = (a, b) => (parent[find(a)] = find(b));
  for (let i = 0; i < n; i++) for (const j of adj[i]) union(i, j);
  const comps = () => {
    const r = new Set();
    for (let i = 0; i < n; i++) r.add(find(i));
    return r.size;
  };
  while (comps() > 1) {
    let bi = -1,
      bj = -1,
      bd = Infinity;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        if (isMoon(i) || isMoon(j) || find(i) === find(j)) continue;
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

// All-pairs first-hop table via BFS: nav[s][t] = first neighbor of s on a shortest path to t.
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

// generateMap — populate world.asteroids, network, and each player's home orbit.
export function generateMap(world, config = {}, spawnSeedling) {
  const players = world.players;
  const total = config.asteroidCount ?? 20;
  const rng = world.rng;
  // Planet count is capped per map size (passed in via config.planetMin/Max).
  const pMin = config.planetMin ?? 1;
  const pMax = config.planetMax ?? 2;
  let planetCount = pMin + Math.floor(rng() * (pMax - pMin + 1));
  planetCount = Math.max(0, Math.min(planetCount, Math.floor(total / 2)));

  const asteroids = placeBodies(world, total, planetCount);
  world.asteroids = asteroids;

  const homes = pickHomes(asteroids, players.length, rng);
  const homeSet = new Set(homes.map((h) => asteroids[h].id));
  assignMoons(asteroids, homeSet, rng);

  const neighbors = buildNeighbors(asteroids);
  for (let i = 0; i < asteroids.length; i++)
    asteroids[i].neighbors = neighbors[i];
  world.nav = buildNav(asteroids, neighbors);

  for (let p = 0; p < homes.length; p++) {
    const a = asteroids[homes[p]];
    const owner = players[p].id;
    a.owner = owner;
    a.energy = HOME_ENERGY;
    for (let k = 0; k < HOME_SEEDLINGS; k++) {
      spawnSeedling(world, {
        home: a.id,
        owner,
        orbitRadius: a.radius + 30 + rng() * 20,
        orbitAngle: (k / HOME_SEEDLINGS) * Math.PI * 2,
        strength: a.strengthStat,
        energy: a.energyStat,
      });
    }
  }
  return world;
}

export default { generateMap };
