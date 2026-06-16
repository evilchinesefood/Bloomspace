// Sim/World.js — game state + data contract. NO three.js import (must run headless).
// Declares the SoA shape from the plan; orchestrates the per-tick sim.
import { generateMap } from "./MapGen.js";
import { updateOrbits } from "./Moons.js";
import { updateSeedlings, updateRally } from "./Seedlings.js";
import { resolveCombat } from "./Combat.js";
import { updateEconomy } from "./Economy.js";
import { updateTrees } from "./Trees.js";
import { updateAi, checkVictory } from "./Ai.js";

export const STARTING_SEEDS = 10;

// Owners:        -1 neutral, 0 human, 1..N AI
// Seedling state: 0 ORBIT, 1 TRANSIT, 2 COMBAT, 3 DEAD
export const OWNER_NEUTRAL = -1;
export const STATE = { ORBIT: 0, TRANSIT: 1, COMBAT: 2, DEAD: 3 };

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
    status: "playing",
    rng: makeRng(config.seed ?? 1),
    players: config.players ?? [{ id: 0, isAi: false, difficulty: 0 }],
    asteroids: [],
    seed: makeSeedArrays(capacity),
  };
  // Normalize every player to have a harvestable seeds resource (additive).
  for (const p of world.players) {
    if (p.seeds === undefined) p.seeds = STARTING_SEEDS;
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
  s.kind[i] = opts.kind ?? 0;
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

// killSeedling — swap-remove to keep arrays dense.
export function killSeedling(world, i) {
  const s = world.seed;
  const last = --s.count;
  if (i !== last) {
    for (const k of [
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
    ]) {
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
  checkVictory(world);
  world.tick++;
}

// Black holes destroy any seedling that enters their orbit. Iterate backwards because
// killSeedling swap-removes from the dense arrays.
const BLACKHOLE_KILL_PAD = 54;
function destroyInBlackHoles(world) {
  const holes = world.asteroids.filter((a) => a.kind === "blackhole");
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
