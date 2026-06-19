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
import { seedlingTree } from "./Trees.js";

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
// Dense belt (Feature 7b): a debris band that blocks direct flight. Anchor–anchor edges that
// cross a belt are removed from the travel graph (forcing routing/slingshot around it), and a
// ship physically inside a belt is slowed harder than a nebula. Connectivity is guaranteed:
// if removal would partition the map, ensureConnected re-adds a minimal gateway edge.
export const BELT_SLOW = 0.35; // transit/sling speed multiplier inside a belt (< NEBULA_SLOW)
const BELT_MIN_R = 200;
const BELT_MAX_R = 340;

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

// segHitsCircle — does the segment a→b come within `r` of center (cx,cy)? Standard
// point-to-segment distance vs radius (closest point clamped to the segment). Used to find
// travel edges that cross a belt region.
function segHitsCircle(ax, ay, bx, by, cx, cy, r) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((cx - ax) * dx + (cy - ay) * dy) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const px = ax + t * dx;
  const py = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey <= r * r;
}

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

// Candidate proposers — each returns {x,y,radius} via rng ONLY. The clearance/acceptance
// loop in placeBodies is shared across all layouts (overlap rejection is layout-agnostic).
// scatter: uniform rejection sampling across the full field (byte-identical to the original).
function proposeScatter(width, height, radius, rng) {
  const x = EDGE_PAD + radius + rng() * (width - 2 * (EDGE_PAD + radius));
  const y = EDGE_PAD + radius + rng() * (height - 2 * (EDGE_PAD + radius));
  return { x, y };
}

// loop: bodies on a ring around the centre with radial+angular jitter.
function proposeLoop(width, height, radius, rng) {
  const cx = width / 2;
  const cy = height / 2;
  const half = Math.min(cx, cy);
  const ringR = half * (0.35 + rng() * 0.25); // 35–60% of half-extent
  const ang = rng() * Math.PI * 2;
  const jR = (rng() - 0.5) * half * 0.18;
  const jA = (rng() - 0.5) * 0.4;
  const r = ringR + jR;
  const x = cx + Math.cos(ang + jA) * r;
  const y = cy + Math.sin(ang + jA) * r;
  return {
    x: Math.max(EDGE_PAD + radius, Math.min(width - EDGE_PAD - radius, x)),
    y: Math.max(EDGE_PAD + radius, Math.min(height - EDGE_PAD - radius, y)),
  };
}

// linear: bodies along a full-range corridor angle drawn once before placement (shared by all
// bodies in the map), with per-body along-lane position and perpendicular jitter.
function proposeLinear(width, height, radius, rng, laneAng) {
  const cx = width / 2;
  const cy = height / 2;
  const span = Math.min(width, height) * 0.9;
  const t = (rng() - 0.5) * span; // along-lane position
  const perp = (rng() - 0.5) * Math.min(width, height) * 0.45; // corridor width — wide enough to seat a full map
  const x = cx + Math.cos(laneAng) * t - Math.sin(laneAng) * perp;
  const y = cy + Math.sin(laneAng) * t + Math.cos(laneAng) * perp;
  return {
    x: Math.max(EDGE_PAD + radius, Math.min(width - EDGE_PAD - radius, x)),
    y: Math.max(EDGE_PAD + radius, Math.min(height - EDGE_PAD - radius, y)),
  };
}

// hub: central cluster near the star + spoke-radial bodies further out.
function proposeHub(width, height, radius, rng) {
  const cx = width / 2;
  const cy = height / 2;
  const half = Math.min(cx, cy);
  // ~40% of bodies close-in, rest on spokes.
  const close = rng() < 0.4;
  const dist_ = close
    ? half * (0.1 + rng() * 0.2)
    : half * (0.45 + rng() * 0.45);
  const ang = rng() * Math.PI * 2;
  const x = cx + Math.cos(ang) * dist_;
  const y = cy + Math.sin(ang) * dist_;
  return {
    x: Math.max(EDGE_PAD + radius, Math.min(width - EDGE_PAD - radius, x)),
    y: Math.max(EDGE_PAD + radius, Math.min(height - EDGE_PAD - radius, y)),
  };
}

