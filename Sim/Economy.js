// Sim/Economy.js — asteroid energy regen + spend helpers. NO three.js (headless).
// Deterministic: no randomness. Owned rocks regenerate energy proportional to energyStat;
// neutral rocks (owner -1) never regenerate. Trees spend energy via spendEnergy().
import { OWNER_NEUTRAL } from "./World.js";
import { ownerRegenMult } from "./Tech.js";
import { RICH_ENERGY_MULT } from "./MapGen.js";

export const ENERGY_RATE = 4; // energy/sec at energyStat 100
export const ENERGY_MAX = 200; // per-asteroid storage cap
export const CONDUIT_RATE = 12; // energy/sec a conduit pumps from→to (capped per tick)

// rockCap — the per-rock energy storage cap, matching updateEconomy's `ENERGY_MAX * mult` (a rich
// rock + a planet's energyMult both raise the ceiling). Shared so a conduit never overfills a rock
// past what regen itself could store.
function rockCap(rock) {
  const rich = rock.special === "rich" ? RICH_ENERGY_MULT : 1;
  return ENERGY_MAX * (rock.energyMult || 1) * rich;
}

// updateEconomy — regenerate stored energy on every owned asteroid, capped at ENERGY_MAX.
export function updateEconomy(world, dt) {
  const asts = world.asteroids;
  for (let a = 0; a < asts.length; a++) {
    const rock = asts[a];
    if (rock.dead || rock.owner === OWNER_NEUTRAL) continue;
    // Planets regenerate (and store) energy faster via energyMult. A resource-rich rock
    // (special "rich") adds RICH_ENERGY_MULT as a SEPARATE factor on both rate AND cap — kept
    // off energyMult so a rich planet earns both. The owner's regen-tech multiplier (1.0 = no
    // tech) additionally scales the REGEN RATE only — not the cap.
    const rich = rock.special === "rich" ? RICH_ENERGY_MULT : 1;
    const mult = (rock.energyMult || 1) * rich;
    const tech = ownerRegenMult(world, rock.owner);
    // Symbiosis aura speeds regen on aura'd rocks (factor 1 with no adjacent symbiosis → no-op).
    const aura = rock.symAura || 1;
    let e =
      rock.energy +
      ENERGY_RATE * (rock.energyStat / 100) * mult * tech * aura * dt;
    const cap = rockCap(rock);
    if (e > cap) e = cap;
    if (e < 0) e = 0;
    rock.energy = e;
  }
}

// updateConduits — move energy along each player-built conduit AFTER regen. RNG-FREE, iterates in
// index order. A conduit {from,to,owner} pumps min(CONDUIT_RATE*dt, from.energy, to-headroom) from
// `from` to `to` only when BOTH endpoints still exist, are non-dead, and are STILL owned by
// conduit.owner (an endpoint that flipped owner is inert this tick; Combat.flipOwnership also
// severs it). Default-empty → no-op → byte-identical. The transfer is conservative (no energy is
// created/destroyed) and never drives `from` below 0 or `to` above its cap.
export function updateConduits(world, dt) {
  const conduits = world.conduits;
  if (!conduits || conduits.length === 0) return;
  const asts = world.asteroids;
  for (let c = 0; c < conduits.length; c++) {
    const cd = conduits[c];
    const from = asts[cd.from];
    const to = asts[cd.to];
    if (!from || !to || from.dead || to.dead) continue;
    if (from.owner !== cd.owner || to.owner !== cd.owner) continue;
    const headroom = rockCap(to) - to.energy;
    if (headroom <= 0) continue;
    let move = CONDUIT_RATE * dt;
    if (move > from.energy) move = from.energy;
    if (move > headroom) move = headroom;
    if (move <= 0) continue;
    from.energy -= move;
    to.energy += move;
  }
}

// spendEnergy — deduct `amount` if affordable; returns true on success, false (no-op)
// when the rock can't cover it. Never lets energy go negative.
export function spendEnergy(asteroid, amount) {
  if (amount < 0) return false;
  if (asteroid.energy < amount) return false;
  asteroid.energy -= amount;
  return true;
}

export default {
  updateEconomy,
  updateConduits,
  spendEnergy,
  ENERGY_RATE,
  ENERGY_MAX,
  CONDUIT_RATE,
};
