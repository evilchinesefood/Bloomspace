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
import { reducedMotion } from "./Theme.js";

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

  // --- Starfield background: dim points across the world + a wide margin so the backdrop
  // reads as deep space at any zoom/pan, with a subtle downward parallax drift (matching the
  // start-menu starfield). Kept below the bloom threshold so they stay crisp dots.
  const starTiers = []; // { geo, speeds, bottom, top }
  function addStars() {
    const margin = Math.max(world.width, world.height);
    const bottom = -margin;
    const spanX = world.width + 2 * margin;
    const spanY = world.height + 2 * margin;
    const tier = (count, size, opacity, hex, baseSpd) => {
      const pos = new Float32Array(count * 3);
      const speeds = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        pos[i * 3] = bottom + Math.random() * spanX;
        pos[i * 3 + 1] = bottom + Math.random() * spanY;
        pos[i * 3 + 2] = -20;
        speeds[i] = baseSpd * (0.6 + Math.random() * 0.8); // varied = parallax
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
      starTiers.push({ geo: g, speeds, bottom, top: bottom + spanY });
    };
    // Same palette as the menu starfield; near tiers drift a touch faster (parallax).
    tier(700, 1.3, 0.5, 0x7f8eac, 2);
    tier(260, 1.8, 0.65, 0xa6b1c8, 5);
    tier(120, 1.7, 0.6, 0xdfe6f5, 4);
    tier(40, 2.1, 0.6, 0x7d9ed8, 8);
  }
  addStars();

  // Construction-time snapshot for AsteroidView / Game.sceneReducedMotion (battery-pulse toggle
  // applies on next match; the primary motion — starfield + Fx — toggles live via reducedMotion()).
  const reducedMotionSnap = reducedMotion();

  // Subtle starfield drift (downward), wrapping. Called each render frame with dt. Becomes a
  // no-op under reduced-motion (checked live so toggling stops/starts the starfield mid-match).
  function driftStars(dt) {
    if (reducedMotion()) return;
    for (const t of starTiers) {
      const p = t.geo.attributes.position.array;
      const sp = t.speeds;
      for (let i = 0; i < sp.length; i++) {
        let y = p[i * 3 + 1] - sp[i] * dt; // screen-down = world -y
        if (y < t.bottom) y = t.top;
        p[i * 3 + 1] = y;
      }
      t.geo.attributes.position.needsUpdate = true;
    }
  }

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
    // Refresh device-pixel-ratio so dragging the window to a different-DPR monitor (which
    // fires resize) re-sharpens the backing store. composer caches its own ratio, so update
    // both; EffectComposer.setSize already scales render targets by it internally.
    const pr = Math.min(window.devicePixelRatio, 2);
    if (renderer.getPixelRatio() !== pr) renderer.setPixelRatio(pr);
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

  // Pan the camera to center on a world point (clamped by applyCamera). Used by the minimap.
  function centerOn(worldX, worldY) {
    centerX = worldX;
    centerY = worldY;
    applyCamera();
  }

  // The currently-visible world rectangle: center ± half-extents at the live zoom.
  function getViewRect() {
    return {
      cx: centerX,
      cy: centerY,
      halfW: baseHalfW / zoom,
      halfH: baseHalfH / zoom,
    };
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

  // --- Camera drag pan: right/middle mouse button (NOT left — that sends seedlings), or
  //     two-finger touch. Single-finger touch is left to Input.js (select / drag-to-send). --
  let panning = false;
  let panPointer = null;
  let lastPanX = 0;
  let lastPanY = 0;

  // Active touch points + last two-finger pinch state (midpoint + spread).
  const touchPts = new Map(); // pointerId -> {x, y}
  let pinchDist = 0;
  let pinchCx = 0;
  let pinchCy = 0;

  function twoTouch() {
    const it = touchPts.values();
    const a = it.next().value;
    const b = it.next().value;
    return {
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      dist: Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2),
    };
  }

  // Two-finger gesture: pan by the midpoint's movement and zoom by the spread ratio, keeping
  // the world point under the midpoint fixed (pinch-to-zoom toward the fingers).
  function handlePinch() {
    const rect = canvas.getBoundingClientRect();
    const t = twoTouch();
    const before = screenToWorld(t.cx, t.cy);
    if (pinchDist > 0) {
      zoom = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, zoom * (t.dist / pinchDist)),
      );
    }
    const wppX = (2 * baseHalfW) / zoom / rect.width;
    const wppY = (2 * baseHalfH) / zoom / rect.height;
    centerX -= (t.cx - pinchCx) * wppX;
    centerY += (t.cy - pinchCy) * wppY;
    const after = screenToWorld(t.cx, t.cy); // reads updated zoom/center
    centerX += before.x - after.x;
    centerY += before.y - after.y;
    applyCamera();
    pinchDist = t.dist;
    pinchCx = t.cx;
    pinchCy = t.cy;
  }

  function onPointerDown(e) {
    if (e.pointerType === "touch") {
      touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // setPointerCapture throws if the pointer isn't currently active (some browsers /
      // synthetic events) — capture is a nicety here, not required, so never let it throw.
      try {
        canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
      } catch {
        /* not capturable — fine */
      }
      if (touchPts.size === 2) {
        const t = twoTouch();
        pinchDist = t.dist;
        pinchCx = t.cx;
        pinchCy = t.cy;
      }
      return;
    }
    if (e.button !== 1 && e.button !== 2) return; // middle or right only
    panning = true;
    panPointer = e.pointerId;
    lastPanX = e.clientX;
    lastPanY = e.clientY;
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e) {
    if (e.pointerType === "touch") {
      if (!touchPts.has(e.pointerId)) return;
      touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touchPts.size === 2) handlePinch();
      return;
    }
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
    if (e && e.pointerType === "touch") {
      touchPts.delete(e.pointerId);
      if (touchPts.size === 2) {
        const t = twoTouch(); // re-seed if dropping from 3→2 fingers
        pinchDist = t.dist;
        pinchCx = t.cx;
        pinchCy = t.cy;
      }
      return;
    }
    if (e && panPointer !== null && e.pointerId !== panPointer) return;
    panning = false;
    panPointer = null;
  }
  function onContextMenu(e) {
    e.preventDefault(); // right-drag pan shouldn't pop the browser menu
  }

  // --- WebGL context loss: an unsolicited loss (mobile GPU reset, driver hiccup) would make
  //     composer.render() throw every frame. preventDefault is REQUIRED for the browser to
  //     fire 'restored' later. Render is skipped while lost (Game.js checks isContextLost). --
  let contextLost = false;
  function onContextLost(e) {
    e.preventDefault();
    contextLost = true;
  }
  function onContextRestored() {
    contextLost = false;
    // three re-initializes GL state on restore; instance buffers re-upload (needsUpdate is
    // set every frame) and textures re-upload on next use. Re-fit defensively.
    resize();
  }

  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endPan);
  canvas.addEventListener("pointercancel", endPan);
  canvas.addEventListener("contextmenu", onContextMenu);
  canvas.addEventListener("webglcontextlost", onContextLost, false);
  canvas.addEventListener("webglcontextrestored", onContextRestored, false);

  // rAF-coalesce the WINDOW resize listener only: bloom.setSize() reallocates all of
  // UnrealBloomPass's render targets, so dragging the window edge must not fire resize() dozens
  // of times/sec. Direct resize() calls (context-restore, game.resize) stay synchronous.
  let resizeRaf = 0;
  function onWindowResize() {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      resize();
    });
  }

  function disposeControls() {
    if (resizeRaf) {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = 0;
    }
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", endPan);
    canvas.removeEventListener("pointercancel", endPan);
    canvas.removeEventListener("contextmenu", onContextMenu);
    canvas.removeEventListener("webglcontextlost", onContextLost);
    canvas.removeEventListener("webglcontextrestored", onContextRestored);
  }

  // Toggle bloom in/out of the render path. OFF renders straight to screen.
  function setBloomEnabled(on) {
    bloom.enabled = !!on;
  }

  window.addEventListener("resize", onWindowResize);
  resize();

  return {
    THREE,
    renderer,
    scene,
    camera,
    composer,
    bloom,
    outputPass,
    resize,
    onWindowResize,
    resetCamera,
    centerOn,
    getViewRect,
    setBloomEnabled,
    disposeControls,
    driftStars,
    reducedMotion: reducedMotionSnap, // construction-time snapshot; AsteroidView battery pulses apply next match
    isContextLost: () => contextLost,
    // Live zoom factor (1 = fit-all, >1 = zoomed in).
    getZoom: () => zoom,
    // World units covered by one screen pixel at the current zoom — drives apparent-size
    // LOD so the default fit-all view shows seedlings on every map size.
    getWorldPerPixel: () =>
      (2 * baseHalfW) / zoom / (canvas.clientWidth || window.innerWidth),
  };
}
