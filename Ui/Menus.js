// Ui/Menus.js — full-screen overlays drawn with Web Awesome: the start menu, the
// skirmish setup dialog, and the win/lose screen. Each is a function that builds DOM into
// the #Ui layer and resolves/calls back when the player acts. Chrome only; no sim/render.
const SIZES = {
  small: { width: 700, height: 700, asteroids: 12 },
  medium: { width: 1000, height: 1000, asteroids: 24 },
  large: { width: 1400, height: 1400, asteroids: 40 },
};

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

// Start menu: title + New Skirmish. onNew() is called when the player starts.
export function showStartMenu(root, { onNew }) {
  const wrap = overlay();
  const card = el("wa-card", {
    style:
      "pointer-events:auto;max-width:440px;width:90%;text-align:center;--padding:2rem;",
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
  const start = el("wa-button", {
    variant: "brand",
    size: "large",
    style: "width:100%;",
    html: '<i slot="start" class="fa-solid fa-seedling"></i>New Skirmish',
  });
  start.addEventListener("click", () => {
    wrap.remove();
    onNew();
  });
  card.append(start);
  wrap.append(card);
  root.append(wrap);
  return () => wrap.remove();
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

  const field = (labelText, control) =>
    el("div", { style: "margin-bottom:1.1rem;" }, [
      el("label", {
        style: "display:block;margin-bottom:.35rem;font:600 .85rem system-ui;",
        textContent: labelText,
      }),
      control,
    ]);

  const sizeSel = el("wa-select", { value: "medium" }, [
    el("wa-option", { value: "small", textContent: "Small (12 asteroids)" }),
    el("wa-option", { value: "medium", textContent: "Medium (24 asteroids)" }),
    el("wa-option", { value: "large", textContent: "Large (40 asteroids)" }),
  ]);

  const countSlider = el("wa-slider", {
    min: 6,
    max: 60,
    value: 24,
    step: 1,
    "with-tooltip": true,
    style: "width:100%;",
  });

  const aiSel = el("wa-select", { value: "1" }, [
    el("wa-option", { value: "1", textContent: "1 AI opponent" }),
    el("wa-option", { value: "2", textContent: "2 AI opponents" }),
    el("wa-option", { value: "3", textContent: "3 AI opponents" }),
  ]);

  const diffSel = el("wa-select", { value: "1" }, [
    el("wa-option", { value: "0", textContent: "Easy (passive)" }),
    el("wa-option", { value: "1", textContent: "Normal" }),
    el("wa-option", { value: "2", textContent: "Hard" }),
    el("wa-option", { value: "3", textContent: "Brutal" }),
  ]);

  // Map size preset also nudges the default asteroid count.
  sizeSel.addEventListener("change", () => {
    const p = SIZES[sizeSel.value] || SIZES.medium;
    countSlider.value = p.asteroids;
  });

  dialog.append(
    field("Map size", sizeSel),
    field("Asteroid count", countSlider),
    field("AI opponents", aiSel),
    field("Difficulty", diffSel),
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
    // Players: human id 0 + N AI of the chosen difficulty.
    const players = [{ id: 0, isAi: false, difficulty: 0 }];
    for (let i = 1; i <= aiCount; i++)
      players.push({ id: i, isAi: true, difficulty });
    // Match seed: fresh per match — allowed ONLY in the UI layer.
    const seed = (Math.random() * 0xffffffff) >>> 0;
    if (!cleanup()) return;
    onConfirm({
      width: size.width,
      height: size.height,
      asteroidCount,
      players,
      seed,
    });
  });

  wrap.append(dialog);
  root.append(wrap);
  return cleanup;
}

// Win/Lose overlay. status is 'won' | 'lost'. onNewGame() returns to the menu.
export function showGameOver(root, status, { onNewGame }) {
  const won = status === "won";
  const wrap = overlay();
  const card = el("wa-card", {
    style:
      "pointer-events:auto;max-width:420px;width:90%;text-align:center;--padding:2rem;",
  });
  card.append(
    el("i", {
      class: `fa-solid ${won ? "fa-trophy" : "fa-skull"}`,
      style: `font-size:3.2rem;color:${won ? "#5dff9b" : "#ff5a7a"};`,
    }),
    el("h1", {
      style: "margin:.5rem 0 .25rem;font:700 2rem system-ui;",
      textContent: won ? "Victory" : "Defeat",
    }),
    el("p", {
      style: "margin:0 0 1.5rem;opacity:.75;font:400 .95rem system-ui;",
      textContent: won
        ? "You hold every asteroid in the field."
        : "Your bloom has been wiped out.",
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

export { el };
