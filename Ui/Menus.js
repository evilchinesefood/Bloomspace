// Ui/Menus.js — full-screen overlays drawn with Web Awesome: the start menu, the
// skirmish setup dialog, and the win/lose screen. Each is a function that builds DOM into
// the #Ui layer and resolves/calls back when the player acts. Chrome only; no sim/render.
import { paletteColorHex } from "../Render/Theme.js";
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
    else if (typeof v === "boolean") {
      // Boolean attribute on a not-yet-upgraded custom element (e.g. wa-switch before Web
      // Awesome defines it, so `k in node` is false): presence = true. setAttribute(k, false)
      // would leave the attribute PRESENT as "false" (still truthy → ON), so add/remove instead.
      if (v) node.setAttribute(k, "");
      else node.removeAttribute(k);
    } else node.setAttribute(k, v);
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

// A full-screen backdrop in the game's background color (#05070f, same as Scene.setClearColor)
// with the scrolling starfield — so the start menu and the New Skirmish window share the in-game
// look + movement. Returns { wrap, sky }: append content (z-index 1) to wrap, then start the
// starfield on sky AFTER wrap is in the DOM (so the canvas has a measured size).
function starfieldBackdrop() {
  const wrap = overlay("background:#05070f;backdrop-filter:none;");
  const sky = el("canvas", {
    "aria-hidden": "true", // decorative starfield — hide from assistive tech
    style: "position:absolute;inset:0;width:100%;height:100%;display:block;",
  });
  wrap.append(sky);
  return { wrap, sky };
}

// A PERSISTENT menu backdrop: the dark background + scrolling starfield, owned by the caller (App)
// and kept alive across the start-menu ↔ skirmish-setup transition so the stars don't reset/reprint
// each time. Menus mount their card into `.wrap` and remove only the card on close; App calls
// destroy() once, when a match starts. Returns { wrap, destroy }.
export function createStarfieldBackdrop(root) {
  const { wrap, sky } = starfieldBackdrop();
  root.append(wrap);
  const stopSky = startStarfield(sky); // canvas is in the DOM now, so it has a measured size
  return {
    wrap,
    destroy() {
      stopSky();
      wrap.remove();
    },
  };
}

// Start menu: title + (Resume) + Start + Tutorial + GitHub link, over a scrolling starfield.
// onNew() starts a fresh match; onResume() (shown only when `hasSave` is true) restores the
// in-progress match; onTutorial() launches the guided tutorial mode (always available, no save).
export function showStartMenu(
  mount,
  { onNew, onResume, onTutorial, hasSave = false },
) {
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
      textContent: "build v36",
    }),
  );

  mount.append(card);
  // The starfield backdrop is owned by the caller (App) and persists across the menu↔setup
  // transition, so closing this menu removes ONLY the card — the stars keep scrolling.
  function cleanup() {
    card.remove();
  }
  return cleanup;
}

