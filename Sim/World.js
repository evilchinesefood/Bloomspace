// Sim/World.js — game state + data contract. NO three.js import (must run headless).
// Declares the SoA shape from the plan; orchestrates the per-tick sim.
import { generateMap } from "./MapGen.js";
import { updateOrbits } from "./Moons.js";
import { updateSeedlings, updateRally } from "./Seedlings.js";
import { resolveCombat } from "./Combat.js";
import { updateEconomy } from "./Economy.js";
import { updateTrees } from "./Trees.js";
import { updateAi, checkVictory } from "./Ai.js";
import { updateBombard } from "./Bombard.js";
import { initPlayerTech } from "./Tech.js";

export const STARTING_SEEDS = 10;

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
// each frame for FX + audio. FIRE is reserved for the later bombardment superweapon (no emitter
// yet). Keep this contract stable — audio and bombardment both build on it.
export const EVENT = {
  DEATH: 0,
  SEND: 1,
  CAPTURE: 2,
  FIRE: 3,
  WIN: 4,
  LOSE: 5,
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

// Mulberry32 — small seeded deterministic PRNG -> [0,1).
function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSeedArrays(capacity) {
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

export function createWorld(config = {}) {
  const width = config.width ?? 1000;
  const height = config.height ?? 1000;
  const capacity = config.capacity ?? 4096;
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
  // Plain JSON (numbers + one string) so a later save/resume feature can serialize it.
  const wc = config.winConfig ?? {};
  world.winConfig = {
    mode: wc.mode ?? "elimination", // "elimination" | "domination"
    dominationPct: wc.dominationPct ?? 0.6, // fraction of habitable bodies to hold
    dominationSecs: wc.dominationSecs ?? 25, // continuous seconds at/above pct to win
    timeLimitSecs: wc.timeLimitSecs ?? 0, // 0 = no time cap
  };
  // Normalize every player to have a harvestable seeds resource + a zeroed tech record.
  for (const p of world.players) {
    if (p.seeds === undefined) p.seeds = STARTING_SEEDS;
    initPlayerTech(p);
  }
  // Procedurally place asteroids + seed each player's home orbit (deterministic).
  generateMap(world, config, spawnSeedling);
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
const SEED_FIELDS = [
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
  // Snapshot positions for render interpolation.
  s.px.set(s.x.subarray(0, s.count));
  s.py.set(s.y.subarray(0, s.count));
  updateOrbits(world, dt); // move orbiting bodies first so riders read fresh positions
  updateAi(world, dt); // AI issues commands that take effect through the pipeline below
  updateRally(world, dt); // rallied rocks funnel their orbiting fighters to the anchor
  updateSeedlings(world, dt);
  destroyInBlackHoles(world); // any ship inside a black hole's orbit is annihilated
  resolveCombat(world, dt);
  updateEconomy(world, dt);
  updateTrees(world, dt);
  updateBombard(world, dt); // advance battery charges / destroy bodies, before victory check
  checkVictory(world);
  world.tick++;
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
      const dx = s.x[i] - h.x;
      const dy = s.y[i] - h.y;
      const rr = h.radius + BLACKHOLE_KILL_PAD;
      if (dx * dx + dy * dy <= rr * rr) {
        killSeedling(world, i);
        break;
      }
    }
  }
}

export const Sim = { createWorld, spawnSeedling, killSeedling, step };
export default Sim;
