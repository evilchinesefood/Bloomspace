// Sim/Fog.js — fog of war. NO three.js (headless). Pure + deterministic: consumes no seeded-PRNG
// draws and no wall-clock / nondeterministic sources, so a fog world's rng stream is undisturbed.
// (The purity test scans this source for the forbidden globals, so they are not spelled out here.)
//
// Model: LAST-KNOWN, FULL-STRATEGIC (per-player visibility computed in the sim). Vision sources =
// a player's owned non-dead rocks + owned seedlings, each revealing every rock within VISION_R
// (center-to-center). A currently-seen rock records its TRUE owner into that player's `known`
// memory; an unseen-but-once-seen rock keeps its last-known owner (stale until re-seen). The
// passive-blind AI reads ownership through knownOwner (Sim/Ai.js), so it acts on stale/partial info.
//
// State lives on world.fog (only when world.fogOn): per-player typed arrays indexed by rock id
// (id === asteroid index, fixed for the match — dead rocks stay in place flagged `dead`):
//   seen[p]  : Uint8Array(nRocks)  — 1 if player p currently sees rock r this recompute, else 0.
//   known[p] : Int8Array(nRocks)   — last-known owner of r as seen by p, or UNKNOWN if never seen.
//
// UNKNOWN = -2: a sentinel outside the real owner range (OWNER_NEUTRAL -1 .. MAX_PLAYERS-1). Int8
// holds it fine. known[] is seeded to UNKNOWN; computeFog overwrites a seen rock's slot with the
// real owner id (or OWNER_NEUTRAL), so any value !== UNKNOWN means "this player has knowledge".
//
// VISION_R = 450 world units. Rationale: MapGen.MIN_GAP is 150 (min edge-to-edge spacing) and maps
// are ~1100–2400 wide; 450 center-to-center reaches roughly one to two inter-rock hops around an
// owned body — meaningful fog (most of a map stays dark early) without trivially revealing a small
// map. Vision is binary (in/out of radius); no soft falloff.
//
// FOG_TICKS = 5: computeFog is gated by World.step to run every 5th tick (tick % FOG_TICKS === 0),
// deterministic + cheap; AI/render read the cached fog between recomputes. initFog computes once
// immediately so fog is valid from tick 0. Rocks are few (≤~60) so the O(rocks² + ships·rocks)
// scan is negligible.
//
// No imports: this module is loaded BY World.js, so importing back from World.js would be a circular
// dependency (a top-level TDZ error). It needs only the live `world` object passed to each function.

export const VISION_R = 450;
export const VISION_R2 = VISION_R * VISION_R;
export const FOG_TICKS = 5;
export const UNKNOWN = -2;

// initFog — allocate per-player seen/known arrays sized to the (fixed) rock count and run a first
// computeFog so the world has valid visibility from tick 0. nPlayers spans 0..MAX_PLAYERS so a slot
// always exists for every live owner id; known seeded to UNKNOWN (nothing seen yet).
export function initFog(world) {
  const nRocks = world.asteroids.length;
  const nP = world.players.length;
  const seen = [];
  const known = [];
  for (let p = 0; p < nP; p++) {
    seen.push(new Uint8Array(nRocks));
    const k = new Int8Array(nRocks);
    k.fill(UNKNOWN);
    known.push(k);
  }
  world.fog = { seen, known };
  computeFog(world);
}

// computeFog — recompute `seen` for every player from current vision sources, then refresh `known`
// for every currently-seen rock to its TRUE owner. Deterministic, rng-free.
//   Pass 1: clear seen. Mark each player's OWN non-dead rocks seen, and reveal every rock within
//           VISION_R of one of them (center-to-center).
//   Pass 2: one walk of the live seedlings — each reveals rocks within VISION_R of the ship, for
//           the ship's owner only.
//   Pass 3: for each player, every currently-seen rock writes its real owner into known.
export function computeFog(world) {
  const fog = world.fog;
  if (!fog) return;
  const asts = world.asteroids;
  const nRocks = asts.length;
  const nP = fog.seen.length;

  for (let p = 0; p < nP; p++) fog.seen[p].fill(0);

  // Pass 1: owned-rock vision (incl. always-see-your-own).
  for (let p = 0; p < nP; p++) {
    const seen = fog.seen[p];
    for (let i = 0; i < nRocks; i++) {
      const src = asts[i];
      if (src.dead || src.owner !== p) continue;
      seen[i] = 1; // you always see your own
      for (let r = 0; r < nRocks; r++) {
        if (seen[r] || asts[r].dead) continue;
        const dx = asts[r].x - src.x;
        const dy = asts[r].y - src.y;
        if (dx * dx + dy * dy <= VISION_R2) seen[r] = 1;
      }
    }
  }

  // Pass 2: owned-fleet vision (one pass over the dense seedling SoA).
  const s = world.seed;
  for (let i = 0; i < s.count; i++) {
    const o = s.owner[i];
    if (o < 0 || o >= nP) continue; // neutral/unowned ships reveal nothing
    const seen = fog.seen[o];
    const sx = s.x[i];
    const sy = s.y[i];
    for (let r = 0; r < nRocks; r++) {
      if (seen[r] || asts[r].dead) continue;
      const dx = asts[r].x - sx;
      const dy = asts[r].y - sy;
      if (dx * dx + dy * dy <= VISION_R2) seen[r] = 1;
    }
  }

  // Pass 3: refresh last-known owner for every currently-seen rock.
  for (let p = 0; p < nP; p++) {
    const seen = fog.seen[p];
    const known = fog.known[p];
    for (let r = 0; r < nRocks; r++) if (seen[r]) known[r] = asts[r].owner;
  }
}

// knownOwner — what player p believes rock r's owner is:
//   currently seen → the TRUE current owner;
//   else once-seen → the last-known (possibly stale) owner;
//   else           → UNKNOWN (never observed).
export function knownOwner(world, p, rockId) {
  const fog = world.fog;
  if (!fog) return world.asteroids[rockId].owner; // fog off ⇒ full info (defensive)
  if (fog.seen[p][rockId]) return world.asteroids[rockId].owner;
  return fog.known[p][rockId];
}

export default {
  initFog,
  computeFog,
  knownOwner,
  VISION_R,
  FOG_TICKS,
  UNKNOWN,
};
