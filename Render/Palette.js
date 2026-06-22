// Render/Palette.js — single shared owner→color palette so all views agree.
// Delegates color data to Theme.js so palette switches apply live with no call-site edits.
import * as THREE from "three";
import { paletteColorHex } from "./Theme.js";

// Default-palette consts for static exports (COLOR).
const NEUTRAL = 0x556070;
const PLAYER = 0x46e8ff;
const AI = [0xff5a7a, 0x8a7bff, 0xffc24b, 0x5dff9b, 0xff8a3d, 0xff6bff];

export function ownerColorHex(owner) {
  return paletteColorHex(owner);
}

// Fill a reused THREE.Color (no allocation in hot paths).
export function ownerColor(out, owner) {
  return out.setHex(ownerColorHex(owner));
}

export const COLOR = { NEUTRAL, PLAYER, AI };

export function makeColor(owner) {
  return new THREE.Color(ownerColorHex(owner));
}
