// Game.js — wires Sim + Render + Input for a single match. createGame(canvas, config)
// builds a world from the given config (parametrized by the skirmish setup), constructs
// the scene/views/picking, and attaches the real T7 input loop. Render reads sim state;
// the human mutates the world ONLY through Input (sendSeedlings / plantTree).
import Sim, { createWorld, EVENT } from "./Sim/World.js";
import { ownerColorHex } from "./Render/Palette.js";
import { createScene } from "./Render/Scene.js";
import { createAsteroidView, sharedTextures } from "./Render/AsteroidView.js";
import { createSeedlingView } from "./Render/SeedlingView.js";
import { createTreeView } from "./Render/TreeView.js";
import { createFx } from "./Render/Fx.js";
import { createPicking } from "./Render/Picking.js";
import { createInput } from "./Ui/Input.js";
import { createSound } from "./Ui/Sound.js";

// Free every GPU resource a match's scene graph holds. renderer.dispose()/forceContextLoss
// reclaim the GL context, but the geometries, materials, instance buffers and (notably)
// procedural CanvasTextures created per match are otherwise retained on the JS heap across
// New Game cycles. Traverse once, dedupe, dispose. `keep` is the set of deliberately shared
// (module-cached) textures that must survive teardown for reuse by the next match.
function disposeSceneGraph(root, keep) {
  const geos = new Set();
  const mats = new Set();
  const texs = new Set();
  root.traverse((o) => {
    if (o.geometry) geos.add(o.geometry);
    const m = o.material;
    if (m) (Array.isArray(m) ? m : [m]).forEach((mm) => mm && mats.add(mm));
    if (typeof o.dispose === "function") o.dispose(); // InstancedMesh instance buffers
  });
  for (const m of mats)
    for (const k in m) {
      const v = m[k];
      if (v && v.isTexture) texs.add(v);
    }
  geos.forEach((g) => g.dispose());
  texs.forEach((t) => {
    if (!keep || !keep.has(t)) t.dispose();
  });
  mats.forEach((m) => m.dispose());
}

const DEFAULT_CONFIG = {
  width: 1700,
  height: 1700,
  seed: 1337,
  asteroidCount: 26,
  planetMin: 1,
  planetMax: 2,
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
  // Non-authoritative audio: starts suspended, unlocks on first user gesture, consumes the
  // same event channel the FX drain reads. Owns no game truth.
  const sound = createSound(config.audio || {});
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
  let flowerTimer = 0;
  const FLOWER_EVERY = 0.9; // seconds between flower-puff sweeps
  const DEATH_PUFF_MAX = 4; // cap puffs per frame so big die-offs don't spam the pool

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

    // Drain the sim's exact per-tick event channel (recorded during step()) ONCE, feeding BOTH
    // FX and audio in the same pass (n is reset after, so a second reader would see 0). DEATH
    // events become death puffs, capped so big die-offs don't spam the pool — we cap the puffs
    // SPAWNED, not the events scanned. Sound maps each event type to a one-shot SFX (its own
    // per-frame throttle prevents machine-gunning). Accumulates across the steps run this frame;
    // cleared here so a paused frame (no steps) re-spawns nothing.
    const ev = world.events;
    let puffs = 0;
    for (let k = 0; k < ev.n; k++) {
      const type = ev.type[k];
      if (type === EVENT.DEATH) {
        if (puffs < DEATH_PUFF_MAX) {
          fx.spawnDeath(ev.x[k], ev.y[k]);
          puffs++;
        }
        sound.play("death");
      } else if (type === EVENT.SEND) sound.play("send");
      else if (type === EVENT.CAPTURE) sound.play("capture");
      else if (type === EVENT.WIN) sound.play("win");
      else if (type === EVENT.LOSE) sound.play("lose");
      else if (type === EVENT.FIRE) sound.play("fire"); // reserved; no emitter yet
    }
    ev.n = 0;
    sound.endFrame(); // reset per-frame SFX throttle counters

    flowerTimer += dt;
    if (flowerTimer >= FLOWER_EVERY) {
      flowerTimer = 0;
      emitFlowerPuffs();
    }

    scene.driftStars(dt);
    asteroids.update();
    seedlings.update(alpha);
    trees.update();
    fx.update(dt);
    picking.update();
    // Skip the GL draw while the WebGL context is lost (else composer.render throws every
    // frame). The loop keeps running; rendering resumes when the context is restored.
    if (!scene.isContextLost || !scene.isContextLost()) scene.composer.render();
  }

  function destroy() {
    sound.destroy();
    input.destroy();
    // Drop the resize listener the scene registered so matches don't stack handlers.
    if (scene.resize) window.removeEventListener("resize", scene.resize);
    // Drop the camera control listeners (wheel/pointer/contextmenu) too.
    if (scene.disposeControls) scene.disposeControls();
    // Release the WebGL context so repeated New Game cycles don't exhaust the browser's
    // context budget (Scene builds a fresh renderer on the shared canvas each match).
    try {
      // Free per-match geometries/materials/textures/instance buffers; keep the shared
      // module-cached glow texture (AsteroidView reuses it across matches).
      disposeSceneGraph(scene.scene, new Set(sharedTextures()));
      scene.composer.dispose && scene.composer.dispose();
      scene.renderer.dispose();
      scene.renderer.forceContextLoss && scene.renderer.forceContextLoss();
    } catch (err) {
      console.warn("renderer dispose failed:", err);
    }
  }

  // Warm-up render: three.js + UnrealBloomPass compile their shaders lazily on first render,
  // which otherwise lands as a ~200ms hitch in the first animation frame. Do it here, at
  // match setup (right after the player hits Start), so the game loop stays smooth.
  render(0);

  const api = {
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
    // Audio controls (consumed via the App quality object).
    setSfxEnabled: (on) => sound.setSfxEnabled(on),
    setMusicEnabled: (on) => sound.setMusicEnabled(on),
    sound, // exposed for browser verification (debug()/gain inspection)
    // Plant wrapper: routes the HUD's plant action through Input, then fires a plant SFX only
    // when a tree was actually planted (Input returns false on a failed/blocked plant).
    plant: (type) => {
      const ok = input.plant(type);
      if (ok) sound.play("plant");
      return ok;
    },
    // Read-only flags surfaced for the headless verify harness (reduced-motion + bloom state).
    sceneReducedMotion: scene.reducedMotion,
    get bloomEnabled() {
      return scene.bloom.enabled;
    },
    destroy,
  };

  // Verification seam: expose the live match on window ONLY when the URL carries ?debug. No-op
  // in normal play — lets the headless browser-verify harness read audio gains + motion flags.
  if (
    typeof location !== "undefined" &&
    /\bdebug\b/.test(location.search || "")
  )
    window.__bloomGame = api;

  return api;
}
