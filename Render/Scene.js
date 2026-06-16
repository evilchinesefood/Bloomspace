// Render/Scene.js — three.js setup: ortho top-down camera, EffectComposer with
// RenderPass + UnrealBloomPass + OutputPass, resize handling, and interactive camera
// control (wheel zoom-to-cursor + right/middle-button pan). Owns no game truth.
//
// Camera model: resize() computes a "fit-all" frustum (whole world centered, aspect
// preserved). Zoom/pan are stored as a multiplier + world-space offset applied on top of
// that base each frame via applyCamera(). Zoom 1 = fit-all; >1 zooms in. Picking reads the
// live camera so unproject stays correct at any zoom/pan (matrices updated here).
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// Bloom runs at half-resolution per the perf budget.
const BLOOM_SCALE = 0.5;

// Bloom tuning — only bright things (seedlings, owner rims) glow; dark rocks/background
// stay solid. A non-zero threshold is what keeps asteroids from blooming into "suns".
const BLOOM_STRENGTH = 0.55;
const BLOOM_RADIUS = 0.4;
const BLOOM_THRESHOLD = 0.55;

const MIN_ZOOM = 0.82; // allow pulling back a little past fit-all to see the whole map
const MAX_ZOOM = 8; // sane close-in limit
const ZOOM_STEP = 1.0015; // per wheel-delta unit

