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
  initStats,
} from "./World.js";
import { rebuildNav } from "./MapGen.js";
import { CMD } from "./Commands.js";

// All valid CMD type strings — used for validate-on-restore of pendingCommands.
const CMD_TYPES = new Set(Object.values(CMD));

export const SAVE_VERSION = 2;

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
    // Asteroids are plain data (id===index) — deep-clone the whole array verbatim. symAura is the
    // ONE transient field on a rock (derived from its neighbors' symbiosis trees, recomputed by
    // updateAura every tick BEFORE combat) — strip it so the save is byte-identical to a pre-
    // symbiosis save and the first step after restore recomputes it. The symbiosis tree itself is
    // a normal tree object inside `trees`, so it round-trips with no Save schema change.
    asteroids: world.asteroids.map((a) => {
      const c = cloneJson(a);
      delete c.symAura;
      return c;
    }),
    players,
    links: cloneJson(world.links ?? []),
    nebulae: cloneJson(world.nebulae ?? []),
    belts: cloneJson(world.belts ?? []),
    winConfig: cloneJson(world.winConfig),
    // Environmental hazards: the on/off flag + in-flight state (timers, live flare rings, fused
    // meteors) — plain numbers/arrays so a mid-shower save resumes identically. Absent ⇒ off.
    hazardsOn: !!world.hazardsOn,
    hazards: world.hazards ? cloneJson(world.hazards) : null,
    // Fog of war: the on/off flag + per-player visibility (seen + last-known owner memory). The
    // typed arrays serialize as plain number arrays (like the seed SoA) and rebuild into typed
    // arrays on restore. Known memory MUST persist so a resumed match remembers what it had seen.
    // Absent ⇒ fog off (old saves restore with no fog state).
    fogOn: !!world.fogOn,
    fog: world.fog
      ? {
          seen: world.fog.seen.map((a) => Array.from(a)),
          known: world.fog.known.map((a) => Array.from(a)),
        }
      : null,
    // Post-game stats accumulator + territory history. Plain arrays — omitted in old saves,
    // initialized empty on restore (initStats).
    stats: world.stats ? cloneJson(world.stats) : null,
    history: world.history ? cloneJson(world.history) : null,
    // Pause flag (step 10 toggles; here just serialized). Absent in v1 saves → false on restore.
    paused: !!world.paused,
    // Staged command queue — plain intent objects (type/owner/from/to/fraction/rock/treeType).
    // Empty in normal play; human staged-while-paused orders populate it (step 10).
    pendingCommands: cloneJson(world.pendingCommands ?? []),
    // Energy conduits — explicit world-level list of {from,to,owner}. ADDITIVE (rides SAVE_VERSION
    // 2 + `?? []`): a v2 save lacking conduits restores []. Validated on restore (drop malformed).
    conduits: cloneJson(world.conduits ?? []),
    // Wormhole pairs — explicit world-level list of {a,b} (the render + restore-validation record).
    // ADDITIVE (rides SAVE_VERSION 2 + `?? []`): a v2 save lacking wormholes restores []. The actual
    // routing edge lives in each end's asteroid.neighbors (serialized whole) + rebuildNav reconstructs
    // nav, so routing resumes identically with no extra edge save logic. Validated on restore.
    wormholes: cloneJson(world.wormholes ?? []),
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
    !saved.seed.fields ||
    !Array.isArray(saved.asteroids) ||
    !Array.isArray(saved.players)
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
    // Environmental hazards. An old save without the field restores OFF with no hazard state, so
    // stepHazards never runs (step() gates on hazardsOn) — byte-identical to a pre-hazards world.
    hazardsOn: !!saved.hazardsOn,
    hazards: saved.hazards ? cloneJson(saved.hazards) : null,
    // Fog of war flag — an old save without it restores OFF (no world.fog, computeFog never runs;
    // step() gates on fogOn), byte-identical to a pre-fog world.
    fogOn: !!saved.fogOn,
  };
  // Fog state: only attach world.fog when the save carried it (fog ON). Rebuild the per-player
  // typed arrays from the plain number arrays (Uint8 seen / Int8 known) so the last-known memory
  // resumes exactly. An old/off save leaves world.fog absent (undefined).
  if (saved.fogOn && saved.fog) {
    world.fog = {
      seen: saved.fog.seen.map((a) => Uint8Array.from(a)),
      known: saved.fog.known.map((a) => Int8Array.from(a)),
    };
  }
  // Stats + history: restore if present, else initialize empty (old saves).
  if (saved.stats && saved.history) {
    world.stats = cloneJson(saved.stats);
    // An old save predating the kills counter restores without it — backfill so the stats screen
    // (and any kills read) sees a valid per-player array instead of undefined.
    if (!world.stats.kills)
      world.stats.kills = new Array(world.players.length).fill(0);
    world.history = cloneJson(saved.history);
  } else {
    initStats(world);
  }

  // Pause flag — absent in v1/old saves restores as false (no behavioral change).
  world.paused = !!saved.paused;

  // pendingCommands — validate-on-restore: keep only plain-object entries with a known CMD type,
  // an owner in [0, players.length), and any referenced body id (from/to/rock) an integer in
  // [0, asteroids.length). Drop malformed entries; never throw. Default to [].
  const nAst = world.asteroids.length;
  const nPly = world.players.length;
  const isBodyId = (v) =>
    v === undefined || (Number.isInteger(v) && v >= 0 && v < nAst);
  const rawCmds = Array.isArray(saved.pendingCommands)
    ? saved.pendingCommands
    : [];
  world.pendingCommands = cloneJson(
    rawCmds.filter(
      (c) =>
        c !== null &&
        typeof c === "object" &&
        CMD_TYPES.has(c.type) &&
        Number.isInteger(c.owner) &&
        c.owner >= 0 &&
        c.owner < nPly &&
        isBodyId(c.from) &&
        isBodyId(c.to) &&
        isBodyId(c.rock),
    ),
  );

  // conduits — validate-on-restore (mirrors pendingCommands): keep only plain objects with integer
  // from/to in [0, asteroids.length), from !== to, and owner in [0, players.length). Drop malformed
  // entries; never throw. Default []. A v2 save without conduits restores [] (the ?? above).
  const rawConduits = Array.isArray(saved.conduits) ? saved.conduits : [];
  world.conduits = cloneJson(
    rawConduits.filter(
      (c) =>
        c !== null &&
        typeof c === "object" &&
        Number.isInteger(c.from) &&
        c.from >= 0 &&
        c.from < nAst &&
        Number.isInteger(c.to) &&
        c.to >= 0 &&
        c.to < nAst &&
        c.from !== c.to &&
        Number.isInteger(c.owner) &&
        c.owner >= 0 &&
        c.owner < nPly,
    ),
  );

  // wormholes — validate-on-restore: keep only plain {a,b} pairs where a,b are integers in
  // [0, asteroids.length), a !== b, AND the pairing is symmetric in the restored bodies
  // (asteroids[a].wormholeId === b && asteroids[b].wormholeId === a). Drop corrupt/asymmetric pairs
  // (no throw); default []. A v2 save without wormholes restores [] (the ?? above). The routing edge
  // itself lives in each end's .neighbors (already restored), so rebuildNav below reconstructs nav.
  const wormholeAsts = world.asteroids;
  const rawWormholes = Array.isArray(saved.wormholes) ? saved.wormholes : [];
  world.wormholes = cloneJson(
    rawWormholes.filter(
      (w) =>
        w !== null &&
        typeof w === "object" &&
        Number.isInteger(w.a) &&
        w.a >= 0 &&
        w.a < nAst &&
        Number.isInteger(w.b) &&
        w.b >= 0 &&
        w.b < nAst &&
        w.a !== w.b &&
        wormholeAsts[w.a].wormholeId === w.b &&
        wormholeAsts[w.b].wormholeId === w.a,
    ),
  );

  // world.nav is DERIVED from each body's restored .neighbors (the post-belt graph) — recompute
  // it so routing resumes identically without serializing the table.
  rebuildNav(world);
  return world;
}

export default { SAVE_VERSION, serialize, deserialize };