// Place `total` planets+asteroids around the pre-seeded bodies (the star), via rejection
// sampling. Planets/stars reserve extra clearance so moon orbits never reach a neighbour.
// config.layout selects the candidate proposer; scatter is the original (byte-identical) path.
function placeBodies(world, total, planetCount, seeded, layout) {
  const { width, height, rng } = world;
  const out = seeded.slice();
  let id = out.length;

  // Resolve "random" once, via rng, at placement time.
  const LAYOUTS = ["scatter", "loop", "linear", "hub"];
  const eff =
    layout === "random"
      ? LAYOUTS[Math.floor(rng() * LAYOUTS.length)]
      : layout || "scatter";

  // linear draws its corridor angle ONCE here (gated to linear only — no extra rng for scatter).
  const laneAng = eff === "linear" ? rng() * Math.PI : 0;

  const propose = (radius) => {
    if (eff === "loop") return proposeLoop(width, height, radius, rng);
    if (eff === "linear")
      return proposeLinear(width, height, radius, rng, laneAng);
    if (eff === "hub") return proposeHub(width, height, radius, rng);
    // scatter (default): EXACT original two rng calls, same order.
    return proposeScatter(width, height, radius, rng);
  };

  const tryPlace = (kind, proposer = propose) => {
    const isPlanet = kind === "planet";
    for (let attempt = 0; attempt < 500; attempt++) {
      const radius = isPlanet
        ? PLANET_MIN_R + rng() * (PLANET_MAX_R - PLANET_MIN_R)
        : MIN_RADIUS + rng() * (MAX_RADIUS - MIN_RADIUS);
      const { x, y } = proposer(radius);
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
  if (eff === "scatter") {
    // Scatter samples the whole field; a failure means it's genuinely full → stop. Unchanged
    // original path, so the scatter layout stays byte-identical.
    while (out.length - seeded.length < total) if (!tryPlace("asteroid")) break;
  } else {
    // Constrained layouts (loop/linear/hub) legitimately fail INDIVIDUAL placements while room
    // remains, so one failure must NOT abort the whole map — the old `break` left linear with
    // ~0-1 asteroids and players homeless (instant game-over). Keep trying until `total` is met or
    // a run of consecutive failures shows the layout's usable area is saturated.
    let consecFail = 0;
    while (out.length - seeded.length < total && consecFail < 12) {
      if (tryPlace("asteroid")) consecFail = 0;
      else consecFail++;
    }
    // Safety net: a tight layout/seed can seat fewer asteroids than there are players, leaving
    // someone homeless (instant game-over). Top up with plain scatter placements until there are
    // enough asteroids for every player to claim a home. Only fires when the layout fell short.
    const minAst = world.players.length + 1;
    const scatterAt = (r) => proposeScatter(width, height, r, rng);
    while (
      out.reduce((n, b) => n + (b.kind === "asteroid" ? 1 : 0), 0) < minAst &&
      tryPlace("asteroid", scatterAt)
    ) {}
  }
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
  // Defensive: fewer habitable candidates than players leaves trailing players homeless (read as
  // already-eliminated by checkVictory). Unreachable via the menu, but surface it for any
  // programmatic config so the shortfall isn't silent. Determinism for in-range configs unchanged.
  if (playerCount > candIds.length)
    console.warn(
      `pickHomes: ${playerCount} players but only ${candIds.length} home candidates — ` +
        `${playerCount - candIds.length} player(s) will start homeless`,
    );
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

// isLeaf — a body that connects ONLY to its one anchor (a moon, or a binary secondary). Its
// single parent edge is never a candidate for removal/bridging.
const isLeaf = (asteroids, i) =>
  asteroids[i].moon || asteroids[i].binarySecondary;

// ensureConnected — repeatedly add the shortest cross-component ANCHOR–ANCHOR edge to `adj`
// (array of neighbor Sets, mutated in place) until the whole graph is one component. Leaves
// hang off their anchor (already linked), so the union-find runs over every body but bridge
// candidates are non-leaves only. Shared by buildNeighbors (initial bridge) and the belt
// edge-removal post-pass (re-bridge after crossing edges are cut). NO rng.
//
// `opts.avoid(i,j)` (OPTIONAL) marks an edge as undesirable (a belt-crossing edge). When given,
// each iteration prefers the shortest cross-component NON-avoided edge, and only falls back to
// the shortest avoided "gateway" edge if no non-avoided edge connects any two components that
// iteration (connectivity is still guaranteed). When `avoid` is ABSENT (the buildNeighbors
// call), behavior is EXACTLY as before — the shortest cross-component edge with a strict d<bd
// tiebreak — so OFF-path graphs stay byte-identical.
function ensureConnected(asteroids, adj, opts = {}) {
  const n = asteroids.length;
  const avoid = opts.avoid;
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
    // Best preferred (non-avoided) edge and best fallback (avoided) edge this iteration.
    let bi = -1;
    let bj = -1;
    let bd = Infinity;
    let fi = -1;
    let fj = -1;
    let fd = Infinity;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        if (isLeaf(asteroids, i) || isLeaf(asteroids, j) || find(i) === find(j))
          continue;
        const d = dist(asteroids[i], asteroids[j]);
        if (avoid && avoid(i, j)) {
          if (d < fd) {
            fd = d;
            fi = i;
            fj = j;
          }
        } else if (d < bd) {
          bd = d;
          bi = i;
          bj = j;
        }
      }
    // Prefer a non-avoided edge; only bridge across the belt if nothing else connects.
    if (bi < 0) {
      bi = fi;
      bj = fj;
    }
    if (bi < 0) break;
    adj[bi].add(bj);
    adj[bj].add(bi);
    union(bi, bj);
  }
}

// Relative Neighborhood Graph among ANCHOR bodies (everything that isn't a leaf), then a single
// edge from each leaf to its anchor. Leaves: moons → their parent; binary secondaries → their
// primary. The star is an anchor (ships can route to and orbit it). RNG ⊃ EMST ⇒ connected.
function buildNeighbors(asteroids) {
  const n = asteroids.length;
  const adj = asteroids.map(() => new Set());
  const anchorOf = (i) =>
    asteroids[i].moon ? asteroids[i].orbitParent : asteroids[i].binaryPartner;
  const nm = [];
  for (let i = 0; i < n; i++) if (!isLeaf(asteroids, i)) nm.push(i);
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
    if (isLeaf(asteroids, i) && anchorOf(i) >= 0) {
      adj[i].add(anchorOf(i));
      adj[anchorOf(i)].add(i);
    }
  // Bridge disconnected ANCHOR components (leaves hang off their anchor).
  ensureConnected(asteroids, adj);
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

// Manual connections cost a chunk of the source body's stored energy.
export const CONNECT_ENERGY_COST = 40;

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
    (a) => a.kind === "asteroid" && !a.moon && !a.binary && !homeSet.has(a.id),
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

  // Dense belt: ONE debris band placed near the map center (where it plausibly sits between
  // bodies) with a small rng jitter, so straight travel across the middle is impeded. Plain
  // {x,y,radius} numbers (serializable for save/resume). Placed in open space — the radius is a
  // meaningful fraction of the map so several anchor edges cross it.
  const bRadius = BELT_MIN_R + rng() * (BELT_MAX_R - BELT_MIN_R);
  const bx = world.width / 2 + (rng() - 0.5) * world.width * 0.3;
  const by = world.height / 2 + (rng() - 0.5) * world.height * 0.3;
  world.belts = [{ x: bx, y: by, radius: bRadius }];
  applyBeltEdgeRemoval(world);
}

// applyBeltEdgeRemoval — POST-PASS on the already-built graph. For every ANCHOR–ANCHOR edge
// (never a leaf's single parent edge), drop it if the body-to-body segment crosses any belt
// circle — this forces ships to route AROUND the belt. After removal the graph may be
// disconnected, so ensureConnected re-bridges it BELT-AWARE: it prefers the shortest
// NON-crossing cross-component edge, and only falls back to a belt-crossing "gateway" when no
// non-crossing edge can reconnect the components (a belt impedes but must never make a body
// unreachable). So the belt forces a real detour wherever one exists, yet a belt that would
// genuinely partition the map keeps a single gateway. Mutates each body's .neighbors and
// rebuilds world.nav. NO rng — runs on the static graph + belt geometry, so it never shifts the
// base body/home/seedling layout.
export function applyBeltEdgeRemoval(world) {
  const { asteroids, belts } = world;
  if (!belts || belts.length === 0) return;
  const n = asteroids.length;
  // Rebuild the adjacency as Sets from the current neighbor lists.
  const adj = asteroids.map((a) => new Set(a.neighbors));
  const crosses = (i, j) => {
    const a = asteroids[i];
    const b = asteroids[j];
    for (const z of belts)
      if (segHitsCircle(a.x, a.y, b.x, b.y, z.x, z.y, z.radius)) return true;
    return false;
  };
  for (let i = 0; i < n; i++) {
    if (isLeaf(asteroids, i)) continue; // a leaf keeps its only (parent) edge
    for (const j of [...adj[i]]) {
      if (j <= i || isLeaf(asteroids, j)) continue; // skip leaf edges + dedupe (i<j once)
      if (crosses(i, j)) {
        adj[i].delete(j);
        adj[j].delete(i);
      }
    }
  }
  // Re-bridge any components the removal split off — but BELT-AWARE: prefer a non-crossing
  // gateway so the belt forces a real detour wherever one exists; only re-add a belt-crossing
  // edge when no non-crossing edge can reconnect the components (connectivity over purity).
  ensureConnected(asteroids, adj, { avoid: crosses });
  for (let i = 0; i < n; i++)
    asteroids[i].neighbors = Array.from(adj[i]).sort((a, b) => a - b);
  rebuildNav(world);
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
  const asteroids = placeBodies(
    world,
    total,
    planetCount,
    [star],
    config.layout,
  );
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
    // Real matches (the menu sets config.startTree) give every spawn home one mature seedling tree
    // so you produce from the start. Opt-in: the tutorial (which teaches planting) and the unit
    // tests don't set it, so they get pristine homes.
    if (config.startTree) (a.trees || (a.trees = [])).push(seedlingTree());
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
  else {
    world.nebulae = [];
    world.belts = [];
  }

  return world;
}

export default {
  generateMap,
  buildNav,
  rebuildNav,
  addConnection,
  applyBeltEdgeRemoval,
};
