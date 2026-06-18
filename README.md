# Bloomspace

A [Eufloria](https://en.wikipedia.org/wiki/Eufloria)-style real-time strategy game. Colonize
a field of asteroids with glowing orbiting seedlings, grow trees that produce more seedlings,
and fight AI opponents for control of the whole map.

**Play: https://dev.jdayers.com/bloomspace/**

Built as a buildless, vanilla ES-module PWA — no bundler, no framework, no build step. Rendered
with [three.js](https://threejs.org) (instanced + bloom); chrome is [Web Awesome](https://webawesome.com)
+ Font Awesome Free. A fresh `git clone` runs offline, installs as a PWA, and respects
`prefers-reduced-motion` (the bloom, pulses, and beam flicker hold still).

## Play

- **Select** one of your asteroids (click it).
- **Send seedlings** — drag from your asteroid to a target. The **send-amount slider** (top of
  the info panel) sets what percentage of that rock's orbiters go.
- Arriving seedlings **colonize** an empty asteroid or **fight** for an enemy one — the last side
  holding a rock owns it.
- **Grow** from the asteroid panel: a **Seedling Tree** (produces seedlings + flowers into
  harvestable seeds), a **Defense Tree** (musters stationary defenders), or a **Bombardment
  Battery** (charges, then fires on a target rock). All cost seeds + energy.
- **Rally** a rock so its new seedlings auto-launch to a chosen target, and **link** friendly rocks
  into supply lanes.
- **Upgrade** — spend seeds on **tech** (seedling strength / speed / energy regen) from the tech
  popover.
- **Win** by holding every asteroid (domination), eliminating all opponents, or leading when an
  optional time limit expires; **lose** if you're wiped out.
- The map carries **terrain**: resource-rich rocks, nebula zones, dense belts that force routing,
  black holes, and moons.
- Camera: **scroll** to zoom, **right/middle-drag** (or two-finger) to pan; the **minimap**
  click-to-pans. Top bar has pause + 1×/2×/3× speed and a settings popover (bloom toggle + a
  render-only seedling cap for low-end devices). Matches **autosave** — close the tab and **Resume**
  from the menu — and a guided **tutorial** covers the basics.

## Run locally

It's static — serve the repo root with any web server and open it:

```bash
python3 -m http.server 8000
# → http://localhost:8000/Index.html
```

(Opening `Index.html` via `file://` won't work — ES modules + the service worker need HTTP.)

## Architecture

A hard split between **simulation** and **rendering** — this is the central design choice. It
makes thousands of seedlings viable and the game logic testable without a browser.

- **`Sim/`** — plain data + logic, no three.js, no DOM. Runs on a fixed **~30 Hz** timestep, fully
  deterministic (all randomness flows through a seeded PRNG). Seedlings are stored as a
  Structure-of-Arrays of typed arrays (no per-unit objects); combat/proximity uses a spatial grid.
  Modules: `World`, `MapGen`, `Seedlings`, `Combat`, `Economy`, `Trees`, `Tech`, `Bombard`,
  `Moons`, `Ai`, `Save`.
- **`Render/`** — reads sim state each animation frame and **interpolates** between ticks; owns no
  game truth. Instanced draws (one call for all seedlings, one for asteroids), `UnrealBloomPass` at
  half-res, viewport culling + level-of-detail. Modules: `Scene`, `SeedlingView`, `AsteroidView`,
  `TreeView`, `Minimap`, `Fx`, `Picking`, `Glyphs`, `Palette`.
- **`Ui/`** — Web Awesome HUD, menus, skirmish setup, the tutorial, the input loop, sound, and
  localStorage persistence (autosave / Resume). The player only mutates the world through a small
  set of sim calls (send, plant, rally, link, fire, buy-tech) — `Render` and `Ui` never write sim
  state.
- **`Main.js`** drives a fixed-step accumulator loop; **`Game.js`** wires one match together;
  **`Ui/App.js`** owns the `MENU → SETUP → PLAYING → GAME OVER` lifecycle.

## Tests

The sim is pure data, so its rules are unit-tested headless with Node's built-in runner:

```bash
npm test   # node --test "Sim/**/*.test.js"
```

Rendering, bloom, picking, and input feel are verified in a browser.

## Dependencies & licensing

All third-party code is free, redistributable, and **vendored + committed** under `Vendor/`
(nothing paid, no kit token or license key):

- **three.js** — MIT
- **Web Awesome** (free build)
- **Font Awesome Free** — SIL OFL (fonts) / MIT (code)

See `Vendor/README.md` for exact versions and source URLs.

## Tech notes

Buildless ES modules with an import map; PascalCase files; relative paths + a `<base>` derived from
`document.baseURI` so it works deployed under a subpath; `Index.html` + `.htaccess DirectoryIndex`;
a service worker with a bumped cache version each deploy.
