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
//   • players[i]: id, isAi, difficulty, seeds, tech, and every _-prefixed sim/AI cadence counter
//     (captured generically — see PLAYER_FIELDS below).
//   • asteroids[i]: plain data objects (id===index, no functions / typed-arrays) — deep-copied
//     whole. trees + bombard are plain objects; neighbors is the post-belt graph (preserved so
//     routing resumes identically). Never reordered.
//   • seed (SoA): count, capacity, and each SEED_FIELDS typed array's USED portion (0..count),
//     restored into fresh typed arrays of the SAME type (integer fields stay integer).
import { makeRng, makeSeedArrays, SEED_FIELDS, WORLD_STATUS } from "./World.js";
import { rebuildNav } from "./MapGen.js";

export const SAVE_VERSION = 1;

// Player fields to round-trip: the stable identity/economy fields plus the FULL set of
// _-prefixed deterministic cadence counters accumulated across F-base/F3/F4/F6a. `tech` is a
// plain {strength,speed,regen} record. Any counter that's still undefined mid-game is simply
// omitted (the sim re-inits it lazily) — but the ones that exist are captured so a resumed
// match keeps identical decision timing.
const PLAYER_FIELDS = [
  "id",
  "isAi",
  "difficulty",
  "seeds",
  "_aiCd",
  "_aiSends",
  "_techRR",
  "_techTick",
  "_domTicks",
  "_bombFires",
  "_bombPlants",
  "_bombFireTick",
  "_bombPlanTick",
];

// Deep-clone a plain JSON value (objects/arrays/primitives only). Asteroids carry no functions
// or typed-arrays, so a structural clone is exact and JSON-safe. Used so the saved object never
// aliases live world state (mutating one must not touch the other).
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
    for (const k of PLAYER_FIELDS) if (p[k] !== undefined) out[k] = p[k];
    out.tech = p.tech ? { ...p.tech } : { strength: 0, speed: 0, regen: 0 };
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
  if (!saved || saved.version !== SAVE_VERSION) return null;

  const cap = saved.seed.capacity;
  const seed = makeSeedArrays(cap);
  seed.count = saved.seed.count;
  for (const f of SEED_FIELDS) {
    const src = saved.seed.fields[f];
    // Copy the used portion back into the correctly-typed array (the typed-array setter coerces
    // each value to that field's exact integer/float type — Int8/Int32/Uint8/Float32).
    seed[f].set(src, 0);
  }

  // rng: a fresh closure, then restore the saved state integer so the stream continues identically.
  const rng = makeRng(0);
  rng.setState(saved.rngState >>> 0);

  const players = saved.players.map((sp) => {
    const p = {};
    for (const k of PLAYER_FIELDS) if (sp[k] !== undefined) p[k] = sp[k];
    p.tech = sp.tech ? { ...sp.tech } : { strength: 0, speed: 0, regen: 0 };
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
    winConfig: cloneJson(saved.winConfig),
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
