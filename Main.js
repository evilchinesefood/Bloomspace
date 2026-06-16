// Main.js — bootstrap + the game loop. Fixed-step accumulator at ~30 Hz; render once per
// rAF with interpolation alpha. The App controller owns the match lifecycle; this loop
// asks it whether to step (PLAYING and not paused) and at what speed, then always renders
// so the scene stays visible behind menus. Speed scales sim time into the accumulator.
import { createApp } from "./Ui/App.js";

const STEP = 1 / 30; // fixed sim timestep (seconds)
const MAX_STEPS = 5; // cap steps/frame to avoid spiral-of-death

function boot() {
  const canvas = document.getElementById("Canvas");
  const root = document.getElementById("Ui");
  const app = createApp(canvas, root);

  let last = performance.now();
  let acc = 0;

  function frame(now) {
    let elapsed = (now - last) / 1000;
    last = now;
    if (elapsed > 0.25) elapsed = 0.25; // clamp huge gaps (tab unfocus)

    // Only accumulate sim time while actively playing. Speed (1×/2×/3×) scales the time
    // fed into the fixed-step accumulator; pause/menus contribute zero so the sim freezes.
    if (app.shouldStep()) {
      acc += elapsed * app.getSpeed();
      let steps = 0;
      while (acc >= STEP && steps < MAX_STEPS) {
        app.step(STEP);
        acc -= STEP;
        steps++;
      }
      if (steps === MAX_STEPS) acc = 0; // drop backlog rather than spiral
    } else {
      acc = 0; // don't bank time while paused/in menus
    }

    app.tick(); // HUD refresh + win/lose detection
    const alpha = acc / STEP;
    app.render(alpha);
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
