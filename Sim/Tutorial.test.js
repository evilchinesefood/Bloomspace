// Sim/Tutorial.test.js — seed-stability + reachability guard for the tutorial game mode. The
// tutorial leans on determinism: a FIXED config (Ui/Tutorial.TUTORIAL_CONFIG) must always produce
// the SAME small layout whose scripted steps are achievable (home with orbiting seedlings, a
// NEUTRAL reachable from home to colonize, exactly one passive Easy AI). If the engine ever
// shifts the seed-1 layout, this goes red BEFORE the tutorial silently becomes unwinnable.
//
// Importing Ui/Tutorial.js headlessly is safe: it only uses DOM inside createTutorial() (never at
// module load), so TUTORIAL_CONFIG + the pure STEPS predicates import cleanly under Node.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, OWNER_NEUTRAL } from "./World.js";
import { TUTORIAL_CONFIG, STEPS } from "../Ui/Tutorial.js";

// Build the tutorial world from the locked config (fresh player copies so per-player mutation —
// seeds/tech — never leaks across builds).
function buildTutorial() {
  return createWorld({
    ...TUTORIAL_CONFIG,
    players: TUTORIAL_CONFIG.players.map((p) => ({ ...p })),
  });
}

test("TUTORIAL_CONFIG is the locked small + passive-enemy shape", () => {
  assert.equal(TUTORIAL_CONFIG.seed, 1, "tutorial seed is LOCKED to 1");
  assert.equal(
    TUTORIAL_CONFIG.specials,
    false,
    "specials OFF for the tutorial",
  );
  assert.ok(
    TUTORIAL_CONFIG.asteroidCount >= 10 && TUTORIAL_CONFIG.asteroidCount <= 14,
    "small body count (~10-14)",
  );
  assert.equal(TUTORIAL_CONFIG.players.length, 2, "one human + one AI");
  const human = TUTORIAL_CONFIG.players.find((p) => !p.isAi);
  const ai = TUTORIAL_CONFIG.players.find((p) => p.isAi);
  assert.ok(human && human.id === 0, "human is player 0");
  assert.ok(
    ai && ai.difficulty === 0,
    "enemy is a difficulty-0 (passive Easy) AI",
  );
});

test("tutorial world is deterministic (identical layout twice from the fixed config)", () => {
  const a = buildTutorial();
  const b = buildTutorial();
  assert.equal(a.asteroids.length, b.asteroids.length);
  for (let i = 0; i < a.asteroids.length; i++) {
    const x = a.asteroids[i];
    const y = b.asteroids[i];
    assert.equal(x.x, y.x, `body ${i} x drift`);
    assert.equal(x.y, y.y, `body ${i} y drift`);
    assert.equal(x.radius, y.radius, `body ${i} radius drift`);
    assert.equal(x.owner, y.owner, `body ${i} owner drift`);
    assert.equal(x.kind, y.kind, `body ${i} kind drift`);
  }
  assert.equal(a.seed.count, b.seed.count, "seedling count drift");
});

test("id === index holds (load-bearing SoA invariant) and specials are empty", () => {
  const w = buildTutorial();
  assert.ok(
    w.asteroids.every((a, i) => a.id === i),
    "asteroid id must equal its array index",
  );
  assert.equal((w.nebulae || []).length, 0, "no nebulae (specials off)");
  assert.equal((w.belts || []).length, 0, "no belts (specials off)");
});

test("exactly one human home + one passive-AI home, human home has orbiting seedlings", () => {
  const w = buildTutorial();
  const humanHomes = w.asteroids.filter((a) => a.owner === 0);
  const aiHomes = w.asteroids.filter((a) => a.owner === 1);
  assert.equal(humanHomes.length, 1, "exactly one human home rock");
  assert.equal(aiHomes.length, 1, "exactly one (passive Easy AI) home rock");
  // The enemy is precisely one difficulty-0 AI player.
  const aiPlayers = w.players.filter((p) => p.isAi);
  assert.equal(aiPlayers.length, 1);
  assert.equal(aiPlayers[0].difficulty, 0);
  // Human home has its orbiting starter seedlings (the pool step 2's drag-send draws from).
  const s = w.seed;
  let homeOrbiters = 0;
  for (let i = 0; i < s.count; i++)
    if (s.home[i] === humanHomes[0].id && s.owner[i] === 0) homeOrbiters++;
  assert.ok(homeOrbiters >= 8, `human home has ${homeOrbiters} orbiters`);
});

