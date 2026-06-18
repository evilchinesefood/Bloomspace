// Ui/Menus.js — full-screen overlays drawn with Web Awesome: the start menu, the
// skirmish setup dialog, and the win/lose screen. Each is a function that builds DOM into
// the #Ui layer and resolves/calls back when the player acts. Chrome only; no sim/render.
const SIZES = {
  small: {
    width: 1100,
    height: 1100,
    asteroids: 14,
    planetMin: 0,
    planetMax: 1,
  },
  medium: {
    width: 1700,
    height: 1700,
    asteroids: 26,
    planetMin: 1,
    planetMax: 2,
  },
  large: {
    width: 2400,
    height: 2400,
    asteroids: 44,
    planetMin: 1,
    planetMax: 3,
  },
};

// Resolve an app-relative asset path against the page's <base> so it works under a deploy
// subpath (e.g. /bloomspace/). Mirrors the Sw.js / Web Awesome base-path handling.
const baseUrl = (rel) => new URL(rel, document.baseURI).href;

const el = (tag, props = {}, kids = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "style") node.style.cssText = v;
    else if (k === "html") node.innerHTML = v;
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) {
    if (c) node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
};

// A centered card wrapper that opts back into pointer events over the canvas.
function overlay(extraStyle = "") {
  return el("div", {
    style:
      "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;" +
      "pointer-events:auto;background:rgba(5,7,15,0.55);backdrop-filter:blur(2px);" +
      extraStyle,
  });
}

// Animated starfield for the start screen — matches the in-game look (dim blue-white stars
// on deep space) with a gentle downward parallax drift. Returns stop() to cancel it.
function startStarfield(canvas) {
  const ctx = canvas.getContext("2d");
  const COLORS = ["#7f8eac", "#a6b1c8", "#7d9ed8", "#dfe6f5"];
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = 0,
    h = 0,
    stars = [],
    raf = 0,
    last = 0;

  function resize() {
    const cw = canvas.clientWidth || window.innerWidth;
    const ch = canvas.clientHeight || window.innerHeight;
    w = canvas.width = Math.max(1, Math.floor(cw * dpr));
    h = canvas.height = Math.max(1, Math.floor(ch * dpr));
    const n = Math.round((w * h) / (9000 * dpr));
    stars = [];
    for (let i = 0; i < n; i++) {
      const depth = Math.random(); // 0 far … 1 near
      stars.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: (0.5 + depth * 1.6) * dpr,
        spd: (2 + depth * 10) * dpr, // px/sec — subtle drift; near stars faster (parallax)
        a: 0.35 + depth * 0.5,
        c: COLORS[Math.floor(Math.random() * COLORS.length)],
      });
    }
  }

  function frame(t) {
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
    last = t;
    ctx.fillStyle = "#05070f";
    ctx.fillRect(0, 0, w, h);
    for (const s of stars) {
      s.y += s.spd * dt;
      if (s.y > h + 2) {
        s.y = -2;
        s.x = Math.random() * w;
      }
      ctx.globalAlpha = s.a;
      ctx.fillStyle = s.c;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(frame);
  }

  resize();
  window.addEventListener("resize", resize);
  raf = requestAnimationFrame(frame);
  return function stop() {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
  };
}

