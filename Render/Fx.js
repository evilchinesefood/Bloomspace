// Render/Fx.js — particle FX scaffolding. One THREE.Points system over a fixed pool;
// particles recycle, so there is no per-spawn allocation in steady state. spawnSend is
// the working burst; spawnDeath/spawnFlower reuse the same pool with their own tuning.
import * as THREE from "three";

const POOL = 1024; // max simultaneous particles
const TAU = Math.PI * 2;

// prefers-reduced-motion: damp the particle bursts (fewer particles, slower, shorter-lived)
// so the decorative FX don't fling motion across the screen for motion-sensitive players.
const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// `world` is unused today; kept for create*(scene, world) symmetry with the other views.
export function createFx(scene, world) {
  const reduced = prefersReducedMotion();
  // Scale factors applied to every burst when reduced-motion is on.
  const COUNT_K = reduced ? 0.4 : 1; // fewer particles
  const SPEED_K = reduced ? 0.5 : 1; // slower spread
  const LIFE_K = reduced ? 0.6 : 1; // shorter-lived
  const pos = new Float32Array(POOL * 3);
  const colArr = new Float32Array(POOL * 3); // displayed color (faded)
  const baseCol = new Float32Array(POOL * 3); // full-brightness source color
  // Per-particle state (parallel arrays, no per-spawn objects).
  const vx = new Float32Array(POOL);
  const vy = new Float32Array(POOL);
  const life = new Float32Array(POOL); // remaining seconds
  const ttl = new Float32Array(POOL); // initial life (for fade)
  let head = 0; // ring cursor for recycling

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colArr, 3));
  // Both attributes are rewritten every frame — hint the driver.
  geo.getAttribute("position").setUsage(THREE.DynamicDrawUsage);
  geo.getAttribute("color").setUsage(THREE.DynamicDrawUsage);
  geo.setDrawRange(0, POOL);

  const mat = new THREE.PointsMaterial({
    size: 9,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);

  const tmp = new THREE.Color();

  function emit(x, y, dirx, diry, speed, ttlSec, hex) {
    const i = head;
    head = (head + 1) % POOL;
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = 1;
    vx[i] = dirx * speed;
    vy[i] = diry * speed;
    life[i] = ttlSec;
    ttl[i] = ttlSec;
    tmp.setHex(hex);
    baseCol[i * 3] = colArr[i * 3] = tmp.r;
    baseCol[i * 3 + 1] = colArr[i * 3 + 1] = tmp.g;
    baseCol[i * 3 + 2] = colArr[i * 3 + 2] = tmp.b;
  }

  // Outward ring burst when seedlings are dispatched.
  function spawnSend(x, y, hex = 0x46e8ff) {
    const count = Math.max(4, Math.round(18 * COUNT_K));
    for (let k = 0; k < count; k++) {
      const a = (k / count) * TAU;
      const sp = (90 + Math.random() * 60) * SPEED_K;
      emit(x, y, Math.cos(a), Math.sin(a), sp, 0.6 * LIFE_K, hex);
    }
  }

  // Fast scatter on death.
  function spawnDeath(x, y, hex = 0xff5a5a) {
    const count = Math.max(4, Math.round(10 * COUNT_K));
    for (let k = 0; k < count; k++) {
      const a = Math.random() * TAU;
      const sp = (60 + Math.random() * 80) * SPEED_K;
      emit(x, y, Math.cos(a), Math.sin(a), sp, 0.5 * LIFE_K, hex);
    }
  }

  // Gentle upward-ish bloom when a tree flowers.
  function spawnFlower(x, y, hex = 0xffe27a) {
    const count = Math.max(4, Math.round(14 * COUNT_K));
    for (let k = 0; k < count; k++) {
      const a = Math.random() * TAU;
      const sp = (20 + Math.random() * 40) * SPEED_K;
      emit(x, y, Math.cos(a), Math.sin(a), sp, 1.0 * LIFE_K, hex);
    }
  }

  // Age + recycle. Dead particles drop to black so they stop contributing to bloom.
  function update(dt) {
    for (let i = 0; i < POOL; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      const c3 = i * 3;
      if (life[i] <= 0) {
        colArr[c3] = colArr[c3 + 1] = colArr[c3 + 2] = 0;
        continue;
      }
      pos[c3] += vx[i] * dt;
      pos[c3 + 1] += vy[i] * dt;
      const f = life[i] / ttl[i]; // 1 -> 0 fade against the stored base color
      colArr[c3] = baseCol[c3] * f;
      colArr[c3 + 1] = baseCol[c3 + 1] * f;
      colArr[c3 + 2] = baseCol[c3 + 2] * f;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }

  return { points, spawnSend, spawnDeath, spawnFlower, update };
}
