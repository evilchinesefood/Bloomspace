// Ui/Hud.js — the in-match HUD: top-bar resource readout (seeds / asteroids / seedlings),
// speed + pause controls, a pause→settings popover (with a seam for T8's quality toggle),
// and the asteroid info panel (stats, energy, trees, plant + send-fraction slider).
// Chrome only: it READS sim state and CALLS the action callbacks; it never mutates world.
import { el } from "./Menus.js";
import { ownerColorHex } from "../Render/Palette.js";
import { TREE_SEED_COST, TREE_ENERGY_COST } from "../Sim/Trees.js";

const hex = (n) => "#" + (n >>> 0).toString(16).padStart(6, "0").slice(-6);

// Count seedlings owned by `owner`.
function mySeedlings(world, owner) {
  const s = world.seed;
  let mine = 0;
  for (let i = 0; i < s.count; i++) if (s.owner[i] === owner) mine++;
  return mine;
}
function ownedRocks(world, owner) {
  let n = 0;
  for (const a of world.asteroids) if (a.owner === owner) n++;
  return n;
}
function playerSeeds(world, id) {
  const p = world.players.find((p) => p.id === id);
  return p ? Math.floor(p.seeds ?? 0) : 0;
}

export function createHud(root, api) {
  // api: { getWorld, getSpeed, setSpeed, isPaused, setPaused, getSendFraction,
  //        setSendFraction, onPlant, getSelected }
  const HUMAN = 0;

  // --- Top bar ---------------------------------------------------------------
  const bar = el("div", {
    style:
      "position:absolute;top:0;left:0;right:0;display:flex;gap:.75rem;align-items:center;" +
      "padding:.6rem .9rem;pointer-events:auto;" +
      "background:linear-gradient(180deg,rgba(5,7,15,.85),rgba(5,7,15,0));font:600 .95rem system-ui;",
  });

  const stat = (icon, color) => {
    const v = el("span", { textContent: "0" });
    const box = el(
      "div",
      {
        style: `display:flex;align-items:center;gap:.4rem;color:${color};`,
      },
      [el("i", { class: "fa-solid fa-" + icon }), v],
    );
    return { box, set: (t) => (v.textContent = String(t)) };
  };

  const seedsStat = stat("seedling", "#5dff9b"); // harvestable seeds
  const rocksStat = stat("asterisk", "#46e8ff"); // owned asteroids
  const seedlingsStat = stat("circle", "#ffd24b"); // orbiting seedlings

  bar.append(seedsStat.box, rocksStat.box, seedlingsStat.box);

  // Spacer pushes speed controls to the right.
  bar.append(el("div", { style: "flex:1;" }));

  // Speed / pause control group.
  const speeds = [1, 2, 3];
  const speedBtns = new Map();
  const group = el("wa-button-group", { label: "Speed" });
  const pauseBtn = el("wa-button", {
    size: "small",
    html: '<i class="fa-solid fa-pause"></i>',
  });
  pauseBtn.addEventListener("click", () => api.setPaused(!api.isPaused()));
  group.append(pauseBtn);
  for (const sp of speeds) {
    const b = el("wa-button", { size: "small", textContent: sp + "×" });
    b.addEventListener("click", () => {
      api.setPaused(false);
      api.setSpeed(sp);
      refreshSpeed();
    });
    speedBtns.set(sp, b);
    group.append(b);
  }
  const settingsBtn = el("wa-button", {
    size: "small",
    id: "BsSettingsBtn",
    html: '<i class="fa-solid fa-gear"></i>',
  });
  bar.append(group, settingsBtn);

  // Settings popover: resume + a clean seam for the T8 quality toggle.
  const settings = el("wa-popover", {
    for: "BsSettingsBtn",
    placement: "bottom-end",
  });
  const resumeBtn = el("wa-button", {
    size: "small",
    variant: "brand",
    style: "width:100%;margin-bottom:.5rem;",
    textContent: "Resume",
  });
  resumeBtn.addEventListener("click", () => {
    api.setPaused(false);
    settings.open = false;
    refreshSpeed();
  });
  // --- Quality controls (T8): bloom on/off + render-only seedling cap. -------
  const q = (api.getQuality && api.getQuality()) || {
    bloom: true,
    seedlingCap: 0,
  };

  // Bloom toggle — flips the UnrealBloomPass in/out of the composer (the escape hatch).
  const bloomSwitch = el("wa-switch", {
    style: "margin-bottom:.6rem;",
    textContent: "Bloom glow",
  });
  if (q.bloom !== false) bloomSwitch.setAttribute("checked", "");
  const onBloom = () => api.setBloom && api.setBloom(bloomSwitch.checked);
  bloomSwitch.addEventListener("change", onBloom);
  bloomSwitch.addEventListener("wa-change", onBloom);

  // Seedling cap — RENDER-ONLY limit on drawn instances (not a sim change). 0 = uncapped.
  const capOptions = [
    ["0", "Uncapped"],
    ["1500", "1500"],
    ["800", "800"],
    ["400", "400"],
  ];
  const capSelect = el("wa-select", {
    label: "Max drawn seedlings",
    size: "small",
    style: "margin-bottom:.4rem;",
    value: String(q.seedlingCap || 0),
  });
  for (const [val, label] of capOptions)
    capSelect.append(el("wa-option", { value: val, textContent: label }));
  const onCap = () =>
    api.setSeedlingCap && api.setSeedlingCap(Number(capSelect.value) || 0);
  capSelect.addEventListener("change", onCap);
  capSelect.addEventListener("wa-change", onCap);

  settings.append(
    el("div", { style: "min-width:180px;font:500 .85rem system-ui;" }, [
      el("div", {
        style: "font-weight:700;margin-bottom:.5rem;",
        textContent: "Settings",
      }),
      resumeBtn,
      bloomSwitch,
      capSelect,
      el("div", {
        style: "opacity:.55;font-size:.72rem;line-height:1.3;",
        textContent: "Cap limits drawn seedlings only — the sim is unchanged.",
      }),
    ]),
  );
  bar.append(settings);
  root.append(bar);

  function refreshSpeed() {
    const paused = api.isPaused();
    const sp = api.getSpeed();
    pauseBtn.querySelector("i").className = paused
      ? "fa-solid fa-play"
      : "fa-solid fa-pause";
    pauseBtn.variant = paused ? "brand" : "neutral";
    for (const [s, b] of speedBtns)
      b.variant = !paused && s === sp ? "brand" : "neutral";
  }

  // --- Asteroid info panel ---------------------------------------------------
  const panel = el("div", {
    style:
      "position:absolute;left:0;top:64px;bottom:0;width:300px;max-width:80vw;" +
      "padding:0 .75rem;pointer-events:none;display:none;",
  });
  const card = el("wa-card", {
    style: "pointer-events:auto;width:100%;--padding:1rem;",
  });
  panel.append(card);
  root.append(panel);

  const statBar = (label, color) => {
    const fill = el("div", {
      style: `height:100%;width:0%;background:${color};transition:width .2s;`,
    });
    const track = el(
      "div",
      {
        style:
          "height:8px;border-radius:4px;background:rgba(255,255,255,.1);overflow:hidden;",
      },
      [fill],
    );
    const row = el("div", { style: "margin-bottom:.5rem;" }, [
      el("div", {
        style:
          "display:flex;justify-content:space-between;font:600 .78rem system-ui;margin-bottom:.2rem;",
        html: `<span>${label}</span><span class="v">0</span>`,
      }),
      track,
    ]);
    return {
      row,
      set: (val) => {
        const v = Math.max(0, Math.min(100, val));
        fill.style.width = v + "%";
        row.querySelector(".v").textContent = Math.round(val);
      },
    };
  };

  const titleEl = el("h2", {
    style: "margin:0 0 .15rem;font:700 1.1rem system-ui;",
    textContent: "Asteroid",
  });
  const ownerEl = el("div", {
    style: "font:600 .8rem system-ui;margin-bottom:.8rem;",
    textContent: "",
  });
  const eBar = statBar("Energy", "#ffd24b");
  const sBar = statBar("Strength", "#ff6b6b");
  const spBar = statBar("Speed", "#5ad1ff");
  const energyEl = el("div", {
    style: "margin:.4rem 0 .8rem;font:600 .85rem system-ui;opacity:.9;",
    textContent: "",
  });
  const treesEl = el("div", {
    style: "margin-bottom:.8rem;font:500 .82rem system-ui;opacity:.85;",
    textContent: "",
  });

  // Send-fraction slider — the single source of how many seedlings a send dispatches.
  const sendSlider = el("wa-slider", {
    label: "Send amount",
    min: 0,
    max: 100,
    value: 50,
    step: 5,
    "with-tooltip": true,
    style: "width:100%;margin-bottom:.8rem;",
  });
  const syncFrac = () =>
    api.setSendFraction(
      Math.max(0, Math.min(1, Number(sendSlider.value) / 100)),
    );
  sendSlider.addEventListener("input", syncFrac);
  sendSlider.addEventListener("change", syncFrac);
  syncFrac();

  const plantSeedBtn = el("wa-button", {
    size: "small",
    style: "width:100%;margin-bottom:.4rem;",
    html: '<i slot="start" class="fa-solid fa-tree"></i>Plant Seedling Tree',
  });
  const plantDefBtn = el("wa-button", {
    size: "small",
    style: "width:100%;",
    html: '<i slot="start" class="fa-solid fa-shield-halved"></i>Plant Defense Tree',
  });
  plantSeedBtn.addEventListener("click", () => api.onPlant("seedling"));
  plantDefBtn.addEventListener("click", () => api.onPlant("defense"));

  // Rally (anchor) point: arms a one-click target pick; new seedlings produced here then
  // auto-move to that target. Clicking this rock itself (while arming) clears the rally.
  const rallyBtn = el("wa-button", {
    size: "small",
    style: "width:100%;margin-top:.4rem;",
    html: '<i slot="start" class="fa-solid fa-location-crosshairs"></i>Set Rally Point',
  });
  rallyBtn.addEventListener("click", () =>
    api.setRallyMode(!api.isRallyMode()),
  );

  const hint = el("div", {
    style: "margin-top:.6rem;font:500 .76rem system-ui;opacity:.6;",
    textContent: "Drag from this asteroid to a target to send seedlings.",
  });

  card.append(
    titleEl,
    ownerEl,
    eBar.row,
    sBar.row,
    spBar.row,
    energyEl,
    treesEl,
    sendSlider,
    plantSeedBtn,
    plantDefBtn,
    rallyBtn,
    hint,
  );

  // Render the panel for a given asteroid id (or hide if id<0).
  function renderPanel(world) {
    const id = api.getSelected();
    if (id == null || id < 0 || !world.asteroids[id]) {
      panel.style.display = "none";
      return;
    }
    const a = world.asteroids[id];
    panel.style.display = "block";
    titleEl.textContent = `Asteroid #${id}`;
    const ownerName =
      a.owner === HUMAN ? "You" : a.owner < 0 ? "Neutral" : `AI ${a.owner}`;
    ownerEl.textContent = ownerName;
    ownerEl.style.color = hex(ownerColorHex(a.owner));
    eBar.set(a.energyStat);
    sBar.set(a.strengthStat);
    spBar.set(a.speedStat);
    energyEl.textContent = `Stored energy: ${Math.round(a.energy)}`;
    const seedT = a.trees.filter((t) => t.type === "seedling").length;
    const defT = a.trees.filter((t) => t.type === "defense").length;
    treesEl.textContent =
      a.trees.length === 0
        ? "No trees."
        : `Trees: ${seedT} seedling, ${defT} defense`;

    const owned = a.owner === HUMAN;
    // Only your own rocks expose send/plant/rally; others are info-only.
    sendSlider.style.display = owned ? "" : "none";
    plantSeedBtn.style.display = owned ? "" : "none";
    plantDefBtn.style.display = owned ? "" : "none";
    rallyBtn.style.display = owned ? "" : "none";
    hint.style.display = owned ? "" : "none";
    if (owned) {
      const seeds = playerSeeds(world, HUMAN);
      const affordable =
        seeds >= TREE_SEED_COST && a.energy >= TREE_ENERGY_COST;
      plantSeedBtn.disabled = !affordable;
      plantDefBtn.disabled = !affordable;
      const why = affordable
        ? `Costs ${TREE_SEED_COST} seeds + ${TREE_ENERGY_COST} energy`
        : `Need ${TREE_SEED_COST} seeds + ${TREE_ENERGY_COST} energy`;
      plantSeedBtn.title = why;
      plantDefBtn.title = why;

      const arming = api.isRallyMode();
      rallyBtn.variant = arming ? "brand" : "neutral";
      const rallySet = a.rally != null && a.rally >= 0;
      rallyBtn.innerHTML = arming
        ? '<i slot="start" class="fa-solid fa-xmark"></i>Cancel rally pick'
        : rallySet
          ? `<i slot="start" class="fa-solid fa-location-crosshairs"></i>Rally → #${a.rally} (change)`
          : '<i slot="start" class="fa-solid fa-location-crosshairs"></i>Set Rally Point';
      hint.textContent = arming
        ? "Click a target asteroid to set the rally (click this rock to clear)."
        : "Drag from this asteroid to a target to send seedlings.";
    }
  }

  // update — called each frame: refresh top-bar tallies + the open panel.
  function update() {
    const world = api.getWorld();
    if (!world) return;
    seedsStat.set(playerSeeds(world, HUMAN));
    rocksStat.set(ownedRocks(world, HUMAN));
    seedlingsStat.set(mySeedlings(world, HUMAN));
    refreshSpeed();
    renderPanel(world);
  }

  function destroy() {
    bar.remove();
    panel.remove();
  }

  return { update, refreshSpeed, destroy, dom: { bar, panel } };
}
