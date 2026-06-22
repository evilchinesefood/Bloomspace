// Sim/Economy.js — asteroid energy regen + spend helpers. NO three.js (headless).
// Deterministic: no randomness. Owned rocks regenerate energy proportional to energyStat;
// neutral rocks (owner -1) never regenerate. Trees spend energy via spendEnergy().
import { OWNER_NEUTRAL } from "./World.js";
import { ownerRegenMult } from "./Tech.js";
import { RICH_ENERGY_MULT } from "./MapGen.js";

export const ENERGY_RATE = 4; // energy/sec at energyStat 100
export const ENERGY_MAX = 200; // per-asteroid storage cap

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
    const cap = ENERGY_MAX * mult;
    if (e > cap) e = cap;
    if (e < 0) e = 0;
    rock.energy = e;
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

export default { updateEconomy, spendEnergy, ENERGY_RATE, ENERGY_MAX };