// Skirmish setup dialog: map size, asteroid count, # AI, difficulty. onConfirm(config).
export function showSkirmishSetup(mount, { onConfirm, onCancel }) {
  // Renders into the caller-owned PERSISTENT starfield backdrop (shared with the start menu), so
  // moving between New Game and Cancel never resets/reprints the stars. The form is a wa-card over it.
  const card = el("wa-card", {
    style:
      "position:relative;z-index:1;pointer-events:auto;max-width:32rem;width:92%;" +
      "--padding:1.5rem;max-height:92vh;overflow-y:auto;text-align:left;",
  });
  card.append(
    el("h2", {
      style: "margin:0 0 1rem;font:700 1.5rem system-ui;",
      textContent: "New Skirmish",
    }),
  );

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

  // Environmental hazards toggle (solar flares + meteor showers). Default ON for visibility;
  // the sim defaults OFF when config.events is absent (existing worlds/tests unaffected).
  const eventsSwitch = el("wa-switch", {
    textContent: "Environmental events",
    // OFF by default (opt-in) — absent `checked` attribute = off; prefill() also sets it.
  });

  // Fog of war toggle. Default OFF — fog is a significant mode change (last-known visibility +
  // blind AI), so it's opt-in; the sim also defaults OFF when config.fog is absent.
  const fogSwitch = el("wa-switch", {
    textContent: "Fog of war",
    // OFF by default (opt-in) — absent `checked` attribute = off; prefill() also sets it.
  });

  // Wormholes toggle. Default OFF — adds a far-apart capturable wormhole pair linked by a 1-hop
  // travel shortcut; opt-in like events/fog. The sim defaults OFF when config.wormholes is absent.
  const wormholeSwitch = el("wa-switch", {
    textContent: "Wormholes",
    // OFF by default (opt-in) — absent `checked` attribute = off; prefill() also sets it.
  });

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

  // Section header for grouping — small muted label, no spacing above first group.
  const section = (label, top = true) =>
    el("div", {
      style: `font:700 .72rem system-ui;letter-spacing:.06em;opacity:.55;text-transform:uppercase;${top ? "margin:1rem 0 .35rem;" : "margin:0 0 .35rem;"}`,
      textContent: label,
    });

  card.append(
    section("Map", false),
    field(sizeSel),
    field(countSlider),
    field(layoutSel),
    section("Opponents"),
    field(aiSel),
    field(diffSel),
    field(personalitySel),
    section("Rules"),
    field(winSel),
    field(timeSel),
    section("Hazards"),
    field(eventsSwitch),
    field(fogSwitch),
    field(wormholeSwitch),
  );

  const cancelBtn = el("wa-button", {
    style: "flex:1;",
    textContent: "Cancel",
  });
  const startBtn = el("wa-button", {
    style: "flex:1;",
    variant: "brand",
    html: '<i slot="start" class="fa-solid fa-play"></i>Start Match',
  });
  card.append(
    el("div", { style: "display:flex;gap:.6rem;margin-top:1.4rem;" }, [
      cancelBtn,
      startBtn,
    ]),
  );

  let done = false;
  function cleanup() {
    if (done) return false;
    done = true;
    document.removeEventListener("keydown", onKey);
    card.remove(); // remove only the card; App owns + persists the starfield backdrop
    return true;
  }
  // Escape cancels (the old wa-dialog gave this for free via wa-hide; the card needs it explicit).
  function onKey(e) {
    if (e.key === "Escape" && cleanup()) onCancel && onCancel();
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
      startTree: true, // every spawn home starts with one mature seedling tree (produces from t=0)
      events: eventsSwitch.checked === true, // environmental hazards (flares + meteors), opt-in
      fog: fogSwitch.checked === true, // fog of war (last-known visibility + blind AI), opt-in
      wormholes: wormholeSwitch.checked === true, // a far-apart 1-hop wormhole pair, opt-in
      winConfig: { mode, timeLimitSecs },
    });
  });

  mount.append(card);
  document.addEventListener("keydown", onKey);
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
    eventsSwitch.checked = false;
    fogSwitch.checked = false;
    wormholeSwitch.checked = false;
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

// Hex int → CSS "#rrggbb" string.
function hexToCss(n) {
  return "#" + (n >>> 0).toString(16).padStart(6, "0");
}

// owner 0 = human (player), 1..N = AI — matches Palette.js ownerColorHex mapping.
function playerColor(id) {
  return hexToCss(paletteColorHex(id));
}

