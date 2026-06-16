// Game.js — wires Sim + Render + Input for a single match. createGame(canvas, config)
// builds a world from the given config (parametrized by the skirmish setup), constructs
// the scene/views/picking, and attaches the real T7 input loop. Render reads sim state;
// the human mutates the world ONLY through Input (sendSeedlings / plantTree).
import Sim, { createWorld, STATE } from "./Sim/World.js";
import { ownerColorHex } from "./Render/Palette.js";
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
  // Views take the scene controller so SeedlingView/AsteroidView can read live zoom +
  // camera frustum for culling/LOD. New match starts framed at fit-all.
  scene.resetCamera();
  const asteroids = createAsteroidView(scene.scene, world, scene);
  const seedlings = createSeedlingView(scene.scene, world, scene);
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

  // --- FX polish: cheap, non-authoritative death + flower puffs (render READS sim only).
  // Deaths: when the live seedling count drops between frames, scatter a few death puffs at
  // current COMBAT-state hotspots (we don't track exact dead indices — visual sugar only).
  let lastSeedCount = world.seed.count;
  let flowerTimer = 0;
  const FLOWER_EVERY = 0.9; // seconds between flower-puff sweeps
  const DEATH_PUFF_MAX = 4; // cap puffs per frame so big die-offs don't spam the pool

  function emitDeathPuffs() {
    const s = world.seed;
    let spawned = 0;
    for (let i = 0; i < s.count && spawned < DEATH_PUFF_MAX; i++) {
      if (s.state[i] === STATE.COMBAT) {
        fx.spawnDeath(s.x[i], s.y[i]);
        spawned++;
      }
    }
  }

  function emitFlowerPuffs() {
    for (const a of world.asteroids) {
      if (!a.trees || a.trees.length === 0) continue;
      // A "mature seedling tree" — gentle bloom over rocks actively producing.
      const mature = a.trees.some(
        (t) => t.type === "seedling" && t.growth >= 1,
      );
      if (mature) fx.spawnFlower(a.x, a.y, ownerColorHex(a.owner));
    }
  }

  function render(alpha) {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastRenderMs) / 1000);
    lastRenderMs = now;

    const count = world.seed.count;
    if (count < lastSeedCount) emitDeathPuffs();
    lastSeedCount = count;

    flowerTimer += dt;
    if (flowerTimer >= FLOWER_EVERY) {
      flowerTimer = 0;
      emitFlowerPuffs();
    }

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
    // Drop the camera control listeners (wheel/pointer/contextmenu) too.
    if (scene.disposeControls) scene.disposeControls();
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
    // Quality controls for the HUD settings panel.
    setBloomEnabled: (on) => scene.setBloomEnabled(on),
    setSeedlingCap: (n) => seedlings.setCap(n),
    destroy,
  };
}
