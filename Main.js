// Main.js — bootstrap + the game loop. Fixed-step accumulator at ~30 Hz; render once
// per rAF with interpolation alpha. Sim is frame-rate independent; render interpolates.
import { createGame } from "./Game.js";

const STEP = 1 / 30; // fixed sim timestep (seconds)
const MAX_STEPS = 5; // cap steps/frame to avoid spiral-of-death

function boot() {
  const canvas = document.getElementById("Canvas");
  const game = createGame(canvas);

  let last = performance.now();
  let acc = 0;

  function frame(now) {
    let elapsed = (now - last) / 1000;
    last = now;
    if (elapsed > 0.25) elapsed = 0.25; // clamp huge gaps (tab unfocus)
    acc += elapsed;

    // Sim.step snapshots x->px,y->py at the start of each tick, so render can lerp.
    let steps = 0;
    while (acc >= STEP && steps < MAX_STEPS) {
      game.step(STEP);
      acc -= STEP;
      steps++;
    }
    if (steps === MAX_STEPS) acc = 0; // drop backlog rather than spiral

    const alpha = acc / STEP;
    game.render(alpha);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

// Register the service worker with a relative scope so it works under a subpath.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const swUrl = new URL("./Sw.js", document.baseURI);
    navigator.serviceWorker.register(swUrl).catch((err) => {
      console.warn("SW registration failed:", err);
    });
  });
}
