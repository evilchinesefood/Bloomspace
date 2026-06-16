// Sim/Moons.js — moons revolve around their parent planet each tick. NO three.js (headless).
// Deterministic: orbit params (orbitDist/Ang/Speed/parent) are seeded in MapGen; this just
// advances the angle and recomputes the moon's world position. Seedlings/trees/combat read
// asteroid x/y each tick, so everything on a moon moves with it for free.
export function updateMoons(world, dt) {
  const asts = world.asteroids;
  for (let i = 0; i < asts.length; i++) {
    const m = asts[i];
    if (!m.moon) continue;
    const p = asts[m.parent];
    if (!p) continue;
    m.orbitAng += m.orbitSpeed * dt;
    m.x = p.x + Math.cos(m.orbitAng) * m.orbitDist;
    m.y = p.y + Math.sin(m.orbitAng) * m.orbitDist;
  }
}

export default { updateMoons };
