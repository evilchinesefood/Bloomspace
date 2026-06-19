// Sim/World.js — game state + data contract. NO three.js import (must run headless).
// Declares the SoA shape from the plan; orchestrates the per-tick sim.
import { generateMap } from "./MapGen.js";
import { updateOrbits } from "./Moons.js";
import { updateSeedlings, updateRally } from "./Seedlings.js";
import { resolveCombat } from "./Combat.js";
import { updateEconomy } from "./Economy.js";
import { updateTrees } from "./Trees.js";
import { updateAi, checkVictory, PERSONALITY_NAMES } from "./Ai.js";
import { updateBombard } from "./Bombard.js";
import { initPlayerTech } from "./Tech.js";
import { initHazards, stepHazards } from "./Hazards.js";
import { initFog, computeFog, FOG_TICKS } from "./Fog.js";

export const STARTING_SEEDS = 10;

// Stats accumulator — samples per this many ticks (~1 s at 30 fps).
const SAMPLE_TICKS = 30;
// Hard cap on history length; when full, downsamples to stay bounded.
export const MAX_SAMPLES = 240;

// initStats — attach fresh stats + history to a world. Called in createWorld and
// also used by deserialize when restoring an old save that lacks them.
export function initStats(world) {
  const n = world.players.length;
  world.stats = {
    captures: new Array(n).fill(0),
    deaths: new Array(n).fill(0),
    peakFleet: new Array(n).fill(0),
    kills: new Array(n).fill(0), // enemy ships destroyed (credited in Combat to the real killer)
  };
  world.history = [];
}

// stepStats — called at end of every step(). Reads events + periodically samples
// territory/fleet. Writes ONLY to world.stats/history — zero gameplay mutation.
// Scans ONLY the events emitted during THIS step ([from, e.n)). The render channel is
// drained (n reset) once per FRAME, not per step, so when several steps run in one frame
// (Main.js's fixed-step loop) the buffer accumulates across them — scanning [0, e.n) would
// re-count earlier steps' captures/deaths on every later step (frame-rate-dependent inflation).
// `from` is events.n captured at the top of step() before any system emitted.
export function stepStats(world, from = 0) {
  const { stats, history, players } = world;
  if (!stats) return;
  const e = world.events;
  for (let k = from; k < e.n; k++) {
    const t = e.type[k],
      o = e.owner[k];
    if (t === EVENT.CAPTURE && o >= 0 && o < players.length)
      stats.captures[o]++;
    if (t === EVENT.DEATH && o >= 0 && o < players.length) stats.deaths[o]++;
  }
  if (world.tick % SAMPLE_TICKS !== 0) return;
  const n = players.length;
  // Territory: non-dead owned rocks per player.
  const terr = new Array(n).fill(0);
  for (const a of world.asteroids) {
    if (!a.dead && a.owner >= 0 && a.owner < n) terr[a.owner]++;
  }
  // Fleet: live seedlings per player.
  const s = world.seed;
  const fleet = new Array(n).fill(0);
  for (let i = 0; i < s.count; i++) {
    const o = s.owner[i];
    if (o >= 0 && o < n) fleet[o]++;
  }
  for (let i = 0; i < n; i++)
    if (fleet[i] > stats.peakFleet[i]) stats.peakFleet[i] = fleet[i];
  // Bounded history: when at cap, drop every odd entry (halves length, doubles interval).
  if (history.length >= MAX_SAMPLES) {
    const keep = [];
    for (let i = 0; i < history.length; i += 2) keep.push(history[i]);
    history.length = 0;
    history.push(...keep);
  }
  history.push({ tick: world.tick, terr: terr.slice() });
}

// Owners:        -1 neutral, 0 human, 1..N AI
// Seedling state: 0 ORBIT, 1 TRANSIT, 2 COMBAT, 3 DEAD, 4 SLING (partial slingshot orbit
// around a body it's passing — fights any ships stationed there during the arc).
export const OWNER_NEUTRAL = -1;
export const STATE = { ORBIT: 0, TRANSIT: 1, COMBAT: 2, DEAD: 3, SLING: 4 };
// Seedling kinds (the SoA `kind` field). Named so the 0/1 literals don't sprawl across layers.
export const KIND = { FIGHTER: 0, DEFENDER: 1 };
// Terminal/active match status (world.status). Single source for the string union. DRAW is the
// stalemate outcome a time-cap can reach (neither side leads in territory) — it has NO event.
export const WORLD_STATUS = {
  PLAYING: "playing",
  WON: "won",
  LOST: "lost",
  DRAW: "draw",
};
// Max distinct players (owner ids 0..MAX_PLAYERS-1): 1 human + up to 6 AI, bounded by the
// Palette AI color count. Combat's same-body buffers and the AI palette derive from this.
export const MAX_PLAYERS = 7;

