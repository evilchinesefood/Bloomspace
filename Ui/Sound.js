// Ui/Sound.js — a small, non-authoritative WebAudio wrapper. It owns NO game truth: it only
// consumes events drained in Game.js render() and turns them into one-shot SFX, plus a looping
// ambient music bed. Two independent gain nodes (SFX / Music) make each toggleable on its own.
//
// Autoplay policy: browsers block an AudioContext until a user gesture. We create the context
// lazily and start it SUSPENDED; a one-shot window pointerdown/keydown resumes it (and starts
// music if Music is enabled). Nothing here ever throws — if audio can't start, the game runs
// silently. Buffers are fetched + decoded once, lazily, on first construction.
import { baseUrl } from "./Menus.js";

// name → file under Audio/. SFX are short one-shots; the two ambient clips loop as music.
const SFX_FILES = {
  send: "Send.wav",
  capture: "Capture.wav",
  death: "Death.wav",
  plant: "Plant.wav",
  fire: "Fire.wav", // bombardment — emitted by Sim/Bombard.js, played in Game.js render()
  win: "Win.wav",
  lose: "Lose.wav",
};
const MUSIC_FILES = ["AmbientDeep.wav", "AmbientShimmer.wav"];

// Per-sound polyphony cap PER DRAINED FRAME, so a big multi-death tick doesn't machine-gun the
// same sample. Also a tiny global min-interval per sound name as a second guard.
const MAX_PER_FRAME = 3;
const MIN_INTERVAL = 0.05; // seconds between two plays of the SAME sound

