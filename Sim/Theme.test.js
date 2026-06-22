// Sim/Theme.test.js — headless tests for Render/Theme.js motion logic.
// Stubs globalThis.window and globalThis.localStorage so no browser is needed.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// --- stub helpers ---
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
}

function makeWindow(matches) {
  return { matchMedia: () => ({ matches }) };
}

// We need to re-import Theme fresh for each test so the module-level _load() sees our stubs.
// Node ESM caches modules, so we use a cache-busting query string.
let _n = 0;
async function freshTheme() {
  const mod = await import(`../Render/Theme.js?t=${_n++}`);
  return mod;
}

let _origWindow, _origLS;

beforeEach(() => {
  _origWindow = globalThis.window;
  _origLS = globalThis.localStorage;
});

afterEach(() => {
  if (_origWindow === undefined) delete globalThis.window;
  else globalThis.window = _origWindow;
  if (_origLS === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = _origLS;
});

// --- tests ---

test("default motionPref is auto", async () => {
  delete globalThis.window;
  delete globalThis.localStorage;
  const { getMotionPref } = await freshTheme();
  assert.equal(getMotionPref(), "auto");
});

test("reducedMotion: 'on' → true", async () => {
  globalThis.window = makeWindow(false);
  globalThis.localStorage = makeStorage();
  const { setMotionPref, reducedMotion } = await freshTheme();
  setMotionPref("on");
  assert.equal(reducedMotion(), true);
});

test("reducedMotion: 'off' → false even if OS says reduce", async () => {
  globalThis.window = makeWindow(true);
  globalThis.localStorage = makeStorage();
  const { setMotionPref, reducedMotion } = await freshTheme();
  setMotionPref("off");
  assert.equal(reducedMotion(), false);
});

test("reducedMotion: 'auto' follows OS matchMedia (true)", async () => {
  globalThis.window = makeWindow(true);
  globalThis.localStorage = makeStorage();
  const { setMotionPref, reducedMotion } = await freshTheme();
  setMotionPref("auto");
  assert.equal(reducedMotion(), true);
});

test("reducedMotion: 'auto' follows OS matchMedia (false)", async () => {
  globalThis.window = makeWindow(false);
  globalThis.localStorage = makeStorage();
  const { setMotionPref, reducedMotion } = await freshTheme();
  setMotionPref("auto");
  assert.equal(reducedMotion(), false);
});

test("reducedMotion: 'auto' with no window → false", async () => {
  delete globalThis.window;
  globalThis.localStorage = makeStorage();
  const { setMotionPref, reducedMotion } = await freshTheme();
  setMotionPref("auto");
  assert.equal(reducedMotion(), false);
});

test("motionScalars: reduced → 0.4/0.5/0.6", async () => {
  globalThis.window = makeWindow(false);
  globalThis.localStorage = makeStorage();
  const { setMotionPref, motionScalars } = await freshTheme();
  setMotionPref("on");
  assert.deepEqual(motionScalars(), { count: 0.4, speed: 0.5, life: 0.6 });
});

test("motionScalars: full → 1/1/1", async () => {
  globalThis.window = makeWindow(false);
  globalThis.localStorage = makeStorage();
  const { setMotionPref, motionScalars } = await freshTheme();
  setMotionPref("off");
  assert.deepEqual(motionScalars(), { count: 1, speed: 1, life: 1 });
});

test("setMotionPref persists and round-trips via storage", async () => {
  globalThis.window = makeWindow(false);
  const store = makeStorage();
  globalThis.localStorage = store;
  const { setMotionPref } = await freshTheme();
  setMotionPref("on");
  const blob = JSON.parse(store.getItem("bloomspace.theme"));
  assert.equal(blob.motion, "on");
});

test("setMotionPref: invalid value clamps to 'auto'", async () => {
  globalThis.window = makeWindow(false);
  globalThis.localStorage = makeStorage();
  const { setMotionPref, getMotionPref } = await freshTheme();
  setMotionPref("bogus");
  assert.equal(getMotionPref(), "auto");
});

test("_load reads persisted value on module init", async () => {
  globalThis.window = makeWindow(false);
  const store = makeStorage();
  store.setItem("bloomspace.theme", JSON.stringify({ motion: "off" }));
  globalThis.localStorage = store;
  const { getMotionPref } = await freshTheme();
  assert.equal(getMotionPref(), "off");
});

test("storage failure does not throw", async () => {
  globalThis.window = makeWindow(false);
  globalThis.localStorage = {
    getItem: () => {
      throw new Error("quota");
    },
    setItem: () => {
      throw new Error("quota");
    },
    removeItem: () => {
      throw new Error("quota");
    },
  };
  const { setMotionPref, getMotionPref } = await freshTheme();
  assert.doesNotThrow(() => setMotionPref("on"));
  assert.equal(getMotionPref(), "on"); // in-memory still updated
});

// --- Palette tests ---

test("default palette is 'default'", async () => {
  delete globalThis.window;
  delete globalThis.localStorage;
  const { getPalette } = await freshTheme();
  assert.equal(getPalette(), "default");
});

test("setPalette/getPalette round-trip", async () => {
  globalThis.window = makeWindow(false);
  globalThis.localStorage = makeStorage();
  const { setPalette, getPalette } = await freshTheme();
  setPalette("colorblind");
  assert.equal(getPalette(), "colorblind");
});

test("setPalette persists to storage", async () => {
  globalThis.window = makeWindow(false);
  const store = makeStorage();
  globalThis.localStorage = store;
  const { setPalette } = await freshTheme();
  setPalette("colorblind");
  const blob = JSON.parse(store.getItem("bloomspace.theme"));
  assert.equal(blob.palette, "colorblind");
});

test("setPalette clamps invalid value to 'default'", async () => {
  globalThis.window = makeWindow(false);
  globalThis.localStorage = makeStorage();
  const { setPalette, getPalette } = await freshTheme();
  setPalette("neon");
  assert.equal(getPalette(), "default");
});

test("_load restores palette from storage", async () => {
  globalThis.window = makeWindow(false);
  const store = makeStorage();
  store.setItem("bloomspace.theme", JSON.stringify({ palette: "colorblind" }));
  globalThis.localStorage = store;
  const { getPalette } = await freshTheme();
  assert.equal(getPalette(), "colorblind");
});

test("paletteColorHex: default palette neutral (owner -1)", async () => {
  globalThis.window = makeWindow(false);
  globalThis.localStorage = makeStorage();
  const { setPalette, paletteColorHex } = await freshTheme();
  setPalette("default");
  assert.equal(paletteColorHex(-1), 0x556070);
});

test("paletteColorHex: default palette player (owner 0)", async () => {
  globalThis.window = makeWindow(false);
  globalThis.localStorage = makeStorage();
  const { setPalette, paletteColorHex } = await freshTheme();
  setPalette("default");
  assert.equal(paletteColorHex(0), 0x46e8ff);
});

test("paletteColorHex: default palette first AI (owner 1)", async () => {
  globalThis.window = makeWindow(false);
  globalThis.localStorage = makeStorage();
  const { setPalette, paletteColorHex } = await freshTheme();
  setPalette("default");
  assert.equal(paletteColorHex(1), 0xff5a7a);
});

test("paletteColorHex: colorblind palette player (owner 0)", async () => {
  globalThis.window = makeWindow(false);
  globalThis.localStorage = makeStorage();
  const { setPalette, paletteColorHex } = await freshTheme();
  setPalette("colorblind");
  assert.equal(paletteColorHex(0), 0x56b4e9);
});

test("paletteColorHex: colorblind palette first AI (owner 1)", async () => {
  globalThis.window = makeWindow(false);
  globalThis.localStorage = makeStorage();
  const { setPalette, paletteColorHex } = await freshTheme();
  setPalette("colorblind");
  assert.equal(paletteColorHex(1), 0xe69f00);
});

test("paletteColorHex: AI wraps by index (owner 7 = owner 1)", async () => {
  globalThis.window = makeWindow(false);
  globalThis.localStorage = makeStorage();
  const { setPalette, paletteColorHex } = await freshTheme();
  setPalette("default");
  assert.equal(paletteColorHex(7), paletteColorHex(1));
});

test("paletteColorHex switches live when palette changes", async () => {
  globalThis.window = makeWindow(false);
  globalThis.localStorage = makeStorage();
  const { setPalette, paletteColorHex } = await freshTheme();
  setPalette("default");
  const def = paletteColorHex(0);
  setPalette("colorblind");
  const cb = paletteColorHex(0);
  assert.notEqual(def, cb);
  assert.equal(cb, 0x56b4e9);
});

// --- Tags tests ---

test("default tags is false", async () => {
  delete globalThis.window;
  delete globalThis.localStorage;
  const { getTags } = await freshTheme();
  assert.equal(getTags(), false);
});

test("setTags/getTags round-trip", async () => {
  globalThis.window = makeWindow(false);
  globalThis.localStorage = makeStorage();
  const { setTags, getTags } = await freshTheme();
  setTags(true);
  assert.equal(getTags(), true);
  setTags(false);
  assert.equal(getTags(), false);
});

test("setTags persists to storage", async () => {
  globalThis.window = makeWindow(false);
  const store = makeStorage();
  globalThis.localStorage = store;
  const { setTags } = await freshTheme();
  setTags(true);
  const blob = JSON.parse(store.getItem("bloomspace.theme"));
  assert.equal(blob.tags, true);
});

test("_load restores tags from storage", async () => {
  globalThis.window = makeWindow(false);
  const store = makeStorage();
  store.setItem("bloomspace.theme", JSON.stringify({ tags: true }));
  globalThis.localStorage = store;
  const { getTags } = await freshTheme();
  assert.equal(getTags(), true);
});

// --- ownerShape tests ---

test("ownerShape: neutral (owner -1) → 'dot'", async () => {
  delete globalThis.localStorage;
  const { ownerShape } = await freshTheme();
  assert.equal(ownerShape(-1), "dot");
});

test("ownerShape: player (owner 0) → 'circle'", async () => {
  delete globalThis.localStorage;
  const { ownerShape } = await freshTheme();
  assert.equal(ownerShape(0), "circle");
});

test("ownerShape: AI owners map to distinct shapes", async () => {
  delete globalThis.localStorage;
  const { ownerShape } = await freshTheme();
  assert.equal(ownerShape(1), "square");
  assert.equal(ownerShape(2), "triangle");
  assert.equal(ownerShape(3), "diamond");
  assert.equal(ownerShape(4), "star");
  assert.equal(ownerShape(5), "cross");
  assert.equal(ownerShape(6), "hexagon");
});

test("ownerShape wraps for AI beyond 6", async () => {
  delete globalThis.localStorage;
  const { ownerShape } = await freshTheme();
  assert.equal(ownerShape(7), ownerShape(1));
});
