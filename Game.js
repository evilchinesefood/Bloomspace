// Game.js — wires Sim + Render + Input for a single match. createGame(canvas, config)
// builds a world from the given config (parametrized by the skirmish setup), constructs
// the scene/views/picking, and attaches the real T7 input loop. Render reads sim state;
// the human mutates the world ONLY through Input (sendSeedlings / plantTree).
import Sim, { createWorld } from "./Sim/World.js";
import { createScene } from "./Render/Scene.js";
import { createAsteroidView } from "./Render/AsteroidView.js";
import { createSeedlingView } from "./Render/SeedlingView.js";
import { createTreeView } from "./Render/TreeView.js";
import { createFx } from "./Render/Fx.js";
import { createPicking } from "./Render/Picking.js";
import { createInput } from "./Ui/Input.js";

const DEFAULT_CONFIG = {
  width: 1000,
  height: 1000,
  seed: 1337,
  asteroidCount: 24,
  players: [
    { id: 0, isAi: false, difficulty: 0 },
    { id: 1, isAi: true, difficulty: 1 },
    { id: 2, isAi: true, difficulty: 1 },
  ],
};

export function createGame(canvas, config = {}) {
  const world = createWorld({ ...DEFAULT_CONFIG, ...config });

  const scene = createScene(canvas, world);
  const asteroids = createAsteroidView(scene.scene, world);
  const seedlings = createSeedlingView(scene.scene, world);
  const trees = createTreeView(scene.scene, world);
  const fx = createFx(scene.scene, world);
  const picking = createPicking(scene.scene, scene.camera, canvas, world);
  const views = { asteroids, seedlings, trees, fx };

  // Send-fraction lives here so Input (drag release) and the HUD slider share one source.
  let sendFraction = 0.5;

  const input = createInput({
    canvas,
    getWorld: () => world,
    views,
    picking,
    getSendFraction: () => sendFraction,
  });

  let lastRenderMs = performance.now();

  function render(alpha) {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastRenderMs) / 1000);
    lastRenderMs = now;

    asteroids.update();
    seedlings.update(alpha);
    trees.update();
    fx.update(dt);
    picking.update();
    scene.composer.render();
  }

  function destroy() {
    input.destroy();
    // Drop the resize listener the scene registered so matches don't stack handlers.
    if (scene.resize) window.removeEventListener("resize", scene.resize);
    // Release the WebGL context so repeated New Game cycles don't exhaust the browser's
    // context budget (Scene builds a fresh renderer on the shared canvas each match).
    try {
      scene.composer.dispose && scene.composer.dispose();
      scene.renderer.dispose();
      scene.renderer.forceContextLoss && scene.renderer.forceContextLoss();
    } catch (err) {
      console.warn("renderer dispose failed:", err);
    }
  }

  return {
    world,
    step: (dt) => Sim.step(world, dt),
    render,
    scene: scene.scene,
    camera: scene.camera,
    composer: scene.composer,
    resize: scene.resize,
    views,
    picking,
    input,
    getSendFraction: () => sendFraction,
    setSendFraction: (f) => {
      sendFraction = Math.max(0, Math.min(1, f));
    },
    destroy,
  };
}