export function createSound() {
  let ctx = null;
  let sfxGain = null;
  let musicGain = null;
  const buffers = {}; // name → AudioBuffer (SFX)
  const musicBuffers = []; // decoded ambient loops
  let musicSource = null; // current looping BufferSource (null when stopped)

  // Default ENABLED; App.applyQuality() synchronously applies the real saved state (sfx/music)
  // via setSfxEnabled/setMusicEnabled right after construction — before any async gesture or
  // playback — mirroring how bloom/seedlingCap are applied (NOT via constructor config).
  let sfxEnabled = true;
  let musicEnabled = true;
  let resumed = false; // has a user gesture unlocked the context?
  let preloadPromise = null; // cached decode-all promise (so resume() can await it)

  // Per-frame + per-sound throttle bookkeeping.
  const frameCount = {}; // name → plays this drained frame
  const lastPlay = {}; // name → ctx.currentTime of last play

  function ensureContext() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch {
      return null; // some embedded webviews refuse — stay silent
    }
    sfxGain = ctx.createGain();
    musicGain = ctx.createGain();
    sfxGain.gain.value = sfxEnabled ? 0.9 : 0;
    musicGain.gain.value = musicEnabled ? 0.35 : 0;
    sfxGain.connect(ctx.destination);
    musicGain.connect(ctx.destination);
    return ctx;
  }

  async function fetchDecode(file) {
    const url = baseUrl("Audio/" + file);
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    // decodeAudioData is callback-or-promise depending on the browser; wrap both.
    return await new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(arr, resolve, reject);
      if (p && typeof p.then === "function") p.then(resolve, reject);
    });
  }

  // Lazily fetch + decode every clip. Caches its promise so repeated calls share one decode
  // pass and callers can await completion (resume() waits on it before starting music). Never
  // throws — individual failures are logged and skipped.
  function preload() {
    if (preloadPromise) return preloadPromise;
    if (!ensureContext()) return Promise.resolve();
    const jobs = [];
    for (const [name, file] of Object.entries(SFX_FILES)) {
      jobs.push(
        fetchDecode(file)
          .then((b) => (buffers[name] = b))
          .catch((e) => console.warn("audio decode failed:", file, e)),
      );
    }
    for (const file of MUSIC_FILES) {
      jobs.push(
        fetchDecode(file)
          .then((b) => musicBuffers.push(b))
          .catch((e) => console.warn("music decode failed:", file, e)),
      );
    }
    preloadPromise = Promise.allSettled(jobs);
    return preloadPromise;
  }

  // Fire a one-shot SFX. Skips silently when SFX is off, the context isn't unlocked, the
  // buffer hasn't decoded yet, or the per-frame / min-interval throttle trips.
  function play(name) {
    if (!sfxEnabled || !ctx || ctx.state !== "running") return;
    const buf = buffers[name];
    if (!buf) return;
    const now = ctx.currentTime;
    if ((frameCount[name] || 0) >= MAX_PER_FRAME) return;
    if (lastPlay[name] != null && now - lastPlay[name] < MIN_INTERVAL) return;
    frameCount[name] = (frameCount[name] || 0) + 1;
    lastPlay[name] = now;
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(sfxGain);
      src.start();
    } catch {
      /* start() can throw if the context died — stay silent */
    }
  }

  // Reset the per-frame play counters. Called once per drained render frame (after the drain)
  // so MAX_PER_FRAME is a per-tick cap, not a lifetime cap.
  function endFrame() {
    for (const k in frameCount) frameCount[k] = 0;
  }

  function startMusic() {
    if (!ctx || ctx.state !== "running" || !musicEnabled) return;
    if (musicSource || musicBuffers.length === 0) return;
    try {
      const src = ctx.createBufferSource();
      // Concatenation-free "playlist": just loop the deep bed; the shimmer buffer is decoded
      // and available for future layering, but one seamless loop keeps CPU + complexity low.
      src.buffer = musicBuffers[0];
      src.loop = true;
      src.connect(musicGain);
      src.start();
      musicSource = src;
    } catch {
      /* ignore */
    }
  }

  function stopMusic() {
    if (!musicSource) return;
    try {
      musicSource.stop();
    } catch {
      /* already stopped */
    }
    musicSource = null;
  }

  // First user gesture: unlock the context, then start music if it's enabled. Registered as a
  // ONE-SHOT capture listener (removed after it fires once).
  function onFirstGesture() {
    window.removeEventListener("pointerdown", onFirstGesture, true);
    window.removeEventListener("keydown", onFirstGesture, true);
    resume();
  }
  function armGesture() {
    window.addEventListener("pointerdown", onFirstGesture, true);
    window.addEventListener("keydown", onFirstGesture, true);
  }

  // Resume the (suspended) context and kick music. Idempotent; never throws. Music start waits
  // on BOTH the resume AND the decode (whichever finishes last) so it never bails on an
  // empty buffer list when the gesture beats the fetch.
  function resume() {
    if (!ensureContext()) return;
    const decodeDone = preload();
    const after = () => {
      resumed = true;
      if (musicEnabled) decodeDone.then(startMusic);
    };
    try {
      const p = ctx.resume();
      if (p && typeof p.then === "function") p.then(after, () => {});
      else after();
    } catch {
      /* ignore */
    }
  }

  function setSfxEnabled(on) {
    sfxEnabled = !!on;
    if (sfxGain) sfxGain.gain.value = sfxEnabled ? 0.9 : 0;
  }
  function setMusicEnabled(on) {
    musicEnabled = !!on;
    if (musicGain) musicGain.gain.value = musicEnabled ? 0.35 : 0;
    // Only (re)start the loop once the context is actually unlocked; otherwise the gesture's
    // resume() will start it. Wait on decode so a toggle before buffers load still works.
    if (musicEnabled) {
      if (resumed) preload().then(startMusic);
    } else stopMusic();
  }

  // Test/inspection hooks for browser verification (read current gain values + state).
  function debug() {
    return {
      hasCtx: !!ctx,
      state: ctx ? ctx.state : "none",
      resumed,
      sfxGain: sfxGain ? sfxGain.gain.value : null,
      musicGain: musicGain ? musicGain.gain.value : null,
      musicPlaying: !!musicSource,
      sfxLoaded: Object.keys(buffers).length,
      musicLoaded: musicBuffers.length,
    };
  }

  function destroy() {
    window.removeEventListener("pointerdown", onFirstGesture, true);
    window.removeEventListener("keydown", onFirstGesture, true);
    stopMusic();
    if (ctx) {
      try {
        ctx.close();
      } catch {
        /* ignore */
      }
      ctx = null;
    }
  }

  // Build the context up front (suspended) + arm the unlock gesture. Decode begins now too so
  // buffers are ready the instant the context resumes.
  ensureContext();
  preload();
  armGesture();

  return {
    play,
    endFrame,
    resume,
    setSfxEnabled,
    setMusicEnabled,
    startMusic,
    stopMusic,
    debug,
    destroy,
  };
}