// Event channel tags. Sim records events deterministically during step(); Render drains them
// each frame for FX + audio. FIRE is emitted by Bombard.fireBombard and consumed by Game (SFX).
// Keep this contract stable — audio and bombardment both build on it.
export const EVENT = {
  DEATH: 0,
  SEND: 1,
  CAPTURE: 2,
  FIRE: 3,
  WIN: 4,
  LOSE: 5,
  LOST: 6, // player 0 lost a rock to an enemy (distinct alert cue)
  DESTROY: 7, // a celestial body was destroyed by bombardment
  FLARE: 8, // solar flare ring fired from the star (global, owner -1)
  METEOR: 9, // a meteor impact (global, owner -1)
};

// pushEvent — append one event to world.events (allocation-free). Silently drops when full,
// mirroring the deaths overflow guard. type is an EVENT.* tag; x,y the primary world position;
// owner an aux id (-1 default); x2,y2 an aux position (FIRE target).
export function pushEvent(
  world,
  type,
  x = 0,
  y = 0,
  owner = -1,
  x2 = 0,
  y2 = 0,
) {
  const e = world.events;
  if (!e || e.n >= e.capacity) return;
  const k = e.n;
  e.type[k] = type;
  e.x[k] = x;
  e.y[k] = y;
  e.x2[k] = x2;
  e.y2[k] = y2;
  e.owner[k] = owner;
  e.n++;
}

// Mulberry32 — small seeded deterministic PRNG -> [0,1). The closure holds a single 32-bit
// state integer `s`. getState/setState expose/restore exactly that integer (for save/resume)
// WITHOUT touching the PRNG math, so the numeric sequence is byte-for-byte unchanged; a resumed
// match restored via setState draws the identical continuation.
export function makeRng(seed) {
  let s = seed >>> 0;
  const rng = function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.getState = () => s >>> 0;
  rng.setState = (v) => {
    s = v >>> 0;
  };
  return rng;
}

export function makeSeedArrays(capacity) {
  return {
    count: 0,
    capacity,
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    px: new Float32Array(capacity),
    py: new Float32Array(capacity),
    vx: new Float32Array(capacity),
    vy: new Float32Array(capacity),
    home: new Int32Array(capacity),
    target: new Int32Array(capacity), // next-hop asteroid (-1 if orbiting home)
    dest: new Int32Array(capacity), // final destination asteroid for multi-hop routing
    owner: new Int8Array(capacity),
    energy: new Float32Array(capacity),
    strength: new Float32Array(capacity),
    orbitAngle: new Float32Array(capacity),
    orbitRadius: new Float32Array(capacity),
    state: new Uint8Array(capacity),
    kind: new Uint8Array(capacity), // 0 fighter, 1 defender (defense-tree spawned)
    slingRem: new Float32Array(capacity), // signed radians left in a slingshot arc (state SLING)
  };
}

// winConfig defaults, applied per-key with ?? so a missing key (fresh config OR a restored save
// from a future schema) falls back to the documented default instead of undefined. Plain JSON
// (numbers + one string) so save/resume can serialize it.
export function normalizeWinConfig(wc = {}) {
  return {
    mode: wc.mode ?? "elimination", // "elimination" | "domination"
    dominationPct: wc.dominationPct ?? 0.6, // fraction of habitable bodies to hold
    dominationSecs: wc.dominationSecs ?? 25, // continuous seconds at/above pct to win
    timeLimitSecs: wc.timeLimitSecs ?? 0, // 0 = no time cap
  };
}

