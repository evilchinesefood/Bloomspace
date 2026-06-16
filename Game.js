// Game.js — wires Sim + Render + (placeholder) Ui together. Exposes world, the sim
// stepper, and the renderer. Render reads sim state; it never mutates game truth.
import Sim, { createWorld } from "./Sim/World.js";
import { createScene } from "./Render/Scene.js";
import { createSeedlingView } from "./Render/SeedlingView.js";
import * as THREE from "three";

export function createGame(canvas) {
  const world = createWorld({ width: 1000, height: 1000, seed: 1337 });
  const scene = createScene(canvas, world);
  const seedlings = createSeedlingView(scene.scene, world);

  // T1 proof-of-life: draw the home asteroid as a glowing core to orbit around.
  for (const a of world.asteroids) {
    const core = new THREE.Mesh(
      new THREE.CircleGeometry(a.radius, 32),
      new THREE.MeshBasicMaterial({ color: 0x2244aa }),
    );
    core.position.set(a.x, a.y, -1);
    scene.scene.add(core);
  }

  function render(alpha) {
    seedlings.update(alpha);
    scene.composer.render();
  }

  return {
    world,
    step: (dt) => Sim.step(world, dt),
    render,
    scene,
    seedlings,
  };
}
