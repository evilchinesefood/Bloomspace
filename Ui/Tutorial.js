// Ui/Tutorial.js — the guided-tutorial game mode. CHROME ONLY: it owns NO game truth. It
// gates + prompts; the player performs every real action through the real Input/Hud (drag-send,
// Plant Seedling Tree, Set Rally Point). The tutorial only READS the live world + selection and
// shows a coachmark, advancing through an ordered step list as each step's sim-state predicate
// is satisfied. It never calls a sim mutator and never touches localStorage.
//
// Determinism: the match runs a FIXED config (TUTORIAL_CONFIG, asserted by Sim/Tutorial.test.js)
// so the small map reliably supports every step — home rock with orbiting seedlings, a neutral
// reachable from home to colonize, and one passive (difficulty-0 "Easy") AI that never attacks.
import { el } from "./Menus.js";
import { WORLD_STATUS } from "../Sim/World.js";

// The locked tutorial match config. Small fixed-seed map, specials OFF (so a first-timer isn't
// confused by nebula/belt/rich), one human + one passive Easy AI. Pinned: SEED 1 yields a clean
// layout (human home #9 has TWO neutral habitable neighbors to colonize; the Easy AI home #6 sits
// far across the map, reachable only via the central star hub, so it never pressures early).
// Exported so App.startTutorial and the seed-stability test share ONE source of truth.
export const TUTORIAL_CONFIG = {
  seed: 1,
  width: 1100,
  height: 1100,
  asteroidCount: 12,
  planetMin: 0,
  planetMax: 1,
  players: [
    { id: 0, isAi: false, difficulty: 0 },
    { id: 1, isAi: true, difficulty: 0 }, // passive scripted enemy = the Easy AI (never attacks)
  ],
  specials: false,
  winConfig: { mode: "elimination", timeLimitSecs: 0 },
};

// Player-0 owned-rock count (0 = human). Pure read over the live asteroid array.
function ownedCount(world) {
  let n = 0;
  for (const a of world.asteroids) if (a.owner === 0) n++;
  return n;
}

// Ordered steps. Each predicate is TOLERANT (no hard-coded rock ids) and ADVANCE-ONLY — the
// controller never regresses a completed step, so losing a rock later doesn't un-finish step 2.
//   1. select an owned rock
//   2. colonize a neutral (now hold >= 2 rocks)
//   3. plant a Seedling Tree on any owned rock
//   4. set a rally point on any owned rock
//   5. eliminate the (passive) enemy → status "won"
export const STEPS = [
  {
    title: "Select your rock",
    prompt:
      "Click your glowing home asteroid to select it. Your seedlings orbit it.",
    done: (world, selectedId) =>
      selectedId >= 0 && world.asteroids[selectedId]?.owner === 0,
  },
  {
    title: "Capture a neutral",
    prompt:
      "Drag from your rock onto a nearby grey asteroid to send seedlings and colonize it.",
    done: (world) => ownedCount(world) >= 2,
  },
  {
    title: "Plant a Seedling Tree",
    prompt:
      "Select one of your rocks and press “Plant Seedling Tree” to grow more seedlings over time.",
    done: (world) =>
      world.asteroids.some(
        (a) => a.owner === 0 && a.trees.some((t) => t.type === "seedling"),
      ),
  },
  {
    title: "Set a rally point",
    prompt:
      "Select a rock, press “Set Rally Point”, then click a target. New seedlings funnel there.",
    done: (world) => world.asteroids.some((a) => a.owner === 0 && a.rally >= 0),
  },
  {
    title: "Defeat the enemy",
    prompt:
      "Send your seedlings to wipe out the enemy bloom. Take every one of their rocks to win!",
    done: (world) => world.status === WORLD_STATUS.WON,
  },
];

