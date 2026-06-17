// Sim/Combat.js — proximity combat + asteroid ownership flips. NO three.js (headless).
// Pure-data, deterministic: positions/energy already live in world.seed SoA; all logic
// here is index math over those typed arrays. No randomness is used at all.
//
// INVARIANT (load-bearing): world.asteroids is NEVER removed or reordered here — we only
// mutate `asteroid.owner`. Seedling home/target are indices into world.asteroids, so any
// reorder would silently corrupt every seedling's home/target. Only `owner` is touched.
import {
  STATE,
  killSeedling,
  OWNER_NEUTRAL,
  MAX_PLAYERS,
  EVENT,
  pushEvent,
} from "./World.js";

export const CONTACT_RADIUS = 14; // world units; enemies this close trade damage
export const COMBAT_RATE = 0.1; // damage/sec scalar: energy -= enemyStrength*RATE*dt
export const HOLD_GAP = 56; // hold-zone = asteroid.radius + HOLD_GAP (covers orbiters)

const CELL = CONTACT_RADIUS; // grid cell size ≈ contact radius
const R2 = CONTACT_RADIUS * CONTACT_RADIUS;

// Reused spatial-grid buffers (allocated lazily, cleared+refilled each tick — no per-tick
// Map/array churn). `cells` maps a packed cell key -> array of seedling indices.
const grid = {
  cells: new Map(),
  cellOf: new Int32Array(0), // packed cell key per seedling slot (for neighbor lookup)
  cx: new Int32Array(0),
  cy: new Int32Array(0),
};

function ensureCap(n) {
  if (grid.cellOf.length < n) {
    const cap = Math.max(n, grid.cellOf.length * 2, 256);
    grid.cellOf = new Int32Array(cap);
    grid.cx = new Int32Array(cap);
    grid.cy = new Int32Array(cap);
  }
}

// Reused buffers for the same-home engagement pass (no per-tick allocation).
// owner-id slots (0..MAX_PLAYERS-1). Set lazily on first use, NOT at module load: World.js
// imports Combat.js before its own MAX_PLAYERS is initialized (circular dep), so reading it
// at module-eval time throws a TDZ ReferenceError. By the first combat tick it's ready.
let MAXO = 0;
let engaged = new Uint8Array(0);
let strAt = new Float32Array(0); // [asteroid*MAXO + owner] -> strength sum on that rock
let totAt = new Float32Array(0); // [asteroid] -> total orbiting strength
function ensureHomeBufs(seedCap, astCount) {
  if (MAXO === 0) MAXO = MAX_PLAYERS;
  if (engaged.length < seedCap)
    engaged = new Uint8Array(Math.max(seedCap, engaged.length * 2, 256));
  if (strAt.length < astCount * MAXO) strAt = new Float32Array(astCount * MAXO);
  if (totAt.length < astCount) totAt = new Float32Array(astCount);
}

// Pack two 16-bit-ish cell coords into one key. Offset keeps negatives non-negative.
const BIAS = 1 << 15;
const key = (cx, cy) => ((cx + BIAS) << 16) | (cy + BIAS);

// Rebuild the grid in place from current seedling positions. Reuses cell arrays by
// length-resetting them (arr.length = 0) instead of dropping the Map entries.
function rebuildGrid(world) {
  const s = world.seed;
  const n = s.count;
  ensureCap(n);
  for (const arr of grid.cells.values()) arr.length = 0;
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(s.x[i] / CELL);
    const cy = Math.floor(s.y[i] / CELL);
    grid.cx[i] = cx;
    grid.cy[i] = cy;
    const k = key(cx, cy);
    grid.cellOf[i] = k;
    let bucket = grid.cells.get(k);
    if (!bucket) {
      bucket = [];
      grid.cells.set(k, bucket);
    }
    bucket.push(i);
  }
}

