// Render/Fx.js — particle FX scaffolding. One THREE.Points system over a fixed pool;
// particles recycle, so there is no per-spawn allocation in steady state. spawnSend is
// the working burst; spawnDeath/spawnFlower reuse the same pool with their own tuning.
import * as THREE from "three";

const POOL = 1024; // max simultaneous particles
const TAU = Math.PI * 2;

export function createFx(scene, world) {
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
    const count = 18;
    for (let k = 0; k < count; k++) {
      const a = (k / count) * TAU;
      emit(x, y, Math.cos(a), Math.sin(a), 90 + Math.random() * 60, 0.6, hex);
    }
  }

  // Fast scatter on death.
  function spawnDeath(x, y, hex = 0xff5a5a) {
    const count = 10;
    for (let k = 0; k < count; k++) {
      const a = Math.random() * TAU;
      emit(x, y, Math.cos(a), Math.sin(a), 60 + Math.random() * 80, 0.5, hex);
    }
  }

  // Gentle upward-ish bloom when a tree flowers.
  function spawnFlower(x, y, hex = 0xffe27a) {
    const count = 14;
    for (let k = 0; k < count; k++) {
      const a = Math.random() * TAU;
      emit(x, y, Math.cos(a), Math.sin(a), 20 + Math.random() * 40, 1.0, hex);
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