export function createScene(canvas, world) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x05070f, 1);

  const scene = new THREE.Scene();

  // --- Starfield background: dim points scattered across the world + a wide margin, so the
  // backdrop reads as deep space at any zoom/pan. Two tiers for depth; kept dim so they
  // don't bloom into big blobs. Cosmetic only (render-side Math.random is fine here).
  function addStars() {
    const margin = Math.max(world.width, world.height);
    const spanX = world.width + 2 * margin;
    const spanY = world.height + 2 * margin;
    const tier = (count, size, opacity, hex) => {
      const pos = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        pos[i * 3] = -margin + Math.random() * spanX;
        pos[i * 3 + 1] = -margin + Math.random() * spanY;
        pos[i * 3 + 2] = -20;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const m = new THREE.PointsMaterial({
        color: hex,
        size,
        sizeAttenuation: false,
        transparent: true,
        opacity,
        depthWrite: false,
      });
      scene.add(new THREE.Points(g, m));
    };
    // Kept below the bloom threshold so they stay crisp dots (no blocky bloom halos).
    tier(700, 1.3, 0.5, 0x7f8eac); // faint distant dust
    tier(240, 1.8, 0.6, 0xa6b1c8); // medium stars
    tier(40, 2.0, 0.55, 0x7d9ed8); // a few cool-blue accents
  }
  addStars();

  // Orthographic top-down camera framing the whole world.
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  camera.position.set(world.width / 2, world.height / 2, 100);
  camera.up.set(0, 1, 0);
  camera.lookAt(world.width / 2, world.height / 2, 0);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(1, 1),
    BLOOM_STRENGTH,
    BLOOM_RADIUS,
    BLOOM_THRESHOLD,
  );
  composer.addPass(bloom);
  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  // --- Camera state: fit-all base frame + zoom/pan on top -------------------
  // baseHalfW/H is the fit-all half-extent (zoom 1). centerX/Y is the pan target.
  let baseHalfW = world.width / 2;
  let baseHalfH = world.height / 2;
  let zoom = 1;
  let centerX = world.width / 2;
  let centerY = world.height / 2;

  function clampCenter() {
    const halfW = baseHalfW / zoom;
    const halfH = baseHalfH / zoom;
    // Allow the world to drift a little past the edge but not vanish (half-margin).
    const mx = Math.max(0, world.width / 2 - halfW) + halfW * 0.5;
    const my = Math.max(0, world.height / 2 - halfH) + halfH * 0.5;
    centerX = Math.min(
      world.width / 2 + mx,
      Math.max(world.width / 2 - mx, centerX),
    );
    centerY = Math.min(
      world.height / 2 + my,
      Math.max(world.height / 2 - my, centerY),
    );
  }

  // Push zoom/pan into the camera frustum + matrices (Picking depends on this).
  function applyCamera() {
    clampCenter();
    const halfW = baseHalfW / zoom;
    const halfH = baseHalfH / zoom;
    // Frustum is RELATIVE to the camera; pan by MOVING the camera. (Offsetting the frustum
    // by centerX/Y *and* positioning the camera at the center double-counts the offset and
    // shoves the world into a corner — the old framing bug.)
    camera.left = -halfW;
    camera.right = halfW;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.position.set(centerX, centerY, 100);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

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
    if (viewAspect >= worldAspect) {
      baseHalfH = world.height / 2;
      baseHalfW = baseHalfH * viewAspect;
    } else {
      baseHalfW = world.width / 2;
      baseHalfH = baseHalfW / viewAspect;
    }
    applyCamera();
  }

  // Reset to fit-all (called on a new match).
  function resetCamera() {
    zoom = 1;
    centerX = world.width / 2;
    centerY = world.height / 2;
    applyCamera();
  }

  // Screen px → world (x,y) at the CURRENT camera, for zoom-to-cursor.
  function screenToWorld(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((clientY - rect.top) / rect.height) * 2 + 1;
    return {
      x: centerX + (nx * baseHalfW) / zoom,
      y: centerY + (ny * baseHalfH) / zoom,
    };
  }

  // --- Wheel zoom toward the cursor -----------------------------------------
  function onWheel(e) {
    e.preventDefault();
    const before = screenToWorld(e.clientX, e.clientY);
    const next = zoom * Math.pow(ZOOM_STEP, -e.deltaY);
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    // Keep the world point under the cursor fixed: shift center by the delta.
    const after = screenToWorld(e.clientX, e.clientY);
    centerX += before.x - after.x;
    centerY += before.y - after.y;
    applyCamera();
  }

  // --- Right / middle-button drag pan (NOT left — that sends seedlings) ------
  let panning = false;
  let panPointer = null;
  let lastPanX = 0;
  let lastPanY = 0;

  function onPointerDown(e) {
    if (e.button !== 1 && e.button !== 2) return; // middle or right only
    panning = true;
    panPointer = e.pointerId;
    lastPanX = e.clientX;
    lastPanY = e.clientY;
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e) {
    if (!panning || e.pointerId !== panPointer) return;
    const rect = canvas.getBoundingClientRect();
    // World units per screen pixel at the current zoom.
    const wppX = (2 * baseHalfW) / zoom / rect.width;
    const wppY = (2 * baseHalfH) / zoom / rect.height;
    centerX -= (e.clientX - lastPanX) * wppX;
    centerY += (e.clientY - lastPanY) * wppY; // screen-y is inverted vs world-y
    lastPanX = e.clientX;
    lastPanY = e.clientY;
    applyCamera();
  }
  function endPan(e) {
    if (e && panPointer !== null && e.pointerId !== panPointer) return;
    panning = false;
    panPointer = null;
  }
  function onContextMenu(e) {
    e.preventDefault(); // right-drag pan shouldn't pop the browser menu
  }

  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endPan);
  canvas.addEventListener("pointercancel", endPan);
  canvas.addEventListener("contextmenu", onContextMenu);

  function disposeControls() {
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", endPan);
    canvas.removeEventListener("pointercancel", endPan);
    canvas.removeEventListener("contextmenu", onContextMenu);
  }

  // Toggle bloom in/out of the render path. OFF renders straight to screen.
  function setBloomEnabled(on) {
    bloom.enabled = !!on;
  }

  window.addEventListener("resize", resize);
  resize();

  return {
    THREE,
    renderer,
    scene,
    camera,
    composer,
    bloom,
    resize,
    resetCamera,
    setBloomEnabled,
    disposeControls,
    // Live zoom factor (1 = fit-all, >1 = zoomed in).
    getZoom: () => zoom,
    // World units covered by one screen pixel at the current zoom — drives apparent-size
    // LOD so the default fit-all view shows seedlings on every map size.
    getWorldPerPixel: () =>
      (2 * baseHalfW) / zoom / (canvas.clientWidth || window.innerWidth),
  };
}
