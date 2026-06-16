# Bloomspace — Execution Plan

Derived from `docs/superpowers/specs/2026-06-16-bloomspace-design.md` (the spec is the
source of truth). This plan decomposes the 8 milestones into concrete, reviewable tasks
and pins the **Sim↔Render data contract** so sim and render can be built against a stable
interface.

Controller executes via `superpowers:subagent-driven-development`: one implementer
subagent per task, then spec-compliance review, then code-quality review, then commit.

---

## Ground rules (from spec + user CLAUDE.md)

- **Buildless vanilla ES modules.** No framework, no bundler. three.js + Web Awesome +
  Font Awesome Free are the only runtime deps, all **vendored + committed** under `Vendor/`.
- **PascalCase** for every new file and directory.
- **Hard sim/render split.** `Sim/*` is plain data + logic, no three.js import, runs at a
  fixed ~30 Hz timestep, deterministic, unit-testable headless under `node --test`.
  `Render/*` reads sim state each animation frame and interpolates; owns no game truth.
- **Seedlings = Structure-of-Arrays** typed arrays (no per-seedling object).
- **Combat/proximity = spatial grid** (near-O(n)).
- **Relative paths everywhere**, `<base>` from `document.baseURI`, `Index.html` +
  `.htaccess DirectoryIndex Index.html`, service worker with a bumped cache version.
- **Licensing-safe:** free/redistributable deps only; never a paid build, kit token, or
  license key. `Vendor/README.md` records exact versions + source URLs + license.
- Run **Prettier** on changed JS/HTML/CSS before each task is reported done.
- Dev-only tooling (`package.json` with `node --test`, prettier) is allowed but is **not**
  shipped to the server (rsync excludes it).

---

## Data contract (Sim ↔ Render) — STABLE INTERFACE

`Sim/World.js` owns and exports the world state. Both sim modules and render views read
this shape. Render must never mutate it.

```
Owners:        -1 = neutral, 0 = human player, 1..N = AI players
Seedling state (Uint8):  0 ORBIT, 1 TRANSIT, 2 COMBAT, 3 DEAD

World = {
  width, height,                 // map bounds (world units)
  tick,                          // integer sim tick counter
  rng(),                         // seeded deterministic PRNG -> [0,1)
  status,                        // 'playing' | 'won' | 'lost'
  players: [ { id, isAi, difficulty } ],

  asteroids: [ {                 // small count (dozens); plain objects OK
    id, x, y, radius,
    energyStat, strengthStat, speedStat,   // 0..100 "flower" stats
    owner,                       // -1 / 0 / 1..N
    energy,                      // stored energy (economy)
    trees: [ { type, level, growth, cooldown } ],   // type: 'seedling' | 'defense'
  } ],

  // Seedlings — Structure-of-Arrays, capacity-bounded typed arrays.
  seed: {
    count, capacity,
    x:Float32Array, y:Float32Array,          // world position
    px:Float32Array, py:Float32Array,        // previous-tick position (for render lerp)
    vx:Float32Array, vy:Float32Array,
    home:Int32Array,                         // asteroid id this seedling belongs to
    target:Int32Array,                       // -1 if orbiting home, else target asteroid id
    owner:Int8Array,
    energy:Float32Array,
    strength:Float32Array,
    orbitAngle:Float32Array,
    orbitRadius:Float32Array,
    state:Uint8Array,
  },
}
```

Lifecycle helpers on the sim side (exact names finalized in T2):
`World.create(config)`, `spawnSeedling(world, …) -> index`, `killSeedling(world, i)`
(swap-remove to keep arrays dense), `Sim.step(world, dt)` advances exactly one fixed tick.

The **game loop** (`Main.js`) runs a fixed-step accumulator: while `acc >= STEP` →
copy `x→px, y→py`, `Sim.step(world, STEP)`, `acc -= STEP`. Render each rAF with
`alpha = acc / STEP`; views draw `lerp(px, x, alpha)`.

---

## Tasks