// Start menu: title + (Resume) + Start + Tutorial + GitHub link, over a scrolling starfield.
// onNew() starts a fresh match; onResume() (shown only when `hasSave` is true) restores the
// in-progress match; onTutorial() launches the guided tutorial mode (always available, no save).
export function showStartMenu(
  root,
  { onNew, onResume, onTutorial, hasSave = false },
) {
  const wrap = overlay("background:#05070f;backdrop-filter:none;");
  const sky = el("canvas", {
    "aria-hidden": "true", // decorative starfield — hide from assistive tech
    style: "position:absolute;inset:0;width:100%;height:100%;display:block;",
  });
  wrap.append(sky);

  const card = el("wa-card", {
    style:
      "position:relative;z-index:1;pointer-events:auto;max-width:440px;width:90%;" +
      "text-align:center;--padding:2rem;",
  });
  card.append(
    el("h1", {
      style:
        "margin:0 0 .25rem;font:700 2.6rem/1.1 system-ui;letter-spacing:.04em;" +
        "background:linear-gradient(90deg,#46e8ff,#8a7bff);-webkit-background-clip:text;" +
        "background-clip:text;color:transparent;",
      textContent: "Bloomspace",
    }),
    el("p", {
      style: "margin:0 0 1.5rem;opacity:.7;font:400 .95rem/1.4 system-ui;",
      textContent: "Colonize the field. Grow. Conquer every asteroid.",
    }),
  );
  // Resume (only when an in-progress save exists): the primary brand action, above Start. Start
  // then drops to a neutral variant so Resume reads as the headline choice. No save → only Start.
  if (hasSave && onResume) {
    const resume = el("wa-button", {
      variant: "brand",
      size: "large",
      style: "width:100%;margin-bottom:.6rem;",
      html: '<i slot="start" class="fa-solid fa-rotate-left"></i>Resume',
    });
    resume.addEventListener("click", () => {
      cleanup();
      onResume();
    });
    card.append(resume);
  }

  const start = el("wa-button", {
    variant: hasSave && onResume ? "neutral" : "brand",
    size: "large",
    style: "width:100%;",
    html:
      '<i slot="start" class="fa-solid fa-play"></i>' +
      (hasSave && onResume ? "New Game" : "Start"),
  });
  start.addEventListener("click", () => {
    cleanup();
    onNew();
  });
  card.append(start);

  // Tutorial — a clearly-labeled secondary action below Start/New-Game. Always available (no save
  // needed): launches the guided, step-gated tutorial mode. Neutral/outline so it reads as
  // secondary to the brand Resume/Start action above it.
  if (onTutorial) {
    const tut = el("wa-button", {
      variant: "neutral",
      appearance: "outlined",
      size: "large",
      style: "width:100%;margin-top:.6rem;",
      html: '<i slot="start" class="fa-solid fa-graduation-cap"></i>Tutorial',
    });
    tut.addEventListener("click", () => {
      cleanup();
      onTutorial();
    });
    card.append(tut);
  }

  const gh = el("a", {
    href: "https://github.com/evilchinesefood/Bloomspace",
    target: "_blank",
    rel: "noopener noreferrer",
    style:
      "display:inline-flex;align-items:center;gap:.45rem;margin-top:1.1rem;" +
      "font:600 .85rem system-ui;color:#8aa0c8;text-decoration:none;opacity:.85;",
    html: '<i class="fa-brands fa-github"></i> View on GitHub',
  });
  card.append(gh);

  // Build stamp — so the player can confirm they're on the latest deploy (rules out a stale
  // service-worker cache). Keep in lockstep with Sw.js CACHE_VERSION.
  card.append(
    el("div", {
      style: "margin-top:.8rem;font:600 .72rem system-ui;opacity:.72;",
      textContent: "build v25",
    }),
  );

  wrap.append(card);
  root.append(wrap);
  // Start the starfield AFTER the canvas is in the DOM so it has a measured size.
  const stopSky = startStarfield(sky);

  function cleanup() {
    stopSky();
    wrap.remove();
  }
  return cleanup;
}

