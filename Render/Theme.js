// Render/Theme.js — single source of truth for the reduce-motion preference.
// Headless-safe: all window/matchMedia/localStorage/document access is guarded.
// Step 2 will add palette + glyph keys to the same storage blob.

const STORAGE_KEY = "bloomspace.theme";
const VALID = ["auto", "on", "off"];

let _motion = "auto"; // in-memory cache

function _load() {
  if (typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && VALID.includes(obj.motion)) _motion = obj.motion;
  } catch {
    /* quota / private-mode / corrupt — stay at default */
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
      JSON.stringify({ ...existing, motion: _motion }),
    );
  } catch {
    /* quota / private-mode — in-memory only */
  }
}

_load();

export function getMotionPref() {
  return _motion;
}

export function setMotionPref(pref) {
  _motion = VALID.includes(pref) ? pref : "auto";
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