- **T1 — Skeleton, vendored deps, PWA shell, game-loop harness.** `Index.html`
  (import map, `<base>` from `document.baseURI`, Web Awesome + FA + `Main.js`), `Main.js`
  (fixed-step sim accumulator + rAF render + interpolation alpha), `Game.js` (wires
  Sim+Render+Ui), `Render/Scene.js` (ortho camera, `EffectComposer`+`RenderPass`+
  `UnrealBloomPass`+`OutputPass`, resize), `Sw.js` service worker + `Manifest.webmanifest`
  with a cache-version constant, `.htaccess` (`DirectoryIndex Index.html`), `.gitignore`,
  `Vendor/` (three.module.js + needed jsm addons, Web Awesome free, FA Free) +
  `Vendor/README.md`, dev `package.json` (`type:module`, `node --test`, prettier).
  Proof-of-life: a single glowing instanced dot orbiting, proving bloom renders.
  Blocks everything.
- **T2 — Sim foundation.** `Sim/World.js` (state + SoA + spawn/kill), `Sim/MapGen.js`
  (seeded procedural asteroid layout + Energy/Strength/Speed stats; one home rock per
  player, rest neutral), `Sim/Seedlings.js` (orbiting around home, send N% to a target,
  transit, arrival → colonize empty rock / become its orbit). Headless unit tests for
  MapGen determinism, send math, colonization. Depends T1.
- **T3 — Render slice.** `Render/AsteroidView.js` (instanced asteroid bodies + stat
  "flower" rings + selection highlight), `Render/SeedlingView.js` (instanced points/
  sprites straight from SoA, interpolated), `Render/TreeView.js` (stub ok), `Render/Fx.js`
  (send/death/flower particles), `Render/Picking.js` (screen→world, asteroid hit-test,
  drag indicator). Visually proves sim/render split + the look. Depends T1, T2 contract.
- **T4 — Combat.** `Sim/Combat.js` — spatial grid bucketing, contact resolution by
  Strength/Energy, deaths via swap-remove, asteroid ownership flips to last side holding
  it. Headless tests for grid correctness + deterministic fight outcomes. Depends T2.
- **T5 — Economy & Trees.** `Sim/Economy.js` (asteroids hold/generate/spend energy),
  `Sim/Trees.js` (seedling trees: cost seedlings+energy, slow production, periodic
  flower→harvestable seeds; defense trees: stationary auto-attacking seedlings/mines).
  Headless tests for energy balance, production cadence, flowering. Depends T2, T4.
- **T6 — AI & win/lose.** `Sim/Ai.js` (configurable count + difficulty; expand to neutral
  rocks, defend owned, attack enemy), plus win-by-domination / lose-when-wiped resolution
  in the sim status field. Headless tests for AI decisions + win/lose detection. Depends
  T2–T5.
- **T7 — UI.** `Ui/*` Web Awesome HUD: start menu, skirmish setup dialog (map size,
  asteroid count, # AI, difficulty), asteroid info panel, **send-amount = percentage-of-
  orbiting slider**, pause/settings, win/lose screens, top-bar resource readouts, speed
  controls. Wires the input loop: click select → drag to target → % slider → release to
  dispatch. Depends T3, T6.
- **T8 — Polish & perf + deploy.** Viewport culling + LOD (asteroid-level aggregates below
  a zoom threshold), bloom tuning (half-res), settings quality toggle (bloom on/off +
  seedling cap), FX polish, final SW cache bump, rsync deploy doc/excludes. Depends all.

## Parallelism

The chain is mostly sequential (each milestone builds on the prior). The one clean
disjoint split is **T3 (Render/*) vs T4 (Sim/Combat.js)** once T2's contract exists —
these touch different directories and may be worktree-isolated and merged if it speeds
things up. Default is sequential to keep one clean commit history.

## Verification

- Sim tasks (T2, T4, T5, T6): `node --test` green is the bar before review.
- Render/UI tasks (T3, T7, T8): headless syntax/import check + a documented manual
  browser checklist (controller verifies in browser where possible; otherwise the manual
  checklist is recorded as the remaining verification).
