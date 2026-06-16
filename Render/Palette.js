// Render/Palette.js — single shared owner→color palette so all views agree.
// owner: -1 neutral (dim gray), 0 human, 1..N AI. Returns a hex int.
import * as THREE from "three";

const NEUTRAL = 0x556070;
const PLAYER = 0x46e8ff; // human: cyan
const AI = [
  0xff5a7a, // red/pink
  0x8a7bff, // violet
  0xffc24b, // amber
  0x5dff9b, // green
  0xff8a3d, // orange
  0xff6bff, // magenta
];

export function ownerColorHex(owner) {
  if (owner < 0) return NEUTRAL;
  if (owner === 0) return PLAYER;
  return AI[(owner - 1) % AI.length];
}

// Fill a reused THREE.Color (no allocation in hot paths).
export function ownerColor(out, owner) {
  return out.setHex(ownerColorHex(owner));
}

export const COLOR = { NEUTRAL, PLAYER, AI };

export function makeColor(owner) {
  return new THREE.Color(ownerColorHex(owner));
}
