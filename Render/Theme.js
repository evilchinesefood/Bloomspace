// Render/Theme.js — single source of truth for motion, palette, and colorblind-tag prefs.
// Headless-safe: all window/matchMedia/localStorage/document access is guarded.

const STORAGE_KEY = "bloomspace.theme";
const VALID_MOTION = ["auto", "on", "off"];
const VALID_PALETTE = ["default", "colorblind"];

// Named palettes (hex ints). default = vivid originals; colorblind = Okabe-Ito–derived CVD-safe.
const PALETTES = {
  default: {
    neutral: 0x556070,
    player: 0x46e8ff,
    ai: [0xff5a7a, 0x8a7bff, 0xffc24b, 0x5dff9b, 0xff8a3d, 0xff6bff],
  },
  colorblind: {
    neutral: 0x9aa0a8,
    player: 0x56b4e9,
    ai: [0xe69f00, 0xd55e00, 0xcc79a7, 0x009e73, 0xf0e442, 0x0072b2],
  },
};

// Shape ids for per-owner minimap tags (owner < 0 → dot, 0 → circle, 1..6 → ai shapes).
const AI_SHAPES = ["square", "triangle", "diamond", "star", "cross", "hexagon"];

let _motion = "auto";
let _palette = "default";
let _tags = false;

function _load() {
  if (typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (!obj) return;
    if (VALID_MOTION.includes(obj.motion)) _motion = obj.motion;
    if (VALID_PALETTE.includes(obj.palette)) _palette = obj.palette;
    if (typeof obj.tags === "boolean") _tags = obj.tags;
  } catch {
    /* quota / private-mode / corrupt — stay at defaults */
  }
}

function _save() {
  if (typeof localStorage === "undefined") return;
  try {
    const existing = (() => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
      } catch {
        return {};
      }
    })();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...existing,
        motion: _motion,
        palette: _palette,
        tags: _tags,
      }),
    );
  } catch {
    /* quota / private-mode — in-memory only */
  }
}

// init
_load();

export function getMotionPref() {
  return _motion;
}

export function setMotionPref(pref) {
  _motion = VALID_MOTION.includes(pref) ? pref : "auto";
  _save();
}

export function reducedMotion() {
  if (_motion === "on") return true;
  if (_motion === "off") return false;
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function motionScalars() {
  return reducedMotion()
    ? { count: 0.4, speed: 0.5, life: 0.6 }
    : { count: 1, speed: 1, life: 1 };
}

export function getPalette() {
  return _palette;
}

export function setPalette(name) {
  _palette = VALID_PALETTE.includes(name) ? name : "default";
  _save();
}

// Returns the hex int for `owner` from the active palette.
// owner < 0 → neutral; 0 → player; else ai[(owner-1) % ai.length].
export function paletteColorHex(owner) {
  const p = PALETTES[_palette];
  if (owner < 0) return p.neutral;
  if (owner === 0) return p.player;
  return p.ai[(owner - 1) % p.ai.length];
}

export function getTags() {
  return _tags;
}

export function setTags(val) {
  _tags = !!val;
  _save();
}

// Returns a stable shape id string for minimap non-color tagging.
export function ownerShape(owner) {
  if (owner < 0) return "dot";
  if (owner === 0) return "circle";
  return AI_SHAPES[(owner - 1) % AI_SHAPES.length];
}
