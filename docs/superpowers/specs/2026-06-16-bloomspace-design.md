# Bloomspace — Design Spec

**Date:** 2026-06-16
**Repo (planned):** `evilchinesefood/Bloomspace`, master-only
**Local:** `C:\Users\evilc\Github\Bloomspace`
**Live (planned):** `https://dev.jdayers.com/bloomspace/`

A Eufloria-style real-time strategy game: colonize a field of asteroids with glowing
orbiting seedlings, grow trees that produce more seedlings, fight an AI opponent for
control of the whole map. Built buildless (vanilla ES modules), rendered with three.js,
chrome built with Web Awesome + Font Awesome Free.

References: Eufloria — https://en.wikipedia.org/wiki/Eufloria

---

## 1. Locked decisions

| Decision | Choice |
|---|---|
| Fidelity | Faithful clone of Eufloria's core loop |
| Presentation | Flat top-down, orthographic camera, bloom/glow |
| Renderer | three.js (WebGL): instanced rendering + `UnrealBloomPass` |
| First mode | Skirmish (procedural maps, configurable AI), no campaign yet |
| Dependencies | Free/redistributable only, vendored and committed; nothing paid or secret |
| Distribution | Buildless ES-module PWA, PascalCase files, rsync to dev.jdayers.com |

---

## 2. Scope — v1 mechanics

**In:**
- **Asteroids** with per-rock stats — Energy / Strength / Speed (shown as a "flower" stat
  ring). Seedlings grown on a rock inherit its stats.
- **Seedlings** — units that orbit their home asteroid. Player selects an asteroid and
  sends a chosen number to a target; on arrival they colonize (empty) or fight (enemy).
- **Combat** — seedlings auto-fight on contact; resolved by Strength/Energy. Last side
  holding the asteroid owns it.
- **Seedling Trees** — cost seedlings + energy; slowly produce new seedlings and
  periodically **flower → seeds** the player harvests to grow more trees.
- **Defense Trees** — produce stationary defensive seedlings / mines that auto-attack
  intruders.
- **Energy economy** — asteroids hold energy; growing trees/seedlings spends it, trees
  generate it.
- **AI opponent(s)** — expand, defend, attack; configurable count and difficulty.
- **Skirmish setup** — map size, asteroid count, # of AI, difficulty.
- **Win/lose** — win by holding every asteroid; lose if wiped out.

