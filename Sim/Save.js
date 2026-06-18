// Sim/Save.js — Feature 8a: pure save/resume SIM CORE. NO three.js, NO localStorage, NO DOM
// (the UI layer — autosave, Resume button, restored-world wiring — is F8b). This module only
// turns a live `world` into a plain JSON-able object and back into a world that continues
// DETERMINISTICALLY: serialize → deserialize → N×step() matches a never-saved run stepped N×.
//
// What round-trips (accumulated across F1–F7):
//   • world: width, height, tick, status, rng STATE int, players, asteroids, seed (SoA), links,
//     nebulae, belts, winConfig.
//   • Derived/transient (NOT serialized, rebuilt on restore): world.nav (rebuildNav), world.
//     _blackholes (memo → null so it recomputes), world.events (render channel → reinit EMPTY).
//   • players[i]: cloned WHOLE (plain object) — id/isAi/difficulty/seeds/tech + every _-prefixed
//     cadence counter — so a future counter is captured automatically (see PLAYER_SKIP denylist).
//   • asteroids[i]: plain data objects (id===index, no functions / typed-arrays) — deep-copied
//     whole. trees + bombard are plain objects; neighbors is the post-belt graph (preserved so
//     routing resumes identically). Never reordered.
//   • seed (SoA): count, capacity, and each SEED_FIELDS typed array's USED portion (0..count),
//     restored into fresh typed arrays of the SAME type (integer fields stay integer).
import {
  makeRng,
  makeSeedArrays,
  normalizeWinConfig,
  SEED_FIELDS,
  WORLD_STATUS,
} from "./World.js";
import { rebuildNav } from "./MapGen.js";

export const SAVE_VERSION = 1;

// Players are plain objects (id/isAi/difficulty/seeds/tech + a set of _-prefixed deterministic
// cadence counters accumulated across F-base/F3/F4/F6a). We clone the WHOLE object — same as
// asteroids — so a NEW counter added by a future feature is captured AUTOMATICALLY rather than
// silently dropped (which would desync a resumed match with no test failure). A counter that was
// never set is simply an absent key (the sim re-inits it lazily via `| 0`). Anything transient or
// derived that should NOT round-trip goes in PLAYER_SKIP (empty today).
const PLAYER_SKIP = new Set();

// Deep-clone a plain JSON value (objects/arrays/primitives only). Intentionally mirrors JSON
// semantics (NOT structuredClone) — the saved object must survive a real localStorage string
// round-trip, so modelling that here surfaces any non-JSON value early instead of at F8b's
// JSON.stringify. Asteroids/players carry no functions or typed-arrays, so this is exact + safe,
// and it keeps the save from aliasing live world state.
function cloneJson(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(cloneJson);
  const out = {};
  for (const k in v) out[k] = cloneJson(v[k]);
  return out;
}

// serialize — live world → plain JSON-able object (stamped with version). No functions, no
// typed-arrays, no derived/transient channels leak in, so it survives a real localStorage
// string round-trip (JSON.stringify → JSON.parse → deserialize).
export function serialize(world) {
  const s = world.seed;
  const seed = { count: s.count, capacity: s.capacity, fields: {} };
  for (const f of SEED_FIELDS) {
    // USED portion only (0..count) as a plain Array — the rest is unused capacity.
    seed.fields[f] = Array.from(s[f].subarray(0, s.count));
  }

  const players = world.players.map((p) => {
    const out = {};
    for (const k in p) if (!PLAYER_SKIP.has(k)) out[k] = cloneJson(p[k]);
    return out;
  });

  return {
    version: SAVE_VERSION,
    width: world.width,
    height: world.height,
    tick: world.tick,
    status: world.status,
    rngState: world.rng.getState(),
    seed,
    // Asteroids are plain data (id===index) — deep-clone the whole array verbatim.
    asteroids: world.asteroids.map(cloneJson),
    players,
    links: cloneJson(world.links ?? []),
    nebulae: cloneJson(world.nebulae ?? []),
    belts: cloneJson(world.belts ?? []),
    winConfig: cloneJson(world.winConfig),
  };
}

// Fresh, EMPTY render event channel sized to the SoA capacity — mirrors createWorld's
// allocation exactly so a resumed world has a working, drained event channel (n=0).
function makeEvents(capacity) {
  return {
    type: new Uint8Array(capacity),
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    x2: new Float32Array(capacity),
    y2: new Float32Array(capacity),
    owner: new Int16Array(capacity),
    n: 0,
    capacity,
  };
}

// deserialize — plain saved object → fully-rebuilt world that continues deterministically.
// Rejects a mismatched/missing schema version (returns null) so a future format change can't be
// silently mis-loaded. Allocates fresh typed arrays (preserving per-field types), restores the
// rng state integer, rebuilds nav, and reinitializes the transient render channel EMPTY.
export function deserialize(saved) {
  // Reject a version mismatch/miss OR an obviously-corrupt save (the version check alone doesn't
  // cover a truncated/missing seed) — bad input → null, consistent for every caller (F8b reads
  // possibly-corrupt localStorage). An oversized field array still throws (F8b wraps in try/catch).
  if (
    !saved ||
    saved.version !== SAVE_VERSION ||
    !saved.seed ||
    !saved.seed.fields
  )
    return null;

  const cap = saved.seed.capacity;
  // A truncated field (src shorter than count) would leave tail seedlings at defaults — a silently
  // corrupt world. Reject it: every field must hold exactly `count` values, else null.
  for (const f of SEED_FIELDS) {
    const src = saved.seed.fields[f];
    if (!src || src.length !== saved.seed.count) return null;
  }
  const seed = makeSeedArrays(cap);
  seed.count = saved.seed.count;
  for (const f of SEED_FIELDS) {
    // Copy the used portion back into the correctly-typed array (the typed-array setter coerces
    // each value to that field's exact integer/float type — Int8/Int32/Uint8/Float32).
    seed[f].set(saved.seed.fields[f], 0);
  }

  // rng: a fresh closure, then restore the saved state integer so the stream continues identically.
  const rng = makeRng(0);
  rng.setState(saved.rngState >>> 0);

  const players = saved.players.map((sp) => {
    const p = {};
    for (const k in sp) p[k] = cloneJson(sp[k]);
    if (!p.tech) p.tech = { strength: 0, speed: 0, regen: 0 }; // defend an old/partial save
    return p;
  });

  const world = {
    width: saved.width,
    height: saved.height,
    tick: saved.tick,
    status: saved.status ?? WORLD_STATUS.PLAYING,
    rng,
    players,
    asteroids: saved.asteroids.map(cloneJson),
    seed,
    links: cloneJson(saved.links ?? []),
    nebulae: cloneJson(saved.nebulae ?? []),
    belts: cloneJson(saved.belts ?? []),
    // Normalize like createWorld so a save missing a winConfig key (future schema add) restores
    // to the documented default instead of undefined → NaN in checkDomination.
    winConfig: normalizeWinConfig(saved.winConfig),
    events: makeEvents(cap),
    // Black-hole reap memo — null so World.destroyInBlackHoles recomputes from the live bodies.
    _blackholes: null,
  };

  // world.nav is DERIVED from each body's restored .neighbors (the post-belt graph) — recompute
  // it so routing resumes identically without serializing the table.
  rebuildNav(world);
  return world;
}

export default { SAVE_VERSION, serialize, deserialize };
