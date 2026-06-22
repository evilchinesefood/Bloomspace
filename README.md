<p align="center"><img src="bloomspace.png" width="170" alt="Bloomspace"></p>

# Bloomspace

A [Eufloria](https://en.wikipedia.org/wiki/Eufloria)-style real-time strategy game. Colonize
a field of asteroids with glowing orbiting seedlings, grow trees that produce more seedlings,
and fight AI opponents for control of the whole map.

**Play: https://dev.jdayers.com/bloomspace/**

Built as a buildless, vanilla ES-module PWA — no bundler, no framework, no build step. Rendered
with [three.js](https://threejs.org) (instanced + bloom); chrome is [Web Awesome](https://webawesome.com)
+ Font Awesome Free. A fresh `git clone` runs offline, installs as a PWA, and is accessibility-aware:
**colorblind-safe palettes** + non-color owner tags, and a **reduce-motion** mode (the bloom, pulses,
beam flicker, and flow dashes hold still) — both in the in-game settings, both honoring the OS preference.

## Play

- **Select** one of your asteroids (click it).
- **Send seedlings** — drag from your asteroid to a target. The **send-amount slider** (top of
  the info panel) sets what percentage of that rock's orbiters go.
- **Slingshot raid** — **shift-drag** instead: the fleet slings *past* the target (fighting its
  garrison during the arc, plus any bodies it chains through on the way) and returns home, rather than
  committing to capture it. Hit-and-run that bleeds defenders.
- Arriving seedlings **colonize** an empty asteroid or **fight** for an enemy one — the last side
  holding a rock owns it.
- **Grow** from the asteroid panel (all cost seeds + energy):
  - **Seedling Tree** — produces seedlings + flowers into harvestable seeds.
  - **Defense Tree** — musters stationary defenders.
  - **Bombardment Battery** — charges, then fires on a target rock.
  - **Symbiosis Tree** — once mature, emits an aura that buffs your *adjacent* rocks (energy regen,
    garrison strength, production).
- **Rally** a rock so its new seedlings auto-launch to a chosen target, and **link** friendly rocks
  into supply lanes.
- **Energy conduits** — pipe stored energy each tick from one of your rocks to another (build like a
  link); severed automatically if either end falls.
- **Retreat & Regroup** — arm a rock with a fallback; if it's outmatched after combat, its garrison
  flees there instead of dying in place.
- **Upgrade** — spend seeds on **tech** (seedling strength / speed / energy regen). At the top tier each
  track forks into a **Crossroads capstone** — a one-time choice that amplifies a multiplier or adds
  slingshot-raid damage.
- **Pause & Plan** — pause the sim, stage your orders (they show as ghost-route previews), then resume
  to execute them all at once. Plans survive **autosave**.
- **Threat / flow overlay** — hold **Q** to dim the field and see in-transit fleet routes as flow dashes
  plus a red/green contest tint on pressured bodies.
- **Alerts** — edge pings + an event ticker flag losses, bombardment, and incoming pressure; press
  **Space** to snap the camera to the latest alert.
- **Win** by holding every habitable asteroid (domination), eliminating all opponents, or leading when an
  optional time limit expires; **lose** if you're wiped out.
- The map carries **terrain**: resource-rich rocks, nebula zones, dense belts that force routing, black
  holes, moons, and optional **wormhole pairs** — a 1-hop shortcut across the map (contested if the far
  end is enemy-held).
- Camera: **scroll** to zoom, **right/middle-drag** (or two-finger) to pan; the **minimap** click-to-pans.
  Top bar has pause + 1×/2×/3× speed and a settings popover (palette, reduce-motion, colorblind tags,
  bloom toggle, and a render-only seedling cap for low-end devices). Matches **autosave** — close the tab
  and **Resume** from the menu — and a guided **tutorial** covers the basics.

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
  deterministic (all randomness flows through a seeded PRNG — `serialize → deserialize → N×step` is
  byte-identical, which the test suite enforces). Seedlings are stored as a Structure-of-Arrays of typed
  arrays (no per-unit objects); combat/proximity uses a spatial grid. Player and AI orders flow through one
  deterministic command queue (`Commands`), drained at a single owner-sorted point each tick. Modules:
  `World`, `MapGen`, `Seedlings`, `Combat`, `Economy`, `Trees`, `Tech`, `Bombard`, `Moons`, `Ai`,
  `Commands`, `Save`.
- **`Render/`** — reads sim state each animation frame and **interpolates** between ticks; owns no game
  truth. Instanced draws (one call for all seedlings, one for asteroids), `UnrealBloomPass` at half-res,
  viewport culling + level-of-detail. `Theme` is the single source for owner colors, motion scalars, and
  glyph tags; `EdgeLayer` is the shared line builder (player links, conduits, wormholes, staged-order
  ghosts, threat flow). Modules: `Scene`, `SeedlingView`, `AsteroidView`, `TreeView`, `Minimap`, `Fx`,
  `Picking`, `Glyphs`, `Palette`, `Theme`, `EdgeLayer`, `Preview`, `ThreatView`.
- **`Ui/`** — Web Awesome HUD, menus, skirmish setup, the tutorial, the input loop, sound, the transient
  alert/overlay surface (`Overlay`), and localStorage persistence (autosave / Resume). The player only
  mutates the world through the command queue (send, raid, plant, rally, link, conduit, fire, retreat,
  buy-tech, choose-capstone) — `Render` and `Ui` never write sim state.
- **`Main.js`** drives a fixed-step accumulator loop; **`Game.js`** wires one match together;
  **`Ui/App.js`** owns the `MENU → SETUP → PLAYING → GAME OVER` lifecycle.

## Tests

The sim is pure data, so its rules are unit-tested headless with Node's built-in runner:

```bash
npm test   # node --test "Sim/**/*.test.js"
```

Beyond per-feature rules, the suite guards the determinism contract (serialize→resume→N×step byte-parity)
and the buildless-deploy footguns (every first-party module precached in `Sw.js`; the cache version and the
on-screen build stamp kept in lockstep). Rendering, bloom, picking, and input feel are verified in a browser.

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
</content>
