// Sim/MapGen.js — seeded procedural body layout + per-body stats. NO three.js.
// Deterministic: all randomness flows through world.rng() (seeded in World.js).
//
// Bodies:
//  - asteroids: small, habitable, the bulk of the field.
//  - planets:   rare, large, rich (gas/terran), habitable; count capped per map size.
//  - moons:     small asteroids that ORBIT a planet (or a host asteroid) and only connect to
//               that parent in the travel network. Drawn from the asteroid budget.
//  - binaries:  two asteroids locked in mutual orbit around their shared midpoint.
//  - star:      one central NON-habitable body every map has. Ships can orbit it but never
//               colonize it. A black-hole variant DESTROYS any ship that enters its orbit.
//
// Orbit model (generalized): a body with `orbiting` moves each tick around either another body
// (`orbitParent >= 0`) or a fixed point (`orbitCx/orbitCy`, used by binaries). See Sim/Moons.js.
import { OWNER_NEUTRAL } from "./World.js";

const MIN_RADIUS = 18;
const MAX_RADIUS = 40;
const MIN_GAP = 150; // min space between body edges (bodies sit well apart)
const EDGE_PAD = 30; // keep bodies off the map border
const HOME_SEEDLINGS = 10;
const HOME_ENERGY = 100;
export const STAT_MIN = 20;
const stat = (rng) => STAT_MIN + Math.round(rng() * (100 - STAT_MIN));

// Terrain specials (Feature 7a) — gated behind config.specials (default OFF, see generateMap).
// Effects keyed off rock.special / world.nebulae, applied in Economy/Trees/Seedlings. Tags are
// drawn at the END of generation so a specials-ON world shares the EXACT base layout of a
// specials-OFF world for the same seed. Plain JSON (string special, {x,y,radius} nebulae) so a
// later save/resume feature can serialize them.
export const RICH_ENERGY_MULT = 1.6; // rich rock regen + cap factor (composes with energyMult)
export const RICH_SEED_BONUS = 1; // extra seeds per flower on a rich rock
export const NEBULA_SLOW = 0.5; // transit/sling speed multiplier inside a nebula
const NEBULA_MIN_R = 180;
const NEBULA_MAX_R = 320;

const PLANET_MIN_R = 112; // ~2x asteroids
const PLANET_MAX_R = 184;
const PLANET_STAT_MIN = 55;
const PLANET_ENERGY_MULT = 2.5;
const planetStat = (rng) =>
  PLANET_STAT_MIN + Math.round(rng() * (100 - PLANET_STAT_MIN));

const STAR_MIN_R = 150;
const STAR_MAX_R = 210;
const BLACKHOLE_CHANCE = 0.22;
const STAR_CLEAR = 80; // clearance other bodies keep from the star (ships orbit it)

// Moons: small, on well-separated rings so they never clip each other; their planet reserves a
// clear "envelope" so the outermost ring never reaches a neighbouring body.
const MOON_MIN_R = 12;
const MOON_MAX_R = 20;
const MOON_RING0 = 36; // gap from parent surface to the first ring
const MOON_RING_STEP = 54; // radial gap between rings (> 2*MOON_MAX_R + pad → no moon-moon clip)
const MOON_MARGIN = 28; // clear space beyond the outer moon
const MOON_SPEED = 0.06; // base angular speed (rad/s) — 50% slower than the previous 0.12

const TAU = Math.PI * 2;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Radial space a planet must keep clear around it to fit up to 3 moon rings without clipping.
function moonEnvelope(ringCount) {
  return (
    MOON_RING0 + (ringCount - 1) * MOON_RING_STEP + MOON_MAX_R + MOON_MARGIN
  );
}
const PLANET_ENVELOPE = moonEnvelope(3); // extra clearance planets reserve

function envExtra(b) {
  if (b.kind === "planet") return PLANET_ENVELOPE;
  if (b.kind === "star" || b.kind === "blackhole") return STAR_CLEAR;
  return 0;
}