export function createWorld(config = {}) {
  const width = config.width ?? 1000;
  const height = config.height ?? 1000;
  // SoA capacity scales with asteroid count so big/Brutal matches don't silently stall at the cap
  // (spawnSeedling returning -1). Serialized, so raising this never breaks existing saves.
  const capacity =
    config.capacity ?? Math.max(4096, (config.asteroidCount ?? 0) * 200);
  const world = {
    width,
    height,
    tick: 0,
    status: WORLD_STATUS.PLAYING,
    rng: makeRng(config.seed ?? 1),
    players: config.players ?? [{ id: 0, isAi: false, difficulty: 0 }],
    asteroids: [],
    seed: makeSeedArrays(capacity),
    // Per-step event channel (deaths/sends/captures/fires/win-lose). Preallocated parallel SoA —
    // appended via pushEvent during step(), drained (n reset) by Render each frame for FX + audio.
    // No allocation in steady state; overflow is silently dropped (capacity = seed capacity).
    events: {
      type: new Uint8Array(capacity),
      x: new Float32Array(capacity),
      y: new Float32Array(capacity),
      x2: new Float32Array(capacity),
      y2: new Float32Array(capacity),
      owner: new Int16Array(capacity),
      n: 0,
      capacity,
    },
  };
  // Win/loss rules. Defaults reproduce CURRENT behavior EXACTLY (pure elimination, no time
  // limit), so omitting config.winConfig drifts zero bits. domination/time-cap are opt-in.
  world.winConfig = normalizeWinConfig(config.winConfig);
  // Normalize every player to have a harvestable seeds resource + a zeroed tech record.
  for (const p of world.players) {
    if (p.seeds === undefined) p.seeds = STARTING_SEEDS;
    initPlayerTech(p);
  }
  // Invariant (mirrors asteroid.id===index): a player's id MUST equal its index in the array.
  // Fog (Sim/Fog.js) and stepStats index per-player arrays directly by owner id for speed, so
  // sparse/reordered ids would silently corrupt fog visibility + post-game stats. Fail fast here
  // instead. Menus always builds contiguous 0..N players; this guards a future mode/setup.
  for (let i = 0; i < world.players.length; i++)
    if (world.players[i].id !== i)
      throw new Error("player id must equal its index (fog/stats index by id)");
  // Terrain specials: regions live on world.nebulae (7a) + world.belts (7b); per-body tags on
  // rock.special. Default [] so consumers can read them unconditionally. generateMap (gated on
  // config.specials) fills them; plain {x,y,radius} numbers + string tags, JSON-serializable for
  // save/resume. Belts also remove the travel edges that cross them (graph reshaped, not bodies).
  world.nebulae = [];
  world.belts = [];
  // Procedurally place asteroids + seed each player's home orbit (deterministic).
  generateMap(world, config, spawnSeedling);
  // Assign personality to each AI player AFTER map generation. No world.rng() is consumed here
  // so mapgen's rng stream is byte-identical to pre-personality worlds (existing tests don't drift).
  // When aiPersonality is absent or "random", default to "neutral" so existing worlds are bit-for-
  // bit identical in behaviour; only an explicit non-neutral choice changes the sim rng stream.
  // "random" from the menu picks a per-AI personality via a seed-derived hash (rng-free).
  const baseSeed = config.seed ?? 1;
  for (const p of world.players) {
    if (!p.isAi) continue;
    const choice = config.aiPersonality;
    if (!choice || choice === "neutral") {
      p.personality = "neutral";
    } else if (choice !== "random" && PERSONALITY_NAMES.includes(choice)) {
      p.personality = choice; // explicit named personality — all AIs get it
    } else {
      // "random": each AI independently gets a personality via a hash of (seed, playerId).
      // Hash is rng-free so mapgen stream is undisturbed; reproducible from the seed.
      const h =
        ((baseSeed ^ (p.id * 2654435761)) >>> 0) % PERSONALITY_NAMES.length;
      p.personality = PERSONALITY_NAMES[h];
    }
  }
  // Environmental hazards: opt-in via config.events. Default OFF so absent config drifts zero
  // bits (initHazards consumes world.rng()). When on, seed the hazard timers from the star map;
  // initHazards runs LAST so the rng draws don't perturb mapgen/personality (which are rng-free
  // here) for an existing world. The flag rides the world for save/resume + the step() gate.
  world.hazardsOn = !!config.events;
  if (world.hazardsOn) initHazards(world);
  // Fog of war: opt-in via config.fog. Default OFF so absent config drifts zero bits — initFog is
  // rng-free, but with fog OFF NO fog state is allocated and step() never calls computeFog, so the
  // world is byte-identical to a pre-fog one (existing tests/saves unaffected). When ON, per-player
  // visibility rides world.fog (save/resume); the AI reads ownership through knownOwner.
  world.fogOn = !!config.fog;
  if (world.fogOn) initFog(world);
  initStats(world);
  return world;
}

// spawnSeedling -> index, or -1 if at capacity.
export function spawnSeedling(world, opts = {}) {
  const s = world.seed;
  if (s.count >= s.capacity) return -1;
  const i = s.count++;
  const a = world.asteroids[opts.home ?? 0];
  s.home[i] = opts.home ?? 0;
  s.target[i] = -1;
  s.dest[i] = -1;
  s.owner[i] = opts.owner ?? OWNER_NEUTRAL;
  s.orbitRadius[i] = opts.orbitRadius ?? 80;
  s.orbitAngle[i] = opts.orbitAngle ?? 0;
  s.strength[i] = opts.strength ?? 50;
  s.energy[i] = opts.energy ?? 10;
  s.state[i] = STATE.ORBIT;
  s.kind[i] = opts.kind ?? KIND.FIGHTER;
  s.slingRem[i] = 0;
  const cx = a ? a.x : 0;
  const cy = a ? a.y : 0;
  s.x[i] = cx + Math.cos(s.orbitAngle[i]) * s.orbitRadius[i];
  s.y[i] = cy + Math.sin(s.orbitAngle[i]) * s.orbitRadius[i];
  s.px[i] = s.x[i];
  s.py[i] = s.y[i];
  s.vx[i] = 0;
  s.vy[i] = 0;
  return i;
}

