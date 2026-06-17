// Ui/Persist.js — thin UI-side persistence layer over the pure Sim/Save.js core. Keeps the
// Sim layer free of localStorage/DOM: this wraps serialize/deserialize with guarded storage
// access (the same try/catch pattern App.js uses for bloomspace.quality). Every entry point is
// no-throw — quota, private-mode, corrupt, or truncated saves degrade to a no-op / null, never
// an exception that would break the menu render or an autosave frame.
import { serialize, deserialize, SAVE_VERSION } from "../Sim/Save.js";

export const SAVE_KEY = "bloomspace.save";

// writeSave — serialize the live world → JSON string → localStorage. No-op on any failure
// (storage blocked / quota exceeded). Never throws into the game loop or visibility handler.
export function writeSave(world) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(serialize(world)));
  } catch {
    /* storage blocked / quota / serialize edge — autosave is best-effort, drop it */
  }
}

// readSave — read + JSON.parse + deserialize into a live, resumable world. Returns null on any
// failure: missing key, malformed JSON, wrong/old schema (deserialize → null), OR a truncated
// save whose oversized field array makes deserialize throw (8a documents this) — caught here.
export function readSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    return deserialize(JSON.parse(raw));
  } catch {
    return null;
  }
}

// hasSave — a cheap "is there a resumable in-progress match?" probe for the menu render. Parses
// + checks version and an in-progress status WITHOUT a full SoA/world rebuild. A finished match
// (won/lost/draw) is intentionally NOT resumable, so it reads as no-save.
export function hasSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const o = JSON.parse(raw);
    return o && o.version === SAVE_VERSION && o.status === "playing";
  } catch {
    return false;
  }
}

// clearSave — drop the save (after a match ends, or when starting a brand-new skirmish). Guarded.
export function clearSave() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* storage blocked — nothing to clear */
  }
}

export default { SAVE_KEY, writeSave, readSave, hasSave, clearSave };