function makeBody(id, x, y, radius, kind, rng) {
  const isPlanet = kind === "planet";
  const sfn = isPlanet ? planetStat : stat;
  return {
    id,
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
    kind,
    // Stars/black holes are NOT habitable: never colonized, no trees, no production.
    habitable: kind === "asteroid" || kind === "planet",
    ptype: isPlanet ? (rng() < 0.5 ? "gas" : "terran") : null,
    seed: Math.floor(rng() * 1e9), // unique render look
    energyMult: isPlanet ? PLANET_ENERGY_MULT : 1,
    // Orbit + network fields.
    moon: false, // leaf that connects only to its parent
    binary: false,
    binarySecondary: false, // the binary member that connects only to its primary
    binaryPartner: -1,
    orbiting: false, // moves each tick (Sim/Moons.js)
    orbitParent: -1, // body it orbits, or -1 for a fixed-point (binary) orbit
    orbitCx: 0,
    orbitCy: 0,
    orbitDist: 0,
    orbitAng: 0,
    orbitSpeed: 0,
    neighbors: [],
  };
}

function makeStar(world, rng) {
  const radius = STAR_MIN_R + rng() * (STAR_MAX_R - STAR_MIN_R);
  const jx = (rng() - 0.5) * world.width * 0.12;
  const jy = (rng() - 0.5) * world.height * 0.12;
  const kind = rng() < BLACKHOLE_CHANCE ? "blackhole" : "star";
  return makeBody(
    0,
    world.width / 2 + jx,
    world.height / 2 + jy,
    radius,
    kind,
    rng,
  );
}