// Skirmish setup dialog: map size, asteroid count, # AI, difficulty. onConfirm(config).
export function showSkirmishSetup(root, { onConfirm, onCancel }) {
  const wrap = overlay();
  const dialog = el("wa-dialog", {
    label: "New Skirmish",
    open: true,
    style: "--width:30rem;",
  });
  // Keep the dialog from closing itself on overlay/Escape without our cleanup.
  // `cleanup()` latches via `done` so exactly one of onCancel/onConfirm ever fires — a
  // successful Start (which removes the wrap) won't also emit a trailing wa-hide → onCancel.
  dialog.addEventListener("wa-hide", (e) => {
    if (e.target !== dialog) return;
    if (cleanup()) onCancel && onCancel();
  });

  // a11y: each control carries its own native `label` attribute (Web Awesome associates it with
  // the field), so field() just adds spacing — no detached <label> to mis-associate.
  const field = (control) =>
    el("div", { style: "margin-bottom:1.1rem;" }, [control]);

  // NOTE: wa-select values are set AFTER the components define (see below) — setting `value`
  // before the <wa-option> children exist fails to pre-fill on a rebuilt dialog (New Game).
  const sizeSel = el("wa-select", { label: "Map size" }, [
    el("wa-option", { value: "small", textContent: "Small (14 bodies)" }),
    el("wa-option", { value: "medium", textContent: "Medium (26 bodies)" }),
    el("wa-option", { value: "large", textContent: "Large (44 bodies)" }),
  ]);

  const countSlider = el("wa-slider", {
    label: "Asteroid count",
    min: 6,
    max: 60,
    value: 26,
    step: 1,
    "with-tooltip": true,
    style: "width:100%;",
  });

  const aiSel = el("wa-select", { label: "AI opponents" }, [
    el("wa-option", { value: "1", textContent: "1 AI opponent" }),
    el("wa-option", { value: "2", textContent: "2 AI opponents" }),
    el("wa-option", { value: "3", textContent: "3 AI opponents" }),
  ]);

  const diffSel = el("wa-select", { label: "Difficulty" }, [
    el("wa-option", { value: "0", textContent: "Easy (passive)" }),
    el("wa-option", { value: "1", textContent: "Normal" }),
    el("wa-option", { value: "2", textContent: "Hard" }),
    el("wa-option", { value: "3", textContent: "Brutal" }),
  ]);

  const winSel = el("wa-select", { label: "Win condition" }, [
    el("wa-option", { value: "elimination", textContent: "Elimination" }),
    el("wa-option", {
      value: "domination",
      textContent: "Domination (hold most for a while)",
    }),
  ]);

  // Time-limit options map to seconds (0 = no cap).
  const timeSel = el("wa-select", { label: "Time limit" }, [
    el("wa-option", { value: "0", textContent: "No limit" }),
    el("wa-option", { value: "300", textContent: "5 minutes" }),
    el("wa-option", { value: "600", textContent: "10 minutes" }),
    el("wa-option", { value: "900", textContent: "15 minutes" }),
  ]);

  const layoutSel = el("wa-select", { label: "Map layout" }, [
    el("wa-option", { value: "scatter", textContent: "Classic (scattered)" }),
    el("wa-option", { value: "loop", textContent: "Loop (ring)" }),
    el("wa-option", { value: "linear", textContent: "Linear (corridor)" }),
    el("wa-option", { value: "hub", textContent: "Hub (spoke clusters)" }),
    el("wa-option", { value: "random", textContent: "Random" }),
  ]);

  const personalitySel = el("wa-select", { label: "AI personality" }, [
    el("wa-option", { value: "random", textContent: "Random (varies per AI)" }),
    el("wa-option", {
      value: "rusher",
      textContent: "Rusher (aggressive, fast)",
    }),
    el("wa-option", {
      value: "turtle",
      textContent: "Turtle (defensive, patient)",
    }),
    el("wa-option", {
      value: "expander",
      textContent: "Expander (territory-focused)",
    }),
    el("wa-option", {
      value: "superweapon-fiend",
      textContent: "Superweapon (battery-obsessed)",
    }),
  ]);

  // Map size preset nudges the default asteroid count AND clamps the slider's max to a count
  // the chosen map can actually fit (rejection sampling caps placement far below big requests:
  // ~16 small / ~36 medium / 60 large). Keeps the request honest with no MapGen change.
  const SIZE_MAX = { small: 16, medium: 36, large: 60 };
  const applySizeToSlider = () => {
    const p = SIZES[sizeSel.value] || SIZES.medium;
    const mx = SIZE_MAX[sizeSel.value] || 60;
    countSlider.max = mx;
    countSlider.value = Math.min(p.asteroids, mx);
  };
  sizeSel.addEventListener("change", applySizeToSlider);

  dialog.append(
    field(sizeSel),
    field(countSlider),
    field(layoutSel),
    field(aiSel),
    field(diffSel),
    field(personalitySel),
    field(winSel),
    field(timeSel),
  );

  const cancelBtn = el("wa-button", {
    slot: "footer",
    textContent: "Cancel",
  });
  const startBtn = el("wa-button", {
    slot: "footer",
    variant: "brand",
    html: '<i slot="start" class="fa-solid fa-play"></i>Start Match',
  });
  dialog.append(cancelBtn, startBtn);

  let done = false;
  function cleanup() {
    if (done) return false;
    done = true;
    wrap.remove();
    return true;
  }
  cancelBtn.addEventListener("click", () => {
    if (cleanup()) onCancel && onCancel();
  });
  startBtn.addEventListener("click", () => {
    const size = SIZES[sizeSel.value] || SIZES.medium;
    const aiCount = parseInt(aiSel.value, 10) || 1;
    const difficulty = parseInt(diffSel.value, 10) || 0;
    const asteroidCount =
      Math.round(Number(countSlider.value)) || size.asteroids;
    const mode = winSel.value === "domination" ? "domination" : "elimination";
    const timeLimitSecs = parseInt(timeSel.value, 10) || 0;
    // Players: human id 0 + N AI of the chosen difficulty.
    const players = [{ id: 0, isAi: false, difficulty: 0 }];
    for (let i = 1; i <= aiCount; i++)
      players.push({ id: i, isAi: true, difficulty });
    // Match seed: fresh per match — allowed ONLY in the UI layer.
    const seed = (Math.random() * 0xffffffff) >>> 0;
    const layout = layoutSel.value || "scatter";
    const aiPersonality = personalitySel.value || "random";
    if (!cleanup()) return;
    onConfirm({
      width: size.width,
      height: size.height,
      asteroidCount,
      planetMin: size.planetMin,
      planetMax: size.planetMax,
      players,
      seed,
      layout,
      aiPersonality,
      specials: true, // terrain specials (rich rocks + nebulae) on for every started match
      winConfig: { mode, timeLimitSecs },
    });
  });

  wrap.append(dialog);
  root.append(wrap);
  // Pre-fill the dropdowns once Web Awesome has defined wa-select (so the value applies with
  // its options already present — this is the part that was blank on a New Game reset).
  const prefill = () => {
    sizeSel.value = "medium";
    aiSel.value = "1";
    diffSel.value = "1";
    personalitySel.value = "random";
    winSel.value = "elimination";
    timeSel.value = "0";
    layoutSel.value = "scatter";
    applySizeToSlider(); // clamp slider max to the (medium) default size
  };
  if (window.customElements && customElements.whenDefined) {
    customElements.whenDefined("wa-select").then(prefill);
  }
  prefill();
  return cleanup;
}

