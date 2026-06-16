// Game.js — wires Sim + Render together. Exposes world, the sim stepper, the renderer,
// the views, and picking for T7's input layer. Render reads sim state; never mutates it.
import Sim, { createWorld } from "./Sim/World.js";
import { createScene } from "./Render/Scene.js";
import { createAsteroidView } from "./Render/AsteroidView.js";
import { createSeedlingView } from "./Render/SeedlingView.js";
import { createTreeView } from "./Render/TreeView.js";
import { createFx } from "./Render/Fx.js";
import { createPicking } from "./Render/Picking.js";
import { ownerColorHex } from "./Render/Palette.js";

export function createGame(canvas) {
  const world = createWorld({
    width: 1000,
    height: 1000,
    seed: 1337,
    asteroidCount: 24,
    players: [
      { id: 0, isAi: false, difficulty: 0 },
      { id: 1, isAi: true, difficulty: 1 },
      { id: 2, isAi: true, difficulty: 1 },
    ],
  });

  const scene = createScene(canvas, world);
  const asteroids = createAsteroidView(scene.scene, world);
  const seedlings = createSeedlingView(scene.scene, world);
  const trees = createTreeView(scene.scene, world);
  const fx = createFx(scene.scene, world);
  const picking = createPicking(scene.scene, scene.camera, canvas, world);

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

  // --- DEV HOOK (remove/replace in T7) ---------------------------------------
  // Click an asteroid to select it, log it, and fire a cosmetic send burst so the FX
  // pipeline is visibly working. T7 replaces this with the real select→drag→% loop.
  canvas.addEventListener("pointerdown", (e) => {
    const id = picking.asteroidAt(e.clientX, e.clientY, world);
    if (id < 0) {
      asteroids.clearSelected();
      return;
    }
    asteroids.setSelected(id);
    const a = world.asteroids[id];
    fx.spawnSend(a.x, a.y, ownerColorHex(a.owner));
    console.log(
      `[dev] picked asteroid ${id} owner=${a.owner} ` +
        `E${a.energyStat}/S${a.strengthStat}/Sp${a.speedStat}`,
    );
  });
  // ---------------------------------------------------------------------------

  return {
    world,
    step: (dt) => Sim.step(world, dt),
    render,
    scene: scene.scene,
    camera: scene.camera,
    composer: scene.composer,
    views: { asteroids, seedlings, trees, fx },
    picking,
  };
}