// Place `total` planets+asteroids around the pre-seeded bodies (the star), via rejection
// sampling. Planets/stars reserve extra clearance so moon orbits never reach a neighbour.
function placeBodies(world, total, planetCount, seeded) {
  const { width, height, rng } = world;
  const out = seeded.slice();
  let id = out.length;
  const tryPlace = (kind) => {
    const isPlanet = kind === "planet";
    for (let attempt = 0; attempt < 500; attempt++) {
      const radius = isPlanet
        ? PLANET_MIN_R + rng() * (PLANET_MAX_R - PLANET_MIN_R)
        : MIN_RADIUS + rng() * (MAX_RADIUS - MIN_RADIUS);
      const x = EDGE_PAD + radius + rng() * (width - 2 * (EDGE_PAD + radius));
      const y = EDGE_PAD + radius + rng() * (height - 2 * (EDGE_PAD + radius));
      const cand = { x, y, radius, kind };
      let ok = true;
      for (const a of out) {
        const need = a.radius + radius + MIN_GAP + envExtra(a) + envExtra(cand);
        if (dist(a, cand) < need) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      out.push(makeBody(id++, x, y, radius, kind, rng));
      return true;
    }
    return false;
  };
  for (let p = 0; p < planetCount; p++) tryPlace("planet");
  while (out.length - seeded.length < total) if (!tryPlace("asteroid")) break;
  return out;
}

// Plain habitable asteroids still free to repurpose (not a home, moon, or binary member).
function freeAsteroids(asteroids, blocked) {
  return asteroids.filter(
    (a) => a.kind === "asteroid" && !a.moon && !a.binary && !blocked.has(a.id),
  );
}

// Pick one home per player from the candidate ids, spread apart via farthest-point seeding.
function pickHomes(asteroids, candIds, playerCount, rng) {
  if (candIds.length === 0 || playerCount === 0) return [];
  const homes = [candIds[Math.floor(rng() * candIds.length)]];
  while (homes.length < playerCount && homes.length < candIds.length) {
    let best = -1;
    let bestMin = -1;
    for (const i of candIds) {
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

// Turn asteroid `a` into a body orbiting `center` (a body) at `orbitDist`. Shrinks it to a
// moon-sized rock and connects it only to its parent in the network.
function makeMoon(a, center, orbitDist, rng) {
  a.moon = true;
  a.orbiting = true;
  a.orbitParent = center.id;
  a.orbitDist = orbitDist;
  a.orbitAng = rng() * TAU;
  a.orbitSpeed = (MOON_SPEED + rng() * MOON_SPEED) * (rng() < 0.5 ? -1 : 1);
  a.radius = MOON_MIN_R + rng() * (MOON_MAX_R - MOON_MIN_R);
  a.x = center.x + Math.cos(a.orbitAng) * orbitDist;
  a.y = center.y + Math.sin(a.orbitAng) * orbitDist;
}

// Distance from `p` to the nearest OTHER body's surface (min clearance available around p).
function nearestClearance(asteroids, p) {
  let near = Infinity;
  for (const o of asteroids) {
    if (o.id === p.id) continue;
    near = Math.min(near, dist(o, p) - o.radius);
  }
  return near;
}

// Moons of each planet: 1–3 by planet size, on separate rings (no clipping by construction).
function assignPlanetMoons(asteroids, blocked, rng) {
  const planets = asteroids.filter((a) => a.kind === "planet");
  for (const p of planets) {
    const frac = (p.radius - PLANET_MIN_R) / (PLANET_MAX_R - PLANET_MIN_R);
    const want = Math.max(1, Math.min(3, 1 + Math.round(frac * 2)));
    const cands = freeAsteroids(asteroids, blocked)
      .map((a) => ({ a, d: dist(a, p) }))
      .sort((x, y) => x.d - y.d)
      .slice(0, want);
    let idx = 0;
    for (const { a } of cands) {
      makeMoon(a, p, p.radius + MOON_RING0 + idx * MOON_RING_STEP, rng);
      blocked.add(a.id);
      idx++;
    }
  }
}

// Some asteroids orbit a host asteroid — only where the host has clear space so the satellite
// never clips a neighbour.
function assignAsteroidSatellites(asteroids, blocked, rng, count) {
  let made = 0;
  for (const host of asteroids) {
    if (made >= count) break;
    if (host.kind !== "asteroid" || host.moon || host.binary) continue;
    if (blocked.has(host.id)) continue;
    const orbit = host.radius + MOON_RING0 + MOON_MAX_R;
    const envelope = orbit + MOON_MAX_R + MOON_MARGIN;
    if (nearestClearance(asteroids, host) < envelope) continue;
    const sat = freeAsteroids(asteroids, blocked).find((a) => a.id !== host.id);
    if (!sat) break;
    makeMoon(sat, host, orbit, rng);
    blocked.add(sat.id);
    blocked.add(host.id);
    made++;
  }
  return made;
}

// Make `a` a binary member locked around the shared midpoint (cx,cy).
function setBinaryMember(a, cx, cy, half, ang, speed, primary, partnerId) {
  a.binary = true;
  a.binarySecondary = !primary;
  a.binaryPartner = partnerId;
  a.orbiting = true;
  a.orbitParent = -1;
  a.orbitCx = cx;
  a.orbitCy = cy;
  a.orbitDist = half;
  a.orbitAng = ang;
  a.orbitSpeed = speed;
  a.x = cx + Math.cos(ang) * half;
  a.y = cy + Math.sin(ang) * half;
}

// Binary pairs: two nearby free asteroids locked in mutual orbit, where the pair has clear
// surrounding space so neither member sweeps into another body.
function assignBinaries(asteroids, blocked, rng, count) {
  let made = 0;
  for (const a of asteroids) {
    if (made >= count) break;
    if (a.kind !== "asteroid" || a.moon || a.binary || blocked.has(a.id))
      continue;
    let b = null;
    let bd = Infinity;
    for (const o of asteroids) {
      if (o.id === a.id || o.kind !== "asteroid" || o.moon || o.binary)
        continue;
      if (blocked.has(o.id)) continue;
      const d = dist(a, o);
      if (d < bd) {
        bd = d;
        b = o;
      }
    }
    if (!b) break;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const half = Math.max((a.radius + b.radius) / 2 + 24, 50);
    const envelope = half + Math.max(a.radius, b.radius) + MOON_MARGIN;
    let ok = true;
    for (const o of asteroids) {
      if (o.id === a.id || o.id === b.id) continue;
      if (dist(o, { x: cx, y: cy }) - o.radius < envelope) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const ang = rng() * TAU;
    const sp = (MOON_SPEED + rng() * MOON_SPEED) * (rng() < 0.5 ? -1 : 1);
    setBinaryMember(a, cx, cy, half, ang, sp, true, b.id);
    setBinaryMember(b, cx, cy, half, ang + Math.PI, sp, false, a.id);
    blocked.add(a.id);
    blocked.add(b.id);
    made++;
  }
  return made;
}

// Relative Neighborhood Graph among ANCHOR bodies (everything that isn't a leaf), then a single
// edge from each leaf to its anchor. Leaves: moons → their parent; binary secondaries → their
// primary. The star is an anchor (ships can route to and orbit it). RNG ⊃ EMST ⇒ connected.
function buildNeighbors(asteroids) {
  const n = asteroids.length;
  const adj = asteroids.map(() => new Set());
  const isLeaf = (i) => asteroids[i].moon || asteroids[i].binarySecondary;
  const anchorOf = (i) =>
    asteroids[i].moon ? asteroids[i].orbitParent : asteroids[i].binaryPartner;
  const nm = [];
  for (let i = 0; i < n; i++) if (!isLeaf(i)) nm.push(i);
  for (let a = 0; a < nm.length; a++) {
    for (let b = a + 1; b < nm.length; b++) {
      const i = nm[a];
      const j = nm[b];
      const dij = dist(asteroids[i], asteroids[j]);
      let ok = true;
      for (let c = 0; c < nm.length && ok; c++) {
        if (c === a || c === b) continue;
        const k = nm[c];
        if (
          dist(asteroids[i], asteroids[k]) < dij &&
          dist(asteroids[j], asteroids[k]) < dij
        )
          ok = false;
      }
      if (ok) {
        adj[i].add(j);
        adj[j].add(i);
      }
    }
  }
  for (let i = 0; i < n; i++)
    if (isLeaf(i) && anchorOf(i) >= 0) {
      adj[i].add(anchorOf(i));
      adj[anchorOf(i)].add(i);
    }
  // Bridge disconnected ANCHOR components (leaves hang off their anchor).
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
    let bi = -1;
    let bj = -1;
    let bd = Infinity;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        if (isLeaf(i) || isLeaf(j) || find(i) === find(j)) continue;
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
export function buildNav(asteroids, neighbors) {
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

// Recompute world.nav from each body's current `.neighbors` (after a manual link is added).
export function rebuildNav(world) {
  const neighbors = world.asteroids.map((a) => a.neighbors || []);
  world.nav = buildNav(world.asteroids, neighbors);
}

// addConnection — create a permanent travel link between bodies i and j (manual connections).
// Adds the symmetric edge, records it in world.links (for render), and rebuilds the nav table
// so units route across it. Caller enforces ownership + energy cost.
export function addConnection(world, i, j) {
  const A = world.asteroids[i];
  const B = world.asteroids[j];
  if (!A || !B || i === j) return false;
  if (A.neighbors.includes(j)) return false; // already linked
  A.neighbors = [...A.neighbors, j].sort((a, b) => a - b);
  B.neighbors = [...B.neighbors, i].sort((a, b) => a - b);
  if (!world.links) world.links = [];
  world.links.push([Math.min(i, j), Math.max(i, j)]);
  rebuildNav(world);
  return true;
}

// Manual connections cost a significant chunk of the source body's stored energy.
export const CONNECT_ENERGY_COST = 80;

// tryConnect — player-driven link between two bodies they BOTH control. Enforces ownership,
// no-duplicate, and the energy cost (paid from the source body). Returns true on success.
export function tryConnect(world, fromId, toId, owner) {
  const A = world.asteroids[fromId];
  const B = world.asteroids[toId];
  if (!A || !B || fromId === toId) return false;
  if (A.owner !== owner || B.owner !== owner) return false; // must control both ends
  if (A.neighbors.includes(toId)) return false; // already linked
  if ((A.energy || 0) < CONNECT_ENERGY_COST) return false;
  if (!addConnection(world, fromId, toId)) return false;
  A.energy -= CONNECT_ENERGY_COST;
  return true;
}

// tagSpecials — run at the END of generation (after homes + seedlings) so it only ADDS tags +
// nebula regions, never shifting the base layout. Draws rng only here ⇒ a specials-ON world and
// a specials-OFF world for the same seed share identical positions/stats/homes/seedlings.
function tagSpecials(world, homes) {
  const { rng, asteroids } = world;
  const homeSet = new Set(homes);
  // Resource-rich: plain habitable asteroids only (not a home, planet, moon, or binary member).
  const rich = asteroids.filter(
    (a) =>
      a.kind === "asteroid" &&
      a.habitable &&
      !a.moon &&
      !a.binary &&
      !homeSet.has(a.id),
  );
  const want = Math.max(1, Math.floor(asteroids.length / 6));
  // Fisher–Yates partial shuffle (rng-driven) → deterministic pick of `want` distinct rocks.
  for (let i = 0; i < rich.length && i < want; i++) {
    const j = i + Math.floor(rng() * (rich.length - i));
    const tmp = rich[i];
    rich[i] = rich[j];
    rich[j] = tmp;
    rich[i].special = "rich";
  }
  // Nebula: 1–2 hazy regions placed within the map bounds.
  const count = 1 + Math.floor(rng() * 2);
  const nebulae = [];
  for (let k = 0; k < count; k++) {
    const radius = NEBULA_MIN_R + rng() * (NEBULA_MAX_R - NEBULA_MIN_R);
    const x = radius + rng() * (world.width - 2 * radius);
    const y = radius + rng() * (world.height - 2 * radius);
    nebulae.push({ x, y, radius });
  }
  world.nebulae = nebulae;
}

// generateMap — populate world.asteroids, network, and each player's home orbit.
export function generateMap(world, config = {}, spawnSeedling) {
  const players = world.players;
  const total = config.asteroidCount ?? 20;
  const rng = world.rng;
  const pMin = config.planetMin ?? 1;
  const pMax = config.planetMax ?? 2;
  let planetCount = pMin + Math.floor(rng() * (pMax - pMin + 1));
  planetCount = Math.max(0, Math.min(planetCount, Math.floor(total / 2)));

  const star = makeStar(world, rng);
  const asteroids = placeBodies(world, total, planetCount, [star]);
  world.asteroids = asteroids;
  world.links = [];

  // Homes: plain habitable asteroids only (never the star, a planet, a moon, or a binary).
  const homeCand = asteroids
    .filter((a) => a.kind === "asteroid")
    .map((a) => a.id);
  const homes = pickHomes(asteroids, homeCand, players.length, rng);
  const blocked = new Set(homes);
  assignPlanetMoons(asteroids, blocked, rng);
  const extras = Math.floor(total / 12);
  assignAsteroidSatellites(asteroids, blocked, rng, 1 + extras);
  assignBinaries(asteroids, blocked, rng, 1 + extras);

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
        orbitAngle: (k / HOME_SEEDLINGS) * TAU,
        strength: a.strengthStat,
        energy: a.energyStat,
      });
    }
  }

  // Terrain specials LAST: tags + nebula regions ADD to a fully-placed world, drawing rng only
  // now, so a specials-ON world matches a specials-OFF world's base layout for the same seed.
  // Default OFF (no config.specials) ⇒ no tags + empty nebulae ⇒ the existing tests don't drift.
  if (config.specials) tagSpecials(world, homes);
  else world.nebulae = [];

  return world;
}

export default { generateMap, buildNav, rebuildNav, addConnection };
