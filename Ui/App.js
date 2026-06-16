// Ui/App.js — app lifecycle controller. Drives the state machine
//   MENU → SETUP → PLAYING → GAMEOVER (win/lose) → (New Game) → MENU
// and owns the current match (Game instance) + HUD. Main.js's loop asks this controller
// whether to step (PLAYING and not paused) and at what speed; render is always allowed so
// the scene stays visible behind menus.
import { createGame } from "../Game.js";
import { createHud } from "./Hud.js";
import { showStartMenu, showSkirmishSetup, showGameOver } from "./Menus.js";

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
  // Session-persistent quality settings (survive New Game; reapplied to each match).
  const quality = { bloom: true, seedlingCap: 0 }; // cap 0 = uncapped

  function applyQuality() {
    if (!game) return;
    game.setBloomEnabled(quality.bloom);
    game.setSeedlingCap(quality.seedlingCap);
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
      onPlant: (type) => game && game.input.plant(type),
      getSelected: () => (game ? game.input.selectedId() : -1),
      setRallyMode: (on) => game && game.input.setRallyMode(on),
      isRallyMode: () => (game ? game.input.isRallyMode() : false),
      setConnectMode: (on) => game && game.input.setConnectMode(on),
      isConnectMode: () => (game ? game.input.isConnectMode() : false),
      toggleInbound: () =>
        game ? game.views.asteroids.toggleInbound() : false,
      isInbound: () => (game ? game.views.asteroids.isInbound() : false),
      // Quality settings: read/write the session-persistent state + apply live.
      getQuality: () => quality,
      setBloom: (on) => {
        quality.bloom = !!on;
        if (game) game.setBloomEnabled(quality.bloom);
      },
      setSeedlingCap: (n) => {
        quality.seedlingCap = n;
        if (game) game.setSeedlingCap(n);
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
      if (st === "won" || st === "lost") toGameOver(st);
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
