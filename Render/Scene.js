// Render/Scene.js — three.js setup: ortho top-down camera, EffectComposer with
// RenderPass + UnrealBloomPass + OutputPass, resize handling. Owns no game truth.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// Bloom runs at half-resolution per the perf budget.
const BLOOM_SCALE = 0.5;

export function createScene(canvas, world) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x05070f, 1);

  const scene = new THREE.Scene();

  // Orthographic top-down camera framing the whole world.
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  camera.position.set(world.width / 2, world.height / 2, 100);
  camera.up.set(0, 1, 0);
  camera.lookAt(world.width / 2, world.height / 2, 0);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(1, 1),
    1.3, // strength
    0.4, // radius
    0.0, // threshold (everything emissive blooms)
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloom.setSize(
      Math.max(1, Math.floor(w * BLOOM_SCALE)),
      Math.max(1, Math.floor(h * BLOOM_SCALE)),
    );
    // Fit the world into the viewport, preserving aspect, centered.
    const worldAspect = world.width / world.height;
    const viewAspect = w / h;
    let halfW, halfH;
    if (viewAspect >= worldAspect) {
      halfH = world.height / 2;
      halfW = halfH * viewAspect;
    } else {
      halfW = world.width / 2;
      halfH = halfW / viewAspect;
    }
    const cx = world.width / 2;
    const cy = world.height / 2;
    camera.left = cx - halfW;
    camera.right = cx + halfW;
    camera.top = cy + halfH;
    camera.bottom = cy - halfH;
    camera.updateProjectionMatrix();
  }

  window.addEventListener("resize", resize);
  resize();

  return { THREE, renderer, scene, camera, composer, bloom, resize };
}