// resolveCombat — one deterministic combat tick. Insert in step() between
// updateSeedlings and tick++.
export function resolveCombat(world, dt) {
  const s = world.seed;
  if (s.count === 0) return;
  rebuildGrid(world);

  const A = world.asteroids.length;
  ensureHomeBufs(s.capacity, A);
  engaged.fill(0, 0, s.count);

  // Proximity damage: enemies within CONTACT_RADIUS (fly-bys + converging ships). Damage is
  // read from `strength` (not the depleted `energy`), so the pass is order-independent.
  for (let i = 0; i < s.count; i++) {
    const oi = s.owner[i];
    const cx = grid.cx[i];
    const cy = grid.cy[i];
    const xi = s.x[i];
    const yi = s.y[i];
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const bucket = grid.cells.get(key(gx, gy));
        if (!bucket) continue;
        for (let b = 0; b < bucket.length; b++) {
          const j = bucket[b];
          if (j === i || s.owner[j] === oi) continue; // no friendly fire
          const dx = s.x[j] - xi;
          const dy = s.y[j] - yi;
          if (dx * dx + dy * dy > R2) continue;
          engaged[i] = 1;
          s.energy[i] -= s.strength[j] * COMBAT_RATE * dt;
        }
      }
    }
  }

  // Same-body engagement: ANY two enemy ships sharing a rock fight every tick, regardless of
  // orbit distance — no peaceful stand-off on a shared rock. A SLING ship (mid slingshot
  // around a body it's passing) counts as "on" that body (its target), so it trades fire with
  // anything stationed there for the duration of the arc. Pure TRANSIT fly-bys use proximity.
  const bodyOf = (i) => (s.state[i] === STATE.SLING ? s.target[i] : s.home[i]);
  strAt.fill(0, 0, A * MAXO);
  totAt.fill(0, 0, A);
  for (let i = 0; i < s.count; i++) {
    if (s.state[i] === STATE.TRANSIT) continue;
    const h = bodyOf(i);
    const o = s.owner[i];
    if (h < 0 || h >= A || o < 0 || o >= MAXO) continue;
    strAt[h * MAXO + o] += s.strength[i];
    totAt[h] += s.strength[i];
  }
  for (let i = 0; i < s.count; i++) {
    if (s.state[i] === STATE.TRANSIT) continue;
    const h = bodyOf(i);
    const o = s.owner[i];
    if (h < 0 || h >= A || o < 0 || o >= MAXO) continue;
    const enemyStr = totAt[h] - strAt[h * MAXO + o];
    if (enemyStr > 0) {
      engaged[i] = 1;
      s.energy[i] -= enemyStr * COMBAT_RATE * dt;
    }
  }

  // Deaths + COMBAT/ORBIT tint, after ALL damage (kept order-independent / deterministic).
  // Don't kill mid-scan — compaction below swap-removes the DEAD in a safe descending pass.
  for (let i = 0; i < s.count; i++) {
    if (s.energy[i] <= 0) s.state[i] = STATE.DEAD;
    else if (s.state[i] !== STATE.TRANSIT && s.state[i] !== STATE.SLING)
      s.state[i] = engaged[i] ? STATE.COMBAT : STATE.ORBIT;
  }

  // Compaction: single descending loop so swap-remove (last -> i) never moves an
  // un-scanned DEAD slot into an already-passed position. count stays correct & dense.
  for (let i = s.count - 1; i >= 0; i--) {
    if (s.state[i] === STATE.DEAD) killSeedling(world, i);
  }

  // Compaction swap-removed DEAD ships, so the grid built above now holds stale indices.
  // Rebuild it (O(n)) before flipOwnership queries it by cell — cheaper overall than the
  // old O(asteroids × seedlings) full scan once ship/rock counts grow.
  if (s.count > 0) rebuildGrid(world);
  flipOwnership(world);
}

// flipOwnership — "last side holding it owns it". For each owned asteroid, look at living
// seedlings inside its hold-zone (radius + HOLD_GAP). If the current owner has zero there
// and exactly one rival side is present, the rock flips to that rival. Contested (owner
// still present, or 2+ rivals) → no flip. Neutral first-arrival colonization is T2's job.
//
// INVARIANT: only asteroid.owner is mutated; the array is never reordered/removed.
// Queries only the spatial-grid cells overlapping each rock's hold-zone (radius + HOLD_GAP)
// instead of scanning the whole seedling SoA — O(asteroids × local-density), not O(n²).
// Requires a FRESH grid (rebuilt post-compaction by the caller). Semantics are unchanged:
// position-based reach test, TRANSIT/SLING skipped, owner-present blocks the flip, and a
// flip happens only when exactly one rival side remains.
function flipOwnership(world) {
  const s = world.seed;
  const asts = world.asteroids;
  for (let a = 0; a < asts.length; a++) {
    const rock = asts[a];
    if (rock.owner === OWNER_NEUTRAL) continue; // neutral handled by colonization (T2)
    const reach = rock.radius + HOLD_GAP;
    const reach2 = reach * reach;
    const cx0 = Math.floor((rock.x - reach) / CELL);
    const cx1 = Math.floor((rock.x + reach) / CELL);
    const cy0 = Math.floor((rock.y - reach) / CELL);
    const cy1 = Math.floor((rock.y + reach) / CELL);
    let ownerPresent = false;
    let rival = -2; // -2 = none yet, -3 = multiple rivals
    for (let gx = cx0; gx <= cx1 && !ownerPresent; gx++) {
      for (let gy = cy0; gy <= cy1 && !ownerPresent; gy++) {
        const bucket = grid.cells.get(key(gx, gy));
        if (!bucket) continue;
        for (let b = 0; b < bucket.length; b++) {
          const i = bucket[b];
          // Only ships that STOP at a rock hold/capture it — passing TRANSIT and slingshotting
          // SLING ships fight but never flip ownership just by flying through the hold-zone.
          if (s.state[i] === STATE.TRANSIT || s.state[i] === STATE.SLING)
            continue;
          const dx = s.x[i] - rock.x;
          const dy = s.y[i] - rock.y;
          if (dx * dx + dy * dy > reach2) continue;
          const o = s.owner[i];
          if (o === rock.owner) {
            ownerPresent = true; // contested by defender — stop, no flip
            break;
          }
          if (rival === -2) rival = o;
          else if (rival !== o) rival = -3;
        }
      }
    }
    if (ownerPresent) continue;
    if (rival >= 0) {
      rock.owner = rival; // exactly one rival side, defenders gone → flip
      pushEvent(world, EVENT.CAPTURE, rock.x, rock.y, rival);
      rock.rally = -1; // a captured rock drops the old owner's rally anchor
    }
  }
}

export default { resolveCombat, CONTACT_RADIUS, COMBAT_RATE, HOLD_GAP };
