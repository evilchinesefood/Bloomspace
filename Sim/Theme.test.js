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
  const { getMotionPref, setMotionPref, reducedMotion, motionScalars } =
    await import(`../Render/Theme.js?t=${_n++}`);
  return { getMotionPref, setMotionPref, reducedMotion, motionScalars };
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
