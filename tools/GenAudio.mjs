// tools/GenAudio.mjs — procedurally synthesize the game's CC0 audio into Audio/.
// Everything here is generated from pure math (sine/noise/envelopes) — no sampled source
// material, so the output is public-domain (CC0), no attribution required. Run with
//   node tools/GenAudio.mjs
// to (re)build every WAV. The committed Audio/*.wav files ARE the shipped assets; this script
// just documents how they were made and lets us regenerate them deterministically.
//
// Format: mono, 22050 Hz, 16-bit PCM. SFX are short (<0.4s); the two ambient loops are a few
// seconds of low, seamless drift. Total payload stays tiny (a few hundred KB).
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SR = 22050;
const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "Audio",
);
mkdirSync(OUT, { recursive: true });

const TAU = Math.PI * 2;
const clamp = (v) => Math.max(-1, Math.min(1, v));

// Encode a Float32 [-1,1] mono buffer as a 16-bit PCM WAV. Loops are written without any fade
// at the seam (the loop bodies are designed to be seamless); SFX simply decay to silence.
function wav(samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits/sample
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    buf.writeInt16LE((clamp(samples[i]) * 32767) | 0, 44 + i * 2);
  return buf;
}

const alloc = (dur) => new Float32Array(Math.round(dur * SR));
// ADSR-ish: quick attack, exponential decay to silence by `dur`.
const decayEnv = (t, dur, attack = 0.004) =>
  t < attack ? t / attack : Math.exp(-((t - attack) / (dur * 0.36)));

// A deterministic LCG so regeneration is byte-stable across runs (no Math.random()).
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// --- SFX --------------------------------------------------------------------

// send — a short rising whoosh (filtered noise sweeping up + a faint pitch glide).
function send() {
  const dur = 0.34,
    out = alloc(dur),
    rand = rng(11);
  let lp = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR,
      p = t / dur;
    const noise = rand() * 2 - 1;
    lp += (noise - lp) * (0.05 + p * 0.35); // brightening low-pass
    const tone = Math.sin(TAU * (300 + 900 * p) * t) * 0.25;
    out[i] = (lp * 0.5 + tone) * decayEnv(t, dur) * 0.7;
  }
  return out;
}

// arrive/colonize — a soft two-note "claim" chime (perfect fifth, gentle).
function colonize() {
  const dur = 0.36,
    out = alloc(dur);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const a = Math.sin(TAU * 660 * t);
    const b = Math.sin(TAU * 990 * t) * 0.7;
    out[i] = (a + b) * decayEnv(t, dur, 0.006) * 0.35;
  }
  return out;
}

// capture — a brighter, more decisive claim chime (major third stack).
function capture() {
  const dur = 0.38,
    out = alloc(dur);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const s =
      Math.sin(TAU * 523 * t) +
      Math.sin(TAU * 659 * t) * 0.8 +
      Math.sin(TAU * 784 * t) * 0.6;
    out[i] = s * decayEnv(t, dur, 0.005) * 0.3;
  }
  return out;
}

// death — a short low noisy "puff" that drops in pitch.
function death() {
  const dur = 0.3,
    out = alloc(dur),
    rand = rng(7);
  let lp = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR,
      p = t / dur;
    const noise = rand() * 2 - 1;
    lp += (noise - lp) * (0.35 - p * 0.28); // darkening
    const tone = Math.sin(TAU * (160 - 80 * p) * t) * 0.4;
    out[i] = (lp * 0.6 + tone) * decayEnv(t, dur) * 0.6;
  }
  return out;
}

// combat — a tiny dry "tick" (reserved name; short click + blip).
function combat() {
  const dur = 0.12,
    out = alloc(dur),
    rand = rng(3);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const click = (rand() * 2 - 1) * Math.exp(-t / 0.01);
    const blip = Math.sin(TAU * 1200 * t) * Math.exp(-t / 0.04);
    out[i] = (click * 0.5 + blip * 0.4) * 0.6;
  }
  return out;
}

// plant — a warm "pluck" (plucked-string-ish: detuned sines under a fast decay).
function plant() {
  const dur = 0.3,
    out = alloc(dur);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const s =
      Math.sin(TAU * 392 * t) +
      Math.sin(TAU * 392 * 2.01 * t) * 0.4 +
      Math.sin(TAU * 392 * 3.02 * t) * 0.2;
    out[i] = s * decayEnv(t, dur, 0.003) * 0.3;
  }
  return out;
}

