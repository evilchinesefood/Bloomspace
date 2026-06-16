// Sim/Combat.js — proximity combat + asteroid ownership flips. NO three.js (headless).
// Pure-data, deterministic: positions/energy already live in world.seed SoA; all logic
// here is index math over those typed arrays. No randomness is used at all.
//
// INVARIANT (load-bearing): world.asteroids is NEVER removed or reordered here — we only
// mutate `asteroid.owner`. Seedling home/target are indices into world.asteroids, so any
// reorder would silently corrupt every seedling's home/target. Only `owner` is touched.
import { STATE, killSeedling } from "./World.js";

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

  // Damage pass: fixed ascending order; damage is independent per pair so within-tick
  // order can't change the outcome. We accumulate into energy directly (each seedling is
  // damaged by every enemy in contact; symmetric pairs both take their hit).
  // Track who is currently in contact for STATE tinting.
  for (let i = 0; i < s.count; i++) {
    const oi = s.owner[i];
    const cx = grid.cx[i];
    const cy = grid.cy[i];
    const xi = s.x[i];
    const yi = s.y[i];
    let inContact = false;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const bucket = grid.cells.get(key(gx, gy));
        if (!bucket) continue;
        for (let b = 0; b < bucket.length; b++) {
          const j = bucket[b];
          if (j === i) continue;
          if (s.owner[j] === oi) continue; // no friendly fire
          const dx = s.x[j] - xi;
          const dy = s.y[j] - yi;
          if (dx * dx + dy * dy > R2) continue;
          inContact = true;
          // i takes damage from j's strength. (j is handled when its own loop runs.)
          s.energy[i] -= s.strength[j] * COMBAT_RATE * dt;
        }
      }
    }
    // Mark slain now; do NOT kill mid-scan (would corrupt indices for later i).
    // A unit that dies this tick still dealt its damage above (outgoing damage reads
    // `strength`, never the depleted `energy`) — deliberate simultaneous resolution. Do
    // NOT "fix" this into an order-dependent two-phase pass; it would break determinism.
    if (s.energy[i] <= 0) {
      s.state[i] = STATE.DEAD;
    } else if (s.state[i] !== STATE.TRANSIT) {
      // Tint: ORBIT seedlings in contact show COMBAT; revert to ORBIT when clear.
      // Never override TRANSIT (movement reads state) or DEAD.
      s.state[i] = inContact ? STATE.COMBAT : STATE.ORBIT;
    }
  }

  // Compaction: single descending loop so swap-remove (last -> i) never moves an
  // un-scanned DEAD slot into an already-passed position. count stays correct & dense.
  for (let i = s.count - 1; i >= 0; i--) {
    if (s.state[i] === STATE.DEAD) killSeedling(world, i);
  }

  flipOwnership(world);
}

// flipOwnership — "last side holding it owns it". For each owned asteroid, look at living
// seedlings inside its hold-zone (radius + HOLD_GAP). If the current owner has zero there
// and exactly one rival side is present, the rock flips to that rival. Contested (owner
// still present, or 2+ rivals) → no flip. Neutral first-arrival colonization is T2's job.
//
// INVARIANT: only asteroid.owner is mutated; the array is never reordered/removed.
// PERF (T8): this scans all seedlings per owned asteroid — O(asteroids × seedlings). Fine
// at the v1 scale (~dozens of rocks, few-thousand cap → sub-ms/tick). If rock counts reach
// the hundreds or the seedling cap grows well past 4k, query the spatial grid cells within
// `reach` of each rock instead of scanning the whole SoA.
function flipOwnership(world) {
  const s = world.seed;
  const asts = world.asteroids;
  for (let a = 0; a < asts.length; a++) {
    const rock = asts[a];
    if (rock.owner === -1) continue; // neutral handled by colonization (T2)
    const reach = rock.radius + HOLD_GAP;
    const reach2 = reach * reach;
    let ownerPresent = false;
    let rival = -2; // -2 = none yet, -3 = multiple rivals
    for (let i = 0; i < s.count; i++) {
      const dx = s.x[i] - rock.x;
      const dy = s.y[i] - rock.y;
      if (dx * dx + dy * dy > reach2) continue;
      const o = s.owner[i];
      if (o === rock.owner) {
        ownerPresent = true;
        break; // contested by defender — stop early, no flip
      }
      if (rival === -2) rival = o;
      else if (rival !== o) rival = -3;
    }
    if (ownerPresent) continue;
    if (rival >= 0) rock.owner = rival; // exactly one rival side, defenders gone → flip
  }
}

export default { resolveCombat, CONTACT_RADIUS, COMBAT_RATE, HOLD_GAP };