**Deferred (later milestones):**
- Fog of war / exploration (dark unexplored map revealed by sending seedlings).
- Asteroid stat upgrading (spend seedlings to raise a rock's stats over time).
- Exotic trees beyond the two core types (e.g. Dyson tree).
- Campaign / authored levels / narrative; save & resume of an in-progress match.

---

## 3. Architecture

**Hard split between simulation and rendering.** This is the central design choice — it
makes thousands of seedlings viable and the game logic testable without a browser.

- **Sim** — plain data + logic, no three.js. Runs on a **fixed timestep (~30 Hz)** so
  combat and economy are deterministic and frame-rate independent.
- **Renderer** — reads sim state every animation frame and pushes it into three.js. It
  owns no game truth. Render **interpolates** between sim ticks so motion stays smooth
  when frame rate ≠ sim rate.

**Seedlings as Structure-of-Arrays.** No per-seedling object. Parallel typed arrays
(`x`, `y`, `vx`, `vy`, `homeAsteroid`, `owner`, `energy`, `state`, …). Thousands stay
cache-friendly and feed three.js instance buffers with no per-unit allocation.

**Combat/proximity via spatial grid.** Bucket seedlings into grid cells so contact
checks stay near-O(n) rather than O(n²).

### Module layout
```
Index.html              shell: import map, Web Awesome, Font Awesome, Main.js
Main.js                 bootstrap + game loop (fixed-step sim, rAF render)
Game.js                 wires Sim + Render + Ui together
Sim/
  World.js              all game state (asteroids, seedling arrays, trees, players)
  MapGen.js             procedural asteroid layout + stats
  Seedlings.js          orbiting, movement, sending
  Combat.js             contact resolution (spatial grid)
  Trees.js              growth, seedling production, flowering/seeds
  Economy.js            energy generation / spend
  Ai.js                 opponent decision-making
Render/
  Scene.js              three setup: ortho camera, EffectComposer + UnrealBloomPass
  SeedlingView.js       instanced points/sprites from SoA arrays
  AsteroidView.js       asteroid bodies + stat "flower" rings
  TreeView.js           tree meshes + flower FX
  Picking.js            screen→world mapping, asteroid hit-testing
  Fx.js                 particles (deaths, flowers, sends)
Ui/                     Web Awesome HUD, menus, asteroid panel, input handling
Vendor/                 committed third-party libs (see §5)
```

---

## 4. UI & input

**DOM-over-canvas.** The three.js canvas is full-screen behind a transparent HTML layer
of Web Awesome components. UI chrome is HTML/CSS, not rebuilt in WebGL.

- **three.js** draws the world only: asteroids, seedlings, trees, FX, bloom.
- **Web Awesome** draws all chrome: start menu, skirmish setup dialog, pause/settings,
  win/lose screens, asteroid info panel, the "send seedlings" amount slider, top-bar
  resource readouts, speed controls.
- **Font Awesome (Free)** supplies icons within that chrome.
- Drawn *in* the world (not DOM): asteroid stat "flower" ring, selection highlight, and
  the drag indicator while sending seedlings.

**Core input loop:** click an asteroid to select → drag to a target asteroid (or click
target) → a slider/percentage sets how many seedlings to send → release to dispatch.

---

## 5. Dependencies & licensing (the licensing-safe contract)

All third-party code is **free, redistributable, and committed** to the repo. Nothing
paid, no license key, no account/kit token is ever introduced — so none can leak.

```
Vendor/
  three/         three.module.js + jsm/ (EffectComposer, UnrealBloomPass, …)  — MIT
  webawesome/    free build (CSS + JS)
  fontawesome/   Free SVG / webfonts only                                     — SIL OFL / MIT
  README.md      exact versions + source URLs + license per dependency
```

- `Index.html` uses an **import map** so bare specifiers (`three`, etc.) resolve to the
  vendored files. Buildless; no npm at runtime; a fresh `git clone` runs offline.
- `.gitignore` blocks `node_modules/`, `.superpowers/`, `*.local`, and OS cruft — belt
  and suspenders on top of "nothing paid ever enters the tree."
- **Explicitly excluded:** Font Awesome Pro, any FA kit `<script>`, Web Awesome Pro,
  license tokens. If a Pro icon is ever wanted, that's a separate decision with a
  gitignore + setup-step approach — not part of v1.

---

## 6. Performance budget

- **Instanced rendering** — one draw call for all seedlings, one for asteroids, one for
  trees. SoA arrays copy straight into instance buffers each frame.
- **Fixed-step sim @ ~30 Hz**, render at display rate with interpolation.
- **Spatial grid** for combat/proximity (near-O(n)).
- **Bloom** is the cost center: `UnrealBloomPass` at half-resolution, tuned
  threshold/strength. Settings expose a quality toggle (bloom on/off + seedling cap) as
  the escape hatch.
- **Viewport culling + LOD** — below a zoom threshold, skip individual seedling instances
  and draw asteroid-level aggregates (IdleKingdom playbook).
- **Target:** smooth at a few thousand seedlings on a mid laptop; degrade gracefully
  beyond.

---

## 7. PWA & deployment

- Manifest + service worker; **cache version bumped every deploy**.
- **Relative paths everywhere** + `<base>` derived from `document.baseURI` so it works
  under a subpath.
- `Index.html` (PascalCase) + `.htaccess` with `DirectoryIndex Index.html`.
- Repo `evilchinesefood/Bloomspace`, master-only.
- Deploy = one rsync of repo root → `.../dev.jdayers.com/bloomspace/`, excluding
  dev-only files. Live at `https://dev.jdayers.com/bloomspace/`.
- Optional later: Dev Labs thumbnail on jdayers.com (gem-hexagon pattern).

---

## 8. Testing & verification

- Sim modules (Combat, Economy, Trees, MapGen, Ai) are pure-data and testable headless —
  unit-test the rules without a browser.
- Manual/browser verification for render, bloom, picking, input feel, and the full
  skirmish loop (colonize → grow → fight → win/lose).

---

## 9. Build milestones (high level — detailed plan to follow)

1. **Skeleton** — buildless shell, import map, vendored deps, three.js scene with
   ortho camera + bloom, render loop.
2. **Render slice** — one asteroid with orbiting instanced seedlings + bloom, proving the
   sim/render split and the look.
3. **Core sim** — World/MapGen, multiple asteroids, sending + orbiting, colonization.
4. **Combat** — spatial grid, contact resolution, ownership flips.
5. **Economy & trees** — energy, seedling trees, flowering/seeds, defense trees.
6. **AI** — opponent expand/defend/attack; win/lose conditions.
7. **UI** — Web Awesome HUD, skirmish setup, asteroid panel, send slider, menus.
8. **Polish & perf** — culling/LOD, bloom tuning, FX, PWA + deploy.