// fire — reserved bombardment shot (deep descending zap). No emitter yet, but ready.
function fire() {
  const dur = 0.4,
    out = alloc(dur),
    rand = rng(23);
  let lp = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR,
      p = t / dur;
    const sweep = Math.sin(TAU * (700 - 600 * p) * t) * 0.5;
    const noise = rand() * 2 - 1;
    lp += (noise - lp) * 0.25;
    out[i] = (sweep + lp * 0.3) * decayEnv(t, dur) * 0.6;
  }
  return out;
}

// win — a short ascending triad sting (C-E-G arpeggio into a held chord).
function win() {
  const dur = 0.9,
    out = alloc(dur);
  const notes = [523, 659, 784];
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    let s = 0;
    for (let k = 0; k < notes.length; k++) {
      const on = t > k * 0.1; // staggered entry → arpeggio feel
      if (on) s += Math.sin(TAU * notes[k] * t);
    }
    out[i] = s * decayEnv(t, dur, 0.01) * 0.22;
  }
  return out;
}

// lose — a short descending minor sting.
function lose() {
  const dur = 0.9,
    out = alloc(dur);
  const notes = [440, 370, 294];
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    let s = 0;
    for (let k = 0; k < notes.length; k++) {
      const on = t > k * 0.12;
      if (on) s += Math.sin(TAU * notes[k] * t);
    }
    out[i] = s * decayEnv(t, dur, 0.01) * 0.22;
  }
  return out;
}

// --- Ambient loops (seamless) ----------------------------------------------
// Built from sines whose frequencies are exact integer multiples of the loop's fundamental
// (1/dur), so the waveform is periodic over `dur` and loops without a click. Low + slow.
function ambientLoop(dur, partials, seed, amp) {
  const out = alloc(dur);
  const f0 = 1 / dur; // loop fundamental
  const rand = rng(seed);
  // Pick partial phases up front so each render is deterministic.
  const phases = partials.map(() => rand() * TAU);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    let s = 0;
    for (let k = 0; k < partials.length; k++) {
      const [mult, gain] = partials[k];
      // Slow amplitude breathing, also integer-periodic over the loop → still seamless.
      const lfo = 0.7 + 0.3 * Math.sin(TAU * f0 * (k + 1) * t);
      s += Math.sin(TAU * f0 * mult * t + phases[k]) * gain * lfo;
    }
    out[i] = s * amp;
  }
  return out;
}

// ambient-deep — a calm low drone bed (a slow minor-ish cluster). 4s loop.
function ambientDeep() {
  // multiples of 0.25 Hz fundamental → e.g. 55, 82.5, 110, 165 Hz region.
  return ambientLoop(
    4,
    [
      [220, 0.5], // 55 Hz
      [330, 0.32], // 82.5 Hz
      [440, 0.22], // 110 Hz
      [660, 0.12], // 165 Hz
      [884, 0.06], // ~221 Hz shimmer
    ],
    101,
    0.5,
  );
}

// ambient-shimmer — a higher, sparser pad to layer/alternate with the deep bed. 3s loop.
function ambientShimmer() {
  return ambientLoop(
    3,
    [
      [294, 0.34], // 98 Hz
      [441, 0.22], // 147 Hz
      [588, 0.16], // 196 Hz
      [882, 0.1], // 294 Hz
      [1176, 0.05], // 392 Hz
    ],
    202,
    0.45,
  );
}

const FILES = {
  "Send.wav": send,
  "Colonize.wav": colonize,
  "Capture.wav": capture,
  "Death.wav": death,
  "Combat.wav": combat,
  "Plant.wav": plant,
  "Fire.wav": fire,
  "Win.wav": win,
  "Lose.wav": lose,
  "AmbientDeep.wav": ambientDeep,
  "AmbientShimmer.wav": ambientShimmer,
};

let total = 0;
for (const [name, gen] of Object.entries(FILES)) {
  const data = wav(gen());
  writeFileSync(path.join(OUT, name), data);
  total += data.length;
  console.log(`  ${name.padEnd(20)} ${(data.length / 1024).toFixed(1)} KB`);
}
console.log(
  `Wrote ${Object.keys(FILES).length} files, ${(total / 1024).toFixed(1)} KB total → Audio/`,
);
