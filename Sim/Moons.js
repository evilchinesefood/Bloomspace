// Sim/Moons.js — orbital bodies revolve each tick. NO three.js (headless). Deterministic:
// orbit params (orbitParent/orbitCx/orbitCy/orbitDist/orbitAng/orbitSpeed) are seeded in
// MapGen; this just advances the angle and recomputes world position. Covers moons (orbit a
// planet), satellites (orbit a host asteroid), and binary members (orbit a fixed midpoint).
// Seedlings/trees/combat read body x/y each tick, so everything sitting on a moving body
// moves with it for free. All orbit centers are STATIC bodies or fixed points, so a single
// pass is order-independent.
export function updateOrbits(world, dt) {
  const asts = world.asteroids;
  for (let i = 0; i < asts.length; i++) {
    const b = asts[i];
    if (b.dead || !b.orbiting) continue; // a destroyed body freezes in place
    const c = b.orbitParent >= 0 ? asts[b.orbitParent] : b;
    const cx = b.orbitParent >= 0 ? c.x : b.orbitCx;
    const cy = b.orbitParent >= 0 ? c.y : b.orbitCy;
    b.orbitAng += b.orbitSpeed * dt;
    b.x = cx + Math.cos(b.orbitAng) * b.orbitDist;
    b.y = cy + Math.sin(b.orbitAng) * b.orbitDist;
  }
}

// Backwards-compatible alias (older imports).
export const updateMoons = updateOrbits;

export default { updateOrbits, updateMoons };
