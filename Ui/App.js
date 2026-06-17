// Ui/App.js — app lifecycle controller. Drives the state machine
//   MENU → SETUP → PLAYING → GAMEOVER (win/lose) → (New Game) → MENU
// and owns the current match (Game instance) + HUD. Main.js's loop asks this controller
// whether to step (PLAYING and not paused) and at what speed; render is always allowed so
// the scene stays visible behind menus.
import { createGame } from "../Game.js";
import { createHud } from "./Hud.js";
import { showStartMenu, showSkirmishSetup, showGameOver } from "./Menus.js";
import { WORLD_STATUS } from "../Sim/World.js";

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

  // Each match gets a brand-new <canvas> behind the #Ui layer. Reusing one canvas breaks
  // re-launch: Game.destroy() force-loses its WebGL context to free it, and a context-lost
  // canvas can't back a new renderer — so the next match would render nothing.
  function freshCanvas() {
    const c = document.createElement("canvas");
    c.id = "Canvas"; // picks up the full-screen #Canvas styling from Index.html
    document.body.insertBefore(c, root); // behind the #Ui overlay
    return c;
  }
  let speed = 1; // 1×/2×/3× sim-time multiplier
  let paused = false;
  let closeOverlay = null; // teardown for the current full-screen overlay
  let gameOverShown = false;

  // Persisted quality settings (survive New Game AND reloads). Reduced-motion sets the bloom
  // DEFAULT (off when the user prefers reduced motion), but any saved choice still wins.
  const QUALITY_KEY = "bloomspace.quality";
  const reduceMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const quality = {
    bloom: !reduceMotion, // effective default; overridden by saved value below
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
  function tearDownMatch() {
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
    closeOverlay = showStartMenu(root, { onNew: toSetup });
  }

  function toSetup() {
    clearOverlay();
    state = APP_STATE.SETUP;
    closeOverlay = showSkirmishSetup(root, {
      onConfirm: startMatch,
      onCancel: toMenu,
    });
  }

  function startMatch(config) {
    clearOverlay();
    tearDownMatch();
    canvas = freshCanvas();
    game = createGame(canvas, config);
    if (game.resize) game.resize(); // fit the freshly-sized world to the viewport
    applyQuality(); // reapply session quality settings to the new match
    speed = 1;
    paused = false;
    gameOverShown = false;

    hud = createHud(root, {
      getWorld: () => (game ? game.world : null),
      getSpeed: () => speed,
      setSpeed: (s) => {
        speed = s;
      },
      isPaused: () => paused,
      setPaused: (p) => {
        paused = p;
      },
      getSendFraction: () => (game ? game.getSendFraction() : 0.5),
      setSendFraction: (f) => game && game.setSendFraction(f),
      onPlant: (type) => game && game.plant(type),
      onBuyTech: (track) => (game ? game.buyTech(track) : false),
      getSelected: () => (game ? game.input.selectedId() : -1),
      setRallyMode: (on) => game && game.input.setRallyMode(on),
      isRallyMode: () => (game ? game.input.isRallyMode() : false),
      setConnectMode: (on) => game && game.input.setConnectMode(on),
      isConnectMode: () => (game ? game.input.isConnectMode() : false),
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
    state = APP_STATE.PLAYING;
  }

  function toGameOver(status) {
    if (gameOverShown) return;
    gameOverShown = true;
    state = APP_STATE.GAMEOVER;
    paused = true; // freeze the sim behind the overlay
    closeOverlay = showGameOver(root, status, { onNewGame: toMenu });
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
  // tick — per-frame UI bookkeeping: refresh HUD + detect terminal status.
  function tick() {
    if (state === APP_STATE.PLAYING && game) {
      if (hud) hud.update();
      const st = game.world.status;
      if (
        st === WORLD_STATUS.WON ||
        st === WORLD_STATUS.LOST ||
        st === WORLD_STATUS.DRAW
      )
        toGameOver(st);
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