// Win/Lose/Draw overlay. status is 'won' | 'lost' | 'draw'. onNewGame() returns to the menu.
const GAME_OVER_VARIANTS = {
  won: {
    icon: "fa-trophy",
    color: "#5dff9b",
    title: "Victory",
    sub: "You hold every asteroid in the field.",
  },
  lost: {
    icon: "fa-skull",
    color: "#ff5a7a",
    title: "Defeat",
    sub: "Your bloom has been wiped out.",
  },
  draw: {
    icon: "fa-scale-balanced",
    color: "#9fb0d0",
    title: "Stalemate",
    sub: "Time ran out with neither bloom in the lead.",
  },
};
export function showGameOver(root, status, { onNewGame }) {
  const v = GAME_OVER_VARIANTS[status] || GAME_OVER_VARIANTS.lost;
  const wrap = overlay();
  const card = el("wa-card", {
    role: "alert", // announce win/lose/draw the moment the screen appears
    style:
      "pointer-events:auto;max-width:420px;width:90%;text-align:center;--padding:2rem;",
  });
  card.append(
    el("i", {
      class: `fa-solid ${v.icon}`,
      style: `font-size:3.2rem;color:${v.color};`,
    }),
    el("h1", {
      style: "margin:.5rem 0 .25rem;font:700 2rem system-ui;",
      textContent: v.title,
    }),
    el("p", {
      style: "margin:0 0 1.5rem;opacity:.75;font:400 .95rem system-ui;",
      textContent: v.sub,
    }),
  );
  const btn = el("wa-button", {
    variant: "brand",
    size: "large",
    style: "width:100%;",
    html: '<i slot="start" class="fa-solid fa-rotate-right"></i>New Game',
  });
  btn.addEventListener("click", () => {
    wrap.remove();
    onNewGame();
  });
  card.append(btn);
  wrap.append(card);
  root.append(wrap);
  return () => wrap.remove();
}

export { el, baseUrl };