test("a neutral habitable asteroid is reachable from the human home (step 2 is possible)", () => {
  const w = buildTutorial();
  const home = w.asteroids.find((a) => a.owner === 0);
  // Reachable per the nav table (first-hop >= 0 means a path exists). Require a DIRECT neutral
  // neighbor too, so the very first colonize is a single forgiving drag (no multi-hop needed).
  const directNeutral = (home.neighbors || []).some((j) => {
    const a = w.asteroids[j];
    return a && a.owner === OWNER_NEUTRAL && a.habitable && !a.dead && !a.moon;
  });
  assert.ok(
    directNeutral,
    "home must have a directly-adjacent neutral to colonize",
  );
  let reachableNeutrals = 0;
  for (let t = 0; t < w.asteroids.length; t++) {
    const a = w.asteroids[t];
    if (a.owner !== OWNER_NEUTRAL || !a.habitable || a.dead) continue;
    if (w.nav[home.id][t] >= 0) reachableNeutrals++;
  }
  assert.ok(reachableNeutrals >= 1, "at least one neutral reachable from home");
});

test("the passive Easy AI home is NOT adjacent to the human home (no early interference)", () => {
  const w = buildTutorial();
  const home0 = w.asteroids.find((a) => a.owner === 0);
  const home1 = w.asteroids.find((a) => a.owner === 1);
  assert.ok(
    !(home0.neighbors || []).includes(home1.id),
    "enemy home should not be a direct neighbor of the human home",
  );
  const d = Math.hypot(home0.x - home1.x, home0.y - home1.y);
  assert.ok(d > 300, `homes only ${Math.round(d)} apart — too close`);
});

// Cheap headless check of the pure step predicates against constructed world states. We do NOT
// test the DOM coachmark here (browser-verified) — only that each predicate fires on the right
// sim shape and stays false otherwise. Predicates are read-only; mutating a plain clone is fine.
test("step predicates fire on the right sim state and not before", () => {
  const w = buildTutorial();
  const home = w.asteroids.find((a) => a.owner === 0);
  const [sel, capture, plant, rally, win] = STEPS;

  // Step 1: select your rock — needs a selected OWNED rock.
  assert.equal(sel.done(w, -1), false, "no selection → step 1 not done");
  assert.equal(sel.done(w, home.id), true, "owned rock selected → step 1 done");
  const neutral = w.asteroids.find(
    (a) => a.owner === OWNER_NEUTRAL && a.habitable,
  );
  assert.equal(
    sel.done(w, neutral.id),
    false,
    "selecting a NEUTRAL rock must not satisfy step 1",
  );

  // Step 2: colonize a neutral — owned-rock count >= 2.
  assert.equal(capture.done(w), false, "only home owned → step 2 not done");
  neutral.owner = 0; // simulate a capture
  assert.equal(capture.done(w), true, "two rocks owned → step 2 done");

  // Step 3: plant a Seedling Tree — some owned rock has a seedling tree.
  assert.equal(plant.done(w), false, "no seedling tree yet → step 3 not done");
  home.trees.push({ type: "seedling", level: 1, growth: 0 });
  assert.equal(plant.done(w), true, "seedling tree present → step 3 done");
  // A non-seedling tree alone must NOT satisfy step 3.
  const fresh = buildTutorial();
  fresh.asteroids.find((a) => a.owner === 0).trees.push({ type: "defense" });
  assert.equal(
    plant.done(fresh),
    false,
    "defense tree must not satisfy step 3",
  );

  // Step 4: set a rally point — some owned rock has rally >= 0.
  assert.equal(rally.done(w), false, "no rally set → step 4 not done");
  home.rally = neutral.id;
  assert.equal(rally.done(w), true, "rally set → step 4 done");

  // Step 5: defeat the enemy — status "won".
  assert.equal(win.done(w), false, "status playing → step 5 not done");
  w.status = "won";
  assert.equal(win.done(w), true, "status won → step 5 done");
});