// SoA field names, allocated once — killSeedling runs per-death per-tick, so we must not
// build this array on every call (GC churn). Keep in sync with makeSeedArrays above.
export const SEED_FIELDS = [
  "x",
  "y",
  "px",
  "py",
  "vx",
  "vy",
  "home",
  "target",
  "dest",
  "owner",
  "energy",
  "strength",
  "orbitAngle",
  "orbitRadius",
  "state",
  "kind",
  "slingRem",
];

// killSeedling — swap-remove to keep arrays dense. Records an EVENT.DEATH at the dying ship's
// position first (every death routes through here — combat + black holes) so Render can draw
// death FX / play audio at exact spots instead of guessing from per-frame count deltas.
export function killSeedling(world, i) {
  const s = world.seed;
  pushEvent(world, EVENT.DEATH, s.x[i], s.y[i], s.owner[i]);
  const last = --s.count;
  if (i !== last) {
    for (let f = 0; f < SEED_FIELDS.length; f++) {
      const k = SEED_FIELDS[f];
      s[k][i] = s[k][last];
    }
  }
}

// step — advance exactly one fixed tick. Orchestrator: snapshot positions for render
// interpolation, run the sim systems, advance the tick. Later tasks add Combat/Economy/
// Trees/Ai calls between updateSeedlings and tick++.
export function step(world, dt) {
  const s = world.seed;
  // Event-buffer mark BEFORE any system emits this step. The channel is drained per FRAME (by
  // render), not per step, so stepStats must only count events appended during THIS step — pass
  // the mark so it scans [eventsFrom, e.n) and doesn't re-count earlier steps in a multi-step frame.
  const eventsFrom = world.events.n;
  // Snapshot positions for render interpolation (allocation-free — subarray would alloc a view).
  for (let i = 0; i < s.count; i++) {
    s.px[i] = s.x[i];
    s.py[i] = s.y[i];
  }
  updateOrbits(world, dt); // move orbiting bodies first so riders read fresh positions
  updateAi(world, dt); // AI issues commands that take effect through the pipeline below
  updateRally(world, dt); // rallied rocks funnel their orbiting fighters to the anchor
  updateSeedlings(world, dt);
  destroyInBlackHoles(world); // any ship inside a black hole's orbit is annihilated
  resolveCombat(world, dt);
  updateEconomy(world, dt);
  updateTrees(world, dt);
  updateBombard(world, dt); // advance battery charges / destroy bodies, before victory check
  if (world.hazardsOn) stepHazards(world, dt); // env hazards damage fleets before victory check
  // Fog of war: recompute per-player visibility AFTER all movement/combat (positions are final),
  // throttled to every FOG_TICKS ticks (deterministic, tick-based) — AI/render read the cache in
  // between. Gated on fogOn so the OFF path runs zero fog code. initFog already computed tick 0.
  if (world.fogOn && world.tick % FOG_TICKS === 0) computeFog(world);
  checkVictory(world);
  world.tick++;
  stepStats(world, eventsFrom);
}

// Black holes destroy any seedling that enters their orbit. Iterate backwards because
// killSeedling swap-removes from the dense arrays.
const BLACKHOLE_KILL_PAD = 54;
function destroyInBlackHoles(world) {
  // Black holes only change when one is destroyed (which nulls this memo) — compute the live
  // list once and reuse it. A destroyed hole is excluded so it stops reaping ships.
  const holes = (world._blackholes ??= world.asteroids.filter(
    (a) => a.kind === "blackhole" && !a.dead,
  ));
  if (holes.length === 0) return;
  const s = world.seed;
  for (let i = s.count - 1; i >= 0; i--) {
    for (const h of holes) {
      const rr = h.radius + BLACKHOLE_KILL_PAD;
      // Cheap bounding-box reject so the squared-distance multiply only runs near a hole.
      if (
        s.x[i] < h.x - rr ||
        s.x[i] > h.x + rr ||
        s.y[i] < h.y - rr ||
        s.y[i] > h.y + rr
      )
        continue;
      const dx = s.x[i] - h.x;
      const dy = s.y[i] - h.y;
      if (dx * dx + dy * dy <= rr * rr) {
        killSeedling(world, i);
        break;
      }
    }
  }
}

export const Sim = { createWorld, spawnSeedling, killSeedling, step };
export default Sim;
