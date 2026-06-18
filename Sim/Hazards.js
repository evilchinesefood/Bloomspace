// Sim/Hazards.js — environmental hazards (opt-in via world.hazardsOn). NO three.js, fully
// deterministic: every random draw routes through world.rng(), every timer counts in fixed dt.
// Two hazards, both global (owner -1), both emit on the world.events channel for FX + audio:
//   • Solar flare — an expanding ring radiating from the star (asteroids[0]). Over its short
//     life the ring radius grows; seedlings inside the live ring BAND take energy damage and die
//     when drained. One EVENT.FLARE at the star when it fires.
//   • Meteor shower — K seeded impact points; each meteor counts down a short fuse, then on
//     impact drains/kills seedlings within a blast radius. One EVENT.METEOR per impact.
// State lives on world.hazards (plain numbers/arrays) so Save.js round-trips it verbatim.
import { EVENT, pushEvent, killSeedling, OWNER_NEUTRAL } from "./World.js";

// Schedule (seconds) — periods in the tens of seconds with seeded jitter so hazards punctuate a
// match rather than spam it. Each timer counts DOWN; on zero it fires and re-arms.
const FLARE_PERIOD = 32;
const FLARE_JITTER = 16; // +[0,JITTER) seconds
const METEOR_PERIOD = 26;
const METEOR_JITTER = 14;

// Flare ring geometry/damage. The ring is a moving band of half-width BAND; a seedling whose
// distance from the star falls inside [r-BAND, r+BAND] this tick takes ENERGY_DMG energy.
const FLARE_LIFE = 1.6; // seconds the ring expands before it dissipates
const FLARE_MAX_R = 900; // outer radius the ring reaches at end of life
const FLARE_BAND = 70; // half-width of the damaging band
const FLARE_DMG = 9; // energy drained per tick while inside the band

// Meteor fuse + blast. K meteors per shower, each with a seeded impact point and a short fuse;
// the impact drains every seedling within BLAST of the point (kills those drained to <=0).
const METEOR_MIN = 3;
const METEOR_MAX = 6; // K in [MIN, MAX]
const METEOR_FUSE = 0.8; // seconds from spawn to impact
const METEOR_BLAST = 120;
const METEOR_DMG = 14;

// initHazards — fresh, empty hazard state with the two timers seeded to their first fire time.
// Consumes world.rng() (so it MUST only run when hazards are enabled). Idempotent shape.
export function initHazards(world) {
  const rng = world.rng;
  world.hazards = {
    flareTimer: FLARE_PERIOD + rng() * FLARE_JITTER,
    meteorTimer: METEOR_PERIOD + rng() * METEOR_JITTER,
    flares: [], // {x,y,r,maxR,life,ttl}
    meteors: [], // {x,y,fuse}
  };
}

// stepHazards — advance timers + live hazards one tick. Called from World.step ONLY when
// world.hazardsOn. Pure/deterministic; all randomness via world.rng().
export function stepHazards(world, dt) {
  const h = world.hazards;
  if (!h) return;
  advanceFlares(world, h, dt);
  advanceMeteors(world, h, dt);

  h.flareTimer -= dt;
  if (h.flareTimer <= 0) {
    spawnFlare(world, h);
    h.flareTimer += FLARE_PERIOD + world.rng() * FLARE_JITTER;
  }
  h.meteorTimer -= dt;
  if (h.meteorTimer <= 0) {
    spawnShower(world, h);
    h.meteorTimer += METEOR_PERIOD + world.rng() * METEOR_JITTER;
  }
}

// Fire a flare from the star: a ring at radius 0 that will grow to FLARE_MAX_R over FLARE_LIFE.
function spawnFlare(world, h) {
  const star = world.asteroids[0];
  const x = star ? star.x : world.width / 2;
  const y = star ? star.y : world.height / 2;
  h.flares.push({
    x,
    y,
    r: 0,
    maxR: FLARE_MAX_R,
    life: FLARE_LIFE,
    ttl: FLARE_LIFE,
  });
  pushEvent(world, EVENT.FLARE, x, y, OWNER_NEUTRAL);
}

// Grow each live flare ring, damage seedlings in its band, expire it when life runs out.
function advanceFlares(world, h, dt) {
  const s = world.seed;
  for (let f = h.flares.length - 1; f >= 0; f--) {
    const ring = h.flares[f];
    ring.life -= dt;
    ring.r = ring.maxR * (1 - ring.life / ring.ttl); // 0 → maxR across its life
    const lo = ring.r - FLARE_BAND;
    const hi = ring.r + FLARE_BAND;
    const lo2 = lo > 0 ? lo * lo : 0;
    const hi2 = hi * hi;
    // Descending so killSeedling's swap-remove doesn't skip a survivor.
    for (let i = s.count - 1; i >= 0; i--) {
      const dx = s.x[i] - ring.x;
      const dy = s.y[i] - ring.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < lo2 || d2 > hi2) continue;
      s.energy[i] -= FLARE_DMG;
      if (s.energy[i] <= 0) killSeedling(world, i);
    }
    if (ring.life <= 0) h.flares.splice(f, 1);
  }
}

// Seed a shower of K meteors at random impact points across the field, each with a short fuse.
function spawnShower(world, h) {
  const rng = world.rng;
  const k = METEOR_MIN + Math.floor(rng() * (METEOR_MAX - METEOR_MIN + 1));
  for (let m = 0; m < k; m++) {
    const x = rng() * world.width;
    const y = rng() * world.height;
    h.meteors.push({ x, y, fuse: METEOR_FUSE });
  }
}

// Count down each meteor's fuse; on impact, drain/kill seedlings in the blast and emit METEOR.
function advanceMeteors(world, h, dt) {
  const s = world.seed;
  const b2 = METEOR_BLAST * METEOR_BLAST;
  for (let m = h.meteors.length - 1; m >= 0; m--) {
    const met = h.meteors[m];
    met.fuse -= dt;
    if (met.fuse > 0) continue;
    for (let i = s.count - 1; i >= 0; i--) {
      const dx = s.x[i] - met.x;
      const dy = s.y[i] - met.y;
      if (dx * dx + dy * dy > b2) continue;
      s.energy[i] -= METEOR_DMG;
      if (s.energy[i] <= 0) killSeedling(world, i);
    }
    pushEvent(world, EVENT.METEOR, met.x, met.y, OWNER_NEUTRAL);
    h.meteors.splice(m, 1);
  }
}
