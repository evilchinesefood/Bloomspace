// Ui/App.js — app lifecycle controller. Drives the state machine
//   MENU → SETUP → PLAYING → GAMEOVER (win/lose) → (New Game) → MENU
// and owns the current match (Game instance) + HUD. Main.js's loop asks this controller
// whether to step (PLAYING and not paused) and at what speed; render is always allowed so
// the scene stays visible behind menus.
import { createGame } from "../Game.js";
import { createHud } from "./Hud.js";
import { createOverlay } from "./Overlay.js";
import {
  showStartMenu,
  showSkirmishSetup,
  showGameOver,
  createStarfieldBackdrop,
} from "./Menus.js";
import { createTutorial, TUTORIAL_CONFIG } from "./Tutorial.js";
import { WORLD_STATUS } from "../Sim/World.js";
import { reducedMotion } from "../Render/Theme.js";
import { writeSave, readSave, hasSave, clearSave } from "./Persist.js";

export const APP_STATE = {
  MENU: "menu",
  SETUP: "setup",
  PLAYING: "playing",
  GAMEOVER: "gameover",
};

export function createApp(root) {
  let state = APP_STATE.MENU;
  let game = null; // current Game instance (null in MENU/SETUP)
  let canvas = null; // a FRESH canvas per match (see freshCanvas)
  let hud = null;
  let overlay = null;

  // Each match gets a brand-new <canvas> behind the #Ui layer. Reusing one canvas breaks
  // re-launch: Game.destroy() force-loses its WebGL context to free it, and a context-lost
  // canvas can't back a new renderer — so the next match would render nothing.
  function freshCanvas() {
    const c = document.createElement("canvas");
    c.id = "Canvas"; // picks up the full-screen #Canvas styling from Index.html
    // a11y: name the surface for screen readers. No role= — the canvas is pointer-interactive
    // (drag-to-send), so role="img" would wrongly mark it static.
    c.setAttribute(
      "aria-label",
      "Bloomspace game — use the on-screen panel controls to play",
    );
    document.body.insertBefore(c, root); // behind the #Ui overlay
    return c;
  }
  let speed = 1; // 1×/2×/3× sim-time multiplier
  let paused = false;
  let closeOverlay = null; // teardown for the current full-screen overlay
  let menuBackdrop = null; // persistent starfield shared by start menu + skirmish setup
  let gameOverShown = false;
  let tutorial = null; // the tutorial coachmark controller (non-null ONLY in tutorial mode)
  let isTutorial = false; // tutorial mode gates autosave OFF so it never writes the real save slot

  // --- Autosave: persist the live match to localStorage so a closed/refreshed tab can Resume.
  // Driven two ways: a timer (accumulated off the per-frame tick) and a tab-hide listener. The
  // listener is registered per match and removed on teardown so matches don't stack handlers.
  // The 15s timer serializes the FULL world on the main thread (synchronous serialize +
  // JSON.stringify in writeSave). At map sizes here that's a small, bounded cost we accept at
  // this cadence — deliberately not offloaded to a worker / not incremental.
  const AUTOSAVE_EVERY = 15; // seconds of real time between timer autosaves
  let autosaveAcc = 0; // accumulates real (wall-clock) seconds while PLAYING
  let lastTickMs = 0; // wall-clock stamp of the previous tick(), for the accumulator
  let visibilityHandler = null; // the active visibilitychange listener (or null)

  // Save the live world IF a resumable match is in progress (PLAYING, not terminal). Used by both
  // the timer and the tab-hide handler. A paused match still autosaves — pausing shouldn't lose
  // progress — but a terminal world never gets written (toGameOver clears the save instead).
  function autosaveNow() {
    if (state !== APP_STATE.PLAYING || !game) return;
    if (isTutorial) return; // tutorial must NOT pollute the player's real in-progress save slot
    if (game.world.status !== WORLD_STATUS.PLAYING) return;
    writeSave(game.world);
  }

  // Persisted quality settings (survive New Game AND reloads). Reduced-motion sets the bloom
  // DEFAULT (off when the user prefers reduced motion), but any saved choice still wins.
  const QUALITY_KEY = "bloomspace.quality";
  const quality = {
    bloom: !reducedMotion(), // effective default; overridden by saved value below
    seedlingCap: 0, // cap 0 = uncapped
    sfx: true,
    music: true,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(QUALITY_KEY) || "null");
    if (saved && typeof saved === "object") Object.assign(quality, saved);
  } catch {
    /* corrupt/blocked storage — fall back to defaults */
  }

  function saveQuality() {
    try {
      localStorage.setItem(QUALITY_KEY, JSON.stringify(quality));
    } catch {
      /* storage blocked (private mode / quota) — non-fatal */
    }
  }

  function applyQuality() {
    if (!game) return;
    game.setBloomEnabled(quality.bloom);
    game.setSeedlingCap(quality.seedlingCap);
    game.setSfxEnabled(quality.sfx);
    game.setMusicEnabled(quality.music);
  }

  function clearOverlay() {
    if (closeOverlay) {
      closeOverlay();
      closeOverlay = null;
    }
  }
  // The menu starfield persists across the start-menu ↔ skirmish-setup transition (so the stars
  // don't reset/reprint on New Game or Cancel). Created on entering the menu; destroyed only when
  // a match begins.
  function ensureBackdrop() {
    if (!menuBackdrop) menuBackdrop = createStarfieldBackdrop(root);
  }
  function destroyBackdrop() {
    if (menuBackdrop) {
      menuBackdrop.destroy();
      menuBackdrop = null;
    }
  }
  function tearDownMatch() {
    // Drop the per-match tab-hide autosave listener so matches don't stack handlers (leak).
    if (visibilityHandler) {
      document.removeEventListener("visibilitychange", visibilityHandler);
      visibilityHandler = null;
    }
    // Tear down the tutorial coachmark (removes its overlay) and clear tutorial mode.
    if (tutorial) {
      tutorial.destroy();
      tutorial = null;
    }
    isTutorial = false;
    autosaveAcc = 0;
    if (overlay) {
      overlay.destroy();
      overlay = null;
    }
    if (hud) {
      hud.destroy();
      hud = null;
    }
    if (game) {
      game.destroy();
      game = null;
    }
    if (canvas) {
      canvas.remove(); // drop the (now context-lost) canvas; the next match makes a fresh one
      canvas = null;
    }
  }

  // --- State transitions -----------------------------------------------------
  function toMenu() {
    clearOverlay();
    tearDownMatch();
    state = APP_STATE.MENU;
    gameOverShown = false;
    ensureBackdrop(); // keep/create the persistent starfield (no reprint on Cancel→menu)
    // Offer Resume only when a usable in-progress save exists (cheap probe). resumeMatch does
    // the full readSave + null-guard, so a save that turns out corrupt at click time falls back.
    closeOverlay = showStartMenu(menuBackdrop.wrap, {
      onNew: toSetup,
      onResume: resumeMatch,
      onTutorial: startTutorial,
      hasSave: hasSave(),
    });
  }

  function toSetup() {
    clearOverlay();
    state = APP_STATE.SETUP;
    ensureBackdrop(); // reuse the start menu's starfield (no reprint on New Game)
    closeOverlay = showSkirmishSetup(menuBackdrop.wrap, {
      onConfirm: startMatch,
      onCancel: toMenu,
    });
  }

  // startMatch — a FRESH skirmish from the setup config. Clears any stale resumable save first
  // (so Resume always reflects an in-progress match, never a previous one), generates the world,
  // then hands off to beginPlaying for the shared HUD/listener/PLAYING setup.
  function startMatch(config) {
    clearOverlay();
    destroyBackdrop(); // leaving the menu for a match — drop the starfield backdrop
    tearDownMatch();
    clearSave(); // a brand-new game invalidates any prior resumable save
    canvas = freshCanvas();
    game = createGame(canvas, config);
    if (game.resize) game.resize(); // fit the freshly-sized world to the viewport
    beginPlaying();
    autosaveNow(); // seed the save immediately so Resume reflects THIS match from the first frame
  }

  // resumeMatch — restore an in-progress match from localStorage. Mirrors startMatch but adopts
  // a pre-deserialized world instead of generating one (so its baked specials/graph/mid-game
  // state continue). A null read (missing/corrupt/wrong-version) falls back: stay on the menu.
  function resumeMatch() {
    const world = readSave();
    if (!world) return; // corrupt/unreadable — don't tear down the menu, just ignore
    clearOverlay();
    destroyBackdrop();
    tearDownMatch();
    canvas = freshCanvas();
    game = createGame(canvas, {}, world); // 3rd arg = restored world; skips world generation
    if (game.resize) game.resize(); // fit the restored world to the viewport
    beginPlaying();
    // Sync App pause flag from the restored world so a game saved-while-paused resumes paused
    // (with its staged orders intact and ghosted). beginPlaying() resets paused=false, so we
    // re-apply after. world.paused is the serialized truth; App paused must mirror it.
    if (world.paused) {
      paused = true;
      // world.paused is already true (from deserialization); no need to write it back.
    }
  }

  // startTutorial — the guided tutorial game mode. Builds a match from the FIXED tutorial config
  // (TUTORIAL_CONFIG: small fixed-seed map, specials off, one passive Easy AI), then attaches the
  // coachmark controller. Crucially it does NOT clearSave() (the player's real in-progress match
  // survives playing the tutorial) and sets isTutorial BEFORE beginPlaying so autosave stays OFF
  // for the whole tutorial — the real save slot is never written. The tutorial mutates no world
  // state; the player drives every step through the real Input/Hud, the controller only gates.
  function startTutorial() {
    clearOverlay();
    destroyBackdrop();
    tearDownMatch();
    isTutorial = true; // set before beginPlaying so the seeded autosave + tab-hide save are inert
    canvas = freshCanvas();
    game = createGame(canvas, TUTORIAL_CONFIG);
    if (game.resize) game.resize();
    beginPlaying();
    tutorial = createTutorial(root, {
      getWorld: () => (game ? game.world : null),
      getSelectedId: () => (game ? game.input.selectedId() : -1),
      onSkip: toMenu, // "Skip tutorial" returns to the menu (tearDownMatch drops the coachmark)
    });
  }

  // beginPlaying — shared PLAYING setup for both fresh + resumed matches: reapply quality, reset
  // speed/pause, build the HUD, register the tab-hide autosave listener, enter PLAYING. The
  // `game` + `canvas` are already created by the caller.
  function beginPlaying() {
    applyQuality(); // reapply session quality settings to the new match
    speed = 1;
    paused = false;
    gameOverShown = false;
    autosaveAcc = 0;
    lastTickMs = 0;

    // Tab-hide autosave: persist the moment the tab is backgrounded/closed (best chance to catch
    // a real close). Removed on teardown (tearDownMatch) so it never leaks across matches.
    visibilityHandler = () => {
      if (document.visibilityState === "hidden") autosaveNow();
    };
    document.addEventListener("visibilitychange", visibilityHandler);

    hud = createHud(root, {
      getWorld: () => (game ? game.world : null),
      // Minimap: the visible world rect + a click-to-pan camera action.
      getViewRect: () => (game ? game.getViewRect() : null),
      centerCamera: (x, y) => game && game.centerOn(x, y),
      getSpeed: () => speed,
      setSpeed: (s) => {
        speed = s;
      },
      isPaused: () => paused,
      setPaused: (p) => {
        paused = !!p;
        if (game) game.world.paused = paused;
      },
      getSendFraction: () => (game ? game.getSendFraction() : 0.5),
      setSendFraction: (f) => game && game.setSendFraction(f),
      onPlant: (type) => game && game.plant(type),
      onUpgrade: (stat) => (game ? game.upgrade(stat) : false),
      onBuyTech: (track) => (game ? game.buyTech(track) : false),
      onClearTrees: () => (game ? game.clearTrees() : false),
      getSelected: () => (game ? game.input.selectedId() : -1),
      setRallyMode: (on) => game && game.input.setRallyMode(on),
      isRallyMode: () => (game ? game.input.isRallyMode() : false),
      setConnectMode: (on) => game && game.input.setConnectMode(on),
      isConnectMode: () => (game ? game.input.isConnectMode() : false),
      setFireMode: (on) => game && game.input.setFireMode(on),
      isFireMode: () => (game ? game.input.isFireMode() : false),
      toggleInbound: () =>
        game ? game.views.asteroids.toggleInbound() : false,
      isInbound: () => (game ? game.views.asteroids.isInbound() : false),
      // Quality settings: read/write the persisted state + apply live (saved on every change).
      getQuality: () => quality,
      setBloom: (on) => {
        quality.bloom = !!on;
        if (game) game.setBloomEnabled(quality.bloom);
        saveQuality();
      },
      setSeedlingCap: (n) => {
        quality.seedlingCap = n;
        if (game) game.setSeedlingCap(n);
        saveQuality();
      },
      setSfx: (on) => {
        quality.sfx = !!on;
        if (game) game.setSfxEnabled(quality.sfx);
        saveQuality();
      },
      setMusic: (on) => {
        quality.music = !!on;
        if (game) game.setMusicEnabled(quality.music);
        saveQuality();
      },
    });
    overlay = createOverlay(root, {
      getViewRect: () => (game ? game.getViewRect() : null),
      centerOn: (x, y) => game && game.centerOn(x, y),
    });
    game.setEventSink(overlay.push);
    game.setThreatActiveGetter(() => overlay.isThreatActive());
    state = APP_STATE.PLAYING;
  }

  function toGameOver(status) {
    if (gameOverShown) return;
    gameOverShown = true;
    state = APP_STATE.GAMEOVER;
    paused = true; // freeze the sim behind the overlay
    // A finished real match is not resumable — drop its save so the menu offers no Resume. But a
    // finished TUTORIAL must leave the player's real in-progress save untouched (the tutorial never
    // wrote it, and clearing here would wipe a real match the player paused to try the tutorial).
    if (!isTutorial) clearSave();
    closeOverlay = showGameOver(root, status, {
      onNewGame: toMenu,
      stats: game.world.stats ?? null,
      history: game.world.history ?? null,
      players: game.world.players ?? null,
    });
  }

  // --- Loop hooks (called by Main.js) ---------------------------------------
  // shouldStep — only advance the sim while actively PLAYING and not paused.
  function shouldStep() {
    return state === APP_STATE.PLAYING && !paused && !!game;
  }
  function getSpeed() {
    return speed;
  }
  function step(dt) {
    if (game) game.step(dt);
  }
  function render(alpha) {
    if (game) game.render(alpha);
  }
  // tick — per-frame UI bookkeeping: refresh HUD + detect terminal status + drive the autosave
  // timer. The timer runs on WALL-CLOCK time (not sim time) so it fires even at 1× and is
  // independent of speed/pause; it only autosaves while genuinely PLAYING (autosaveNow guards
  // status). The terminal check runs first so a just-finished match clears (not re-saves).
  function tick() {
    if (state === APP_STATE.PLAYING && game) {
      if (hud) hud.update();
      if (overlay) overlay.update();
      // Drive the tutorial coachmark (tutorial mode only). Evaluated BEFORE the terminal check so
      // the final "Defeat the enemy" step registers the win the same frame the Victory screen shows.
      if (tutorial) tutorial.update();
      const st = game.world.status;
      if (
        st === WORLD_STATUS.WON ||
        st === WORLD_STATUS.LOST ||
        st === WORLD_STATUS.DRAW
      ) {
        toGameOver(st);
        return;
      }
      // Wall-clock autosave accumulator. lastTickMs=0 means "first tick of the match" — seed it
      // without banking a huge dt (avoids an immediate save on resume from a long-paused tab).
      const now =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      if (lastTickMs) {
        autosaveAcc += (now - lastTickMs) / 1000;
        if (autosaveAcc >= AUTOSAVE_EVERY) {
          autosaveAcc = 0;
          autosaveNow();
        }
      }
      lastTickMs = now;
    }
  }

  // Boot into the start menu.
  toMenu();

  return {
    shouldStep,
    getSpeed,
    step,
    render,
    tick,
    get state() {
      return state;
    },
  };
}