// createTutorial(root, api) — api = { getWorld, getSelectedId }. Builds the coachmark overlay in
// the #Ui layer and returns { update, destroy }. update() is called each frame while the tutorial
// match is PLAYING; destroy() removes the overlay (called from App.tearDownMatch).
export function createTutorial(root, api) {
  let stepIdx = 0;
  let finished = false;

  // Coachmark card, bottom-center. The overlay wrapper has NO pointer events (so it never blocks
  // the canvas); only the card opts back in (for the Skip button + readability).
  const wrap = el("div", {
    style:
      "position:absolute;left:0;right:0;bottom:1.2rem;display:flex;justify-content:center;" +
      "pointer-events:none;z-index:20;padding:0 1rem;",
  });
  const card = el("wa-card", {
    style:
      "pointer-events:auto;max-width:520px;width:100%;--padding:1rem 1.15rem;" +
      "background:rgba(8,12,24,0.92);border:1px solid rgba(120,150,210,0.35);" +
      "box-shadow:0 6px 28px rgba(0,0,0,0.45);",
  });

  const head = el("div", {
    style:
      "display:flex;align-items:center;gap:.6rem;margin-bottom:.4rem;font:700 .95rem system-ui;",
  });
  const stepNum = el("span", {
    style:
      "flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;" +
      "min-width:1.9rem;height:1.4rem;padding:0 .45rem;border-radius:.7rem;" +
      "background:linear-gradient(90deg,#46e8ff,#8a7bff);color:#06101e;font:800 .8rem system-ui;",
  });
  const titleEl = el("span", { style: "color:#dfe6f5;" });
  const skip = el("wa-button", {
    size: "small",
    variant: "neutral",
    style: "margin-left:auto;",
    html: '<i slot="start" class="fa-solid fa-graduation-cap"></i>Skip tutorial',
  });
  if (typeof api.onSkip === "function")
    skip.addEventListener("click", () => api.onSkip());
  else skip.style.display = "none";
  head.append(stepNum, titleEl, skip);

  const promptEl = el("p", {
    style: "margin:0;color:#aebbd6;font:400 .9rem/1.45 system-ui;",
  });
  // A brief confirmation flash shown when a step is satisfied, just above the prompt.
  const flash = el("div", {
    "aria-live": "polite",
    style:
      "color:#5dff9b;font:700 .85rem system-ui;height:0;opacity:0;overflow:hidden;" +
      "transition:opacity .25s;margin-bottom:0;",
    html: '<i class="fa-solid fa-check"></i> Nice!',
  });

  card.append(head, flash, promptEl);
  wrap.append(card);
  root.append(wrap);

  let flashTimer = null;
  function render() {
    if (finished) {
      wrap.style.display = "none";
      return;
    }
    const s = STEPS[stepIdx];
    stepNum.textContent = `${stepIdx + 1}/${STEPS.length}`;
    titleEl.textContent = s.title;
    promptEl.textContent = s.prompt;
  }

  function flashNice() {
    flash.style.height = "auto";
    flash.style.opacity = "1";
    flash.style.marginBottom = ".35rem";
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flash.style.opacity = "0";
      flash.style.height = "0";
      flash.style.marginBottom = "0";
    }, 900);
  }

  // update — evaluate the CURRENT step's predicate each frame; advance (advance-only) when met.
  // When all steps complete, or the world reaches any terminal status, hide the coachmark. The
  // final step's WON predicate naturally coincides with the game-over Victory screen (App shows
  // it); the coachmark just guides until then.
  function update() {
    if (finished) return;
    const world = api.getWorld();
    if (!world) return;
    const selectedId = api.getSelectedId();
    // ANY terminal status ends the coachmark cleanly, regardless of which step is current. A win
    // (status "won") is the natural completion — the normal Victory game-over screen takes over —
    // but we finish here even if the player reached it before the coachmark walked to the last
    // step (so a fast/lucky win never leaves a stale prompt up). lost/draw are practically
    // impossible vs the passive AI but handled the same way defensively.
    if (
      world.status === WORLD_STATUS.WON ||
      world.status === WORLD_STATUS.LOST ||
      world.status === WORLD_STATUS.DRAW
    ) {
      finished = true;
      render();
      return;
    }
    const s = STEPS[stepIdx];
    if (s && s.done(world, selectedId)) {
      if (stepIdx >= STEPS.length - 1) {
        finished = true; // last step satisfied (won) — done
        render();
        return;
      }
      stepIdx++;
      flashNice();
      render();
    }
  }

  function destroy() {
    if (flashTimer) clearTimeout(flashTimer);
    wrap.remove();
  }

  render();
  return {
    update,
    destroy,
    // Exposed for the browser-verify harness to read step progress deterministically.
    get step() {
      return stepIdx;
    },
    get finished() {
      return finished;
    },
  };
}