// Inline SVG sparkline of territory over time. W×H in px. Returns an <svg> element or null
// when history is empty.
function sparkline(history, playerCount, w = 280, h = 72) {
  if (!history || history.length < 2) return null;
  const maxTerr = Math.max(1, ...history.map((s) => Math.max(...s.terr)));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", w);
  svg.setAttribute("height", h);
  svg.style.cssText =
    "display:block;margin:.75rem auto 0;border-radius:6px;background:rgba(255,255,255,.04);";
  const n = history.length;
  for (let p = 0; p < playerCount; p++) {
    const pts = history.map((s, i) => {
      const x = (i / (n - 1)) * w;
      const y = h - (s.terr[p] / maxTerr) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const poly = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "polyline",
    );
    poly.setAttribute("points", pts.join(" "));
    poly.setAttribute("fill", "none");
    poly.setAttribute("stroke", playerColor(p));
    poly.setAttribute("stroke-width", p === 0 ? "2" : "1.5");
    poly.setAttribute("stroke-opacity", p === 0 ? "1" : "0.7");
    svg.appendChild(poly);
  }
  return svg;
}

// totals block: peak fleet, captures, kills for the human player (id 0), then a compact
// per-player row for AI opponents.
function statsBlock(stats, players) {
  if (!stats) return null;
  const n = players.length;
  // Real kills — attributed in combat to the strongest enemy at each dying ship's body
  // (stats.kills). Old saves without the field fall back to 0.
  const kills = players.map((_, p) => (stats.kills ? stats.kills[p] | 0 : 0));
  const wrap = el("div", { style: "margin:.9rem 0 1.2rem;text-align:left;" });

  // Human row — prominent.
  const humanLabel = (key, val) =>
    el(
      "div",
      {
        style:
          "display:flex;justify-content:space-between;padding:.18rem 0;font:400 .88rem system-ui;",
      },
      [
        el("span", { style: "opacity:.65;", textContent: key }),
        el("span", { style: "font-weight:600;", textContent: String(val) }),
      ],
    );
  const humanBox = el("div", {
    style: `border-left:3px solid ${playerColor(0)};padding:.3rem .6rem .3rem .7rem;margin-bottom:.55rem;`,
  });
  humanBox.append(
    humanLabel("Peak fleet", stats.peakFleet[0]),
    humanLabel("Captures", stats.captures[0]),
    humanLabel("Kills", kills[0]),
  );
  wrap.append(humanBox);

  // AI rows — compact, one line each.
  if (n > 1) {
    const aiWrap = el("div", {
      style: "display:flex;flex-direction:column;gap:.2rem;",
    });
    for (let p = 1; p < n; p++) {
      const row = el("div", {
        style: `display:flex;align-items:center;gap:.5rem;font:400 .8rem system-ui;opacity:.8;
border-left:2px solid ${playerColor(p)};padding-left:.5rem;`,
      });
      row.append(
        el("span", { style: "flex:1;opacity:.6;", textContent: `AI ${p}` }),
        el("span", { textContent: `fleet ${stats.peakFleet[p]}` }),
        el("span", { style: "opacity:.5;", textContent: "·" }),
        el("span", { textContent: `cap ${stats.captures[p]}` }),
        el("span", { style: "opacity:.5;", textContent: "·" }),
        el("span", { textContent: `kills ${kills[p]}` }),
      );
      aiWrap.append(row);
    }
    wrap.append(aiWrap);
  }
  return wrap;
}

export function showGameOver(
  root,
  status,
  { onNewGame, stats = null, history = null, players = null },
) {
  const v = GAME_OVER_VARIANTS[status] || GAME_OVER_VARIANTS.lost;
  const wrap = overlay();
  const card = el("wa-card", {
    role: "alert", // announce win/lose/draw the moment the screen appears
    style:
      "pointer-events:auto;max-width:420px;width:90%;text-align:center;--padding:2rem;overflow-y:auto;max-height:92vh;",
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
      style: "margin:0 0 1rem;opacity:.75;font:400 .95rem system-ui;",
      textContent: v.sub,
    }),
  );
  // Sparkline.
  const spark = sparkline(history, players ? players.length : 1);
  if (spark) card.append(spark);
  // Totals.
  const totals = statsBlock(stats, players || [{ id: 0 }]);
  if (totals) card.append(totals);

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
