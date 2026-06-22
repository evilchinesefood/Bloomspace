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
import { createThreatView } from "./Render/ThreatView.js";
import { createFx } from "./Render/Fx.js";
import { createPicking } from "./Render/Picking.js";
import { createInput } from "./Ui/Input.js";
import { createSound } from "./Ui/Sound.js";
import { reducedMotion } from "./Render/Theme.js";

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
  specials: true, // terrain specials ON for real matches (tests omit this → no drift)
  players: [
    { id: 0, isAi: false, difficulty: 0 },
    { id: 1, isAi: true, difficulty: 1 },
    { id: 2, isAi: true, difficulty: 1 },
  ],
};

// createGame(canvas, config, restoredWorld?) — wires a match. A FRESH match passes config and
// generates a world. A RESUMED match passes an already-deserialized `restoredWorld` (from
// Ui/Persist.readSave): we skip createWorld and adopt it verbatim so its baked-in specials /
// graph / mid-game state continue deterministically (no re-generation). Everything downstream
// (scene/views/input) reads the live world the same way for both paths.
export function createGame(canvas, config = {}, restoredWorld = null) {
  const world = restoredWorld || createWorld({ ...DEFAULT_CONFIG, ...config });

  const scene = createScene(canvas, world);
  // Views take the scene controller so SeedlingView/AsteroidView can read live zoom +
  // camera frustum for culling/LOD. New match starts framed at fit-all.
  scene.resetCamera();
  const fx = createFx(scene.scene, world);
  const asteroids = createAsteroidView(scene.scene, world, scene, fx);
  const seedlings = createSeedlingView(scene.scene, world, scene);
  const trees = createTreeView(scene.scene, world);
  // Read-only hold-Q tactical overlay (flow dashes + contest tint). Activated via the getter
  // seam below (App wires it to overlay.isThreatActive()); inactive = effectively zero cost.
  const threat = createThreatView(scene.scene, world);
  const picking = createPicking(scene.scene, scene.camera, canvas, world);
  // Non-authoritative audio: starts suspended, unlocks on first user gesture, consumes the
  // same event channel the FX drain reads. Owns no game truth. Defaults enabled; the real
  // saved sfx/music state is applied by App.applyQuality() right after construction.
  const sound = createSound();
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
  let eventSink = null;
  // Parallel to eventSink: a getter App wires to overlay.isThreatActive(). Render reads it
  // each frame to toggle the read-only ThreatView (hold-Q). Null/false = inactive.
  let threatActiveGetter = null;

  // --- FX polish: cheap, non-authoritative death + flower puffs (render READS sim only).
  let flowerTimer = 0;
  const FLOWER_EVERY = 0.9; // seconds between flower-puff sweeps
  const DEATH_PUFF_MAX = 4; // cap puffs per frame so big die-offs don't spam the pool

  // Combo tracker: render-only, not serialized. Escalates capture juice for rapid p0 captures.
  const COMBO_WINDOW = 2.5; // seconds before combo resets
  let comboCount = 0;
  let comboLastMs = 0;

  function emitFlowerPuffs() {
    for (const a of world.asteroids) {
      if (!a.trees || a.trees.length === 0) continue;
      // A "mature seedling tree" — gentle bloom over rocks actively producing.
      let mature = false;
      for (const t of a.trees)
        if (t.type === "seedling" && t.growth >= 1) {
          mature = true;
          break;
        }
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
    // Fog: suppress combat death-puffs at locations the human can't currently see, so a hidden
    // enemy fight doesn't betray itself. Nearest live rock's visibility is the proxy.
    const fogHidden = (x, y) => {
      if (!world.fogOn || !world.fog) return false;
      const aa = world.asteroids;
      let best = -1,
        bd = Infinity;
      for (let i = 0; i < aa.length; i++) {
        if (aa[i].dead) continue;
        const dx = aa[i].x - x,
          dy = aa[i].y - y,
          d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      return best >= 0 && !world.fog.seen[0][best];
    };
    for (let k = 0; k < ev.n; k++) {
      const type = ev.type[k];
      const own = ev.owner[k];
      if (eventSink) eventSink(type, ev.x[k], ev.y[k], own, ev.x2[k], ev.y2[k]);
      if (type === EVENT.DEATH) {
        if (puffs < DEATH_PUFF_MAX && !fogHidden(ev.x[k], ev.y[k])) {
          fx.spawnDeath(ev.x[k], ev.y[k]); // puff only for battles the player can currently see
          puffs++;
        }
        if (own === 0) sound.play("death"); // only player-0 deaths get the SFX
      } else if (type === EVENT.SEND) {
        if (own === 0) sound.play("send");
      } else if (type === EVENT.CAPTURE) {
        if (!reducedMotion() && !fogHidden(ev.x[k], ev.y[k])) {
          // Escalate burst for rapid player-0 captures (combo); other owners get base scale.
          let scale = 1;
          if (own === 0) {
            if (now - comboLastMs <= COMBO_WINDOW * 1000) comboCount++;
            else comboCount = 1;
            comboLastMs = now;
            scale = Math.min(comboCount, 3);
            // Pitch the capture cue up with combo (replaces the base play below).
            sound.play(
              "capture",
              scale > 1 ? { rate: 0.9 + scale * 0.1 } : undefined,
            );
          }
          fx.spawnCapture(ev.x[k], ev.y[k], ownerColorHex(ev.owner[k]), scale);
        } else if (own === 0) {
          sound.play("capture"); // reduced-motion or fog-hidden: audio only for player-0
        }
      } else if (type === EVENT.WIN) sound.play("win");
      else if (type === EVENT.LOSE) sound.play("lose");
      else if (type === EVENT.FIRE) {
        if (own === 0) sound.play("fire"); // bombardment battery fire-start
        if (!reducedMotion() && !fogHidden(ev.x[k], ev.y[k]))
          fx.spawnShock(ev.x[k], ev.y[k]);
      } else if (type === EVENT.LOST)
        sound.play("alert"); // always; owner is 0 — guarded at emit site in Combat.flipOwnership
      else if (type === EVENT.DESTROY)
        sound.play("explosion"); // body destroyed
      else if (type === EVENT.FLARE) {
        fx.spawnFlare(ev.x[k], ev.y[k]); // solar flare ring from the star — always (global)
        sound.play("flare");
      } else if (type === EVENT.METEOR) {
        fx.spawnMeteor(ev.x[k], ev.y[k]); // meteor impact — always (global)
        sound.play("meteor");
      }
    }
    ev.n = 0;
    sound.endFrame(); // reset per-frame SFX throttle counters

    flowerTimer += dt;
    if (flowerTimer >= FLOWER_EVERY) {
      flowerTimer = 0;
      if (!reducedMotion()) emitFlowerPuffs();
    }

    scene.driftStars(dt);
    asteroids.update(dt);
    seedlings.update(alpha);
    trees.update();
    threat.setActive(threatActiveGetter ? threatActiveGetter() : false);
    threat.update(dt);
    fx.update(dt);
    picking.update();
    // Skip the GL draw while the WebGL context is lost (else composer.render throws every
    // frame). The loop keeps running; rendering resumes when the context is restored.
    if (!scene.isContextLost || !scene.isContextLost()) scene.composer.render();
  }

  function destroy() {
    sound.destroy();
    input.destroy();
    threat.dispose(); // ThreatView owns its own flow/ring buffers — free them explicitly

    // Drop the resize listener the scene registered so matches don't stack handlers.
    if (scene.onWindowResize)
      window.removeEventListener("resize", scene.onWindowResize);
    // Drop the camera control listeners (wheel/pointer/contextmenu) too.
    if (scene.disposeControls) scene.disposeControls();
    // Release the WebGL context so repeated New Game cycles don't exhaust the browser's
    // context budget (Scene builds a fresh renderer on the shared canvas each match).
    try {
      // Free per-match geometries/materials/textures/instance buffers; keep the shared
      // module-cached glow texture (AsteroidView reuses it across matches).
      disposeSceneGraph(scene.scene, new Set(sharedTextures()));
      scene.composer.dispose && scene.composer.dispose();
      // EffectComposer.dispose only frees its own read/write targets, not each Pass's. Free the
      // target-owning passes (UnrealBloomPass's mip-chain targets, OutputPass) so New Game cycles
      // don't leak framebuffer memory.
      scene.bloom?.dispose?.();
      scene.outputPass?.dispose?.();
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
    // Additive event sink: set once by Overlay; called per-event inside the render drain.
    setEventSink: (fn) => {
      eventSink = fn || null;
    },
    // Parallel seam (App wires to overlay.isThreatActive()): toggles the hold-Q ThreatView.
    setThreatActiveGetter: (fn) => {
      threatActiveGetter = fn || null;
    },
    // Camera/minimap controls: the visible world rect + a pan-to-center action.
    getViewRect: () => scene.getViewRect(),
    centerOn: (x, y) => scene.centerOn(x, y),
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
    // Tech-buy wrapper: routes the HUD's tech-panel buy through Input (player 0), firing the
    // plant SFX on a successful purchase (a satisfying confirm cue; no dedicated tech sound).
    buyTech: (track) => {
      const ok = input.tech(track);
      if (ok) sound.play("plant");
      return ok;
    },
    // Upgrade wrapper: routes the HUD's per-rock stat upgrade through Input (player 0).
    upgrade: (stat) => {
      const ok = input.upgrade(stat);
      if (ok) sound.play("plant");
      return ok;
    },
    // Clear-trees wrapper: removes every tree on the selected rock so it can be repurposed.
    // Plays the death/poof cue on a real clear (a removal, not a build).
    clearTrees: () => {
      const ok = input.clearTrees();
      if (ok) sound.play("death");
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
