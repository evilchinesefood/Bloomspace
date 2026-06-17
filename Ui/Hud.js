// Ui/Hud.js — the in-match HUD: top-bar resource readout (seeds / asteroids / seedlings),
// speed + pause controls, a pause→settings popover (with a seam for T8's quality toggle),
// and the asteroid info panel (stats, energy, trees, plant + send-fraction slider).
// Chrome only: it READS sim state and CALLS the action callbacks; it never mutates world.
import { el } from "./Menus.js";
import { ownerColorHex } from "../Render/Palette.js";
import { TREE_SEED_COST, TREE_ENERGY_COST } from "../Sim/Trees.js";
import { CONNECT_ENERGY_COST } from "../Sim/MapGen.js";
import { KIND } from "../Sim/World.js";
import { TECH, MAX_TIER, techCost } from "../Sim/Tech.js";

const hex = (n) => "#" + (n >>> 0).toString(16).padStart(6, "0").slice(-6);

// Guarded DOM writes: only touch a node when the value actually changes. Rewriting a
// <wa-button>'s innerHTML EVERY frame quietly rebuilds its child nodes mid-interaction, which
// can swallow a real (down→up) mouse click in some browsers — the original press target gets
// detached before the click resolves. Setting it only on change fixes that.
function setHtml(el, html) {
  if (el._html !== html) {
    el._html = html;
    el.innerHTML = html;
  }
}
function setProp(el, key, val) {
  if (el[key] !== val) el[key] = val;
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
function playerTechLevel(world, id, track) {
  const p = world.players.find((p) => p.id === id);
  return p && p.tech ? p.tech[track] | 0 : 0;
}
// Tier dots like ●●○ for a level out of MAX_TIER.
function tierDots(level) {
  let s = "";
  for (let i = 0; i < MAX_TIER; i++) s += i < level ? "●" : "○";
  return s;
}
// Ships currently ORBITing a given body (state 0), split by your fighters/defenders + enemies.
function orbitCounts(world, id, me) {
  const s = world.seed;
  let fMine = 0,
    dMine = 0,
    enemy = 0;
  for (let i = 0; i < s.count; i++) {
    if (s.home[i] !== id || s.state[i] !== 0) continue; // STATE.ORBIT === 0
    if (s.owner[i] === me) s.kind[i] === KIND.DEFENDER ? dMine++ : fMine++;
    else enemy++;
  }
  return { fMine, dMine, enemy };
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

  bar.append(seedsStat.box, rocksStat.box);

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
  const techBtn = el("wa-button", {
    size: "small",
    id: "BsTechBtn",
    html: '<i class="fa-solid fa-flask"></i>',
    title: "Tech — empire-wide upgrades",
  });
  const settingsBtn = el("wa-button", {
    size: "small",
    id: "BsSettingsBtn",
    html: '<i class="fa-solid fa-gear"></i>',
  });
  bar.append(group, techBtn, settingsBtn);

  // --- Tech panel (empire-wide upgrades) -------------------------------------
  // A dedicated top-bar popover (mirrors the settings gear). Three tracks × 3 tiers: each row
  // shows the name, current tier (●●○), the next-tier cost, and a Buy button disabled when
  // unaffordable or maxed. Chrome only: reads sim state + calls api.onBuyTech (sanctioned).
  const TECH_ROWS = [
    {
      track: TECH.STRENGTH,
      label: "Ship Strength",
      icon: "fa-burst",
      color: "#ff6b6b",
    },
    {
      track: TECH.SPEED,
      label: "Transit Speed",
      icon: "fa-gauge-high",
      color: "#5ad1ff",
    },
    {
      track: TECH.REGEN,
      label: "Energy Regen",
      icon: "fa-bolt",
      color: "#ffd24b",
    },
  ];
  const techPop = el("wa-popover", {
    for: "BsTechBtn",
    placement: "bottom-end",
  });
  const techSeedsEl = el("div", {
    style:
      "font:600 .8rem system-ui;margin-bottom:.6rem;opacity:.9;color:#5dff9b;",
    textContent: "",
  });
  const techRows = TECH_ROWS.map((def) => {
    const dots = el("span", {
      style: `font:700 .9rem system-ui;letter-spacing:2px;color:${def.color};`,
      textContent: tierDots(0),
    });
    const cost = el("span", {
      style: "font:600 .74rem system-ui;opacity:.8;",
      textContent: "",
    });
    const buyBtn = el("wa-button", {
      size: "small",
      variant: "brand",
      style: "min-width:64px;",
      textContent: "Buy",
    });
    buyBtn.addEventListener(
      "click",
      () => api.onBuyTech && api.onBuyTech(def.track),
    );
    const row = el(
      "div",
      {
        style:
          "display:flex;align-items:center;gap:.6rem;margin-bottom:.55rem;",
      },
      [
        el("i", {
          class: "fa-solid " + def.icon,
          style: `color:${def.color};width:1rem;text-align:center;`,
        }),
        el("div", { style: "flex:1;min-width:120px;" }, [
          el("div", {
            style: "font:600 .82rem system-ui;",
            textContent: def.label,
          }),
          el("div", { style: "display:flex;gap:.5rem;align-items:center;" }, [
            dots,
            cost,
          ]),
        ]),
        buyBtn,
      ],
    );
    return { def, row, dots, cost, buyBtn };
  });
  techPop.append(
    el("div", { style: "min-width:240px;font:500 .85rem system-ui;" }, [
      el("div", {
        style: "font-weight:700;margin-bottom:.5rem;",
        textContent: "Tech",
      }),
      techSeedsEl,
      ...techRows.map((r) => r.row),
      el("div", {
        style: "opacity:.8;font-size:.72rem;line-height:1.3;margin-top:.2rem;",
        textContent:
          "Empire-wide buffs — applies to all your bodies and ships.",
      }),
    ]),
  );
  bar.append(techPop);

  function refreshTech(world) {
    const seeds = playerSeeds(world, HUMAN);
    setHtml(techSeedsEl, `<i class="fa-solid fa-seedling"></i> ${seeds} seeds`);
    for (const r of techRows) {
      const level = playerTechLevel(world, HUMAN, r.def.track);
      const dots = tierDots(level);
      if (r.dots.textContent !== dots) r.dots.textContent = dots;
      const maxed = level >= MAX_TIER;
      const cost = maxed ? null : techCost(level);
      const costTxt = maxed ? "MAX" : `Next: ${cost} seeds`;
      if (r.cost.textContent !== costTxt) r.cost.textContent = costTxt;
      const affordable = !maxed && seeds >= cost;
      setProp(r.buyBtn, "disabled", !affordable);
      setHtml(r.buyBtn, maxed ? "Max" : "Buy");
      r.buyBtn.title = maxed
        ? "All tiers purchased"
        : affordable
          ? `Buy tier ${level + 1} for ${cost} seeds`
          : `Need ${cost} seeds`;
    }
  }

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
  // --- Quality controls: bloom on/off, audio toggles, render-only seedling cap. ----------
  const q = (api.getQuality && api.getQuality()) || {
    bloom: true,
    seedlingCap: 0,
    sfx: true,
    music: true,
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

  // SFX toggle — flips the audio engine's SFX gain (one-shot event sounds).
  const sfxSwitch = el("wa-switch", {
    style: "margin-bottom:.6rem;",
    textContent: "Sound effects",
  });
  if (q.sfx !== false) sfxSwitch.setAttribute("checked", "");
  const onSfx = () => api.setSfx && api.setSfx(sfxSwitch.checked);
  sfxSwitch.addEventListener("change", onSfx);
  sfxSwitch.addEventListener("wa-change", onSfx);

  // Music toggle — starts/stops the looping ambient bed live.
  const musicSwitch = el("wa-switch", {
    style: "margin-bottom:.6rem;",
    textContent: "Ambient music",
  });
  if (q.music !== false) musicSwitch.setAttribute("checked", "");
  const onMusic = () => api.setMusic && api.setMusic(musicSwitch.checked);
  musicSwitch.addEventListener("change", onMusic);
  musicSwitch.addEventListener("wa-change", onMusic);

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
      sfxSwitch,
      musicSwitch,
      capSelect,
      el("div", {
        style: "opacity:.8;font-size:.72rem;line-height:1.3;",
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

  // Rally arming banner — an unmissable top-center cue while the player picks a rally target,
  // so "set rally" is never a silent, invisible mode. Toggled in update() from isRallyMode().
  const rallyBanner = el("div", {
    style:
      "position:absolute;top:70px;left:50%;transform:translateX(-50%);pointer-events:none;" +
      "display:none;align-items:center;gap:.5rem;padding:.5rem .9rem;border-radius:999px;" +
      "background:rgba(70,232,255,.16);border:1px solid rgba(70,232,255,.6);color:#bdecff;" +
      "font:700 .85rem system-ui;white-space:nowrap;box-shadow:0 2px 18px rgba(70,232,255,.25);",
    html:
      '<i class="fa-solid fa-location-crosshairs"></i>' +
      "Click a target asteroid to set the rally — Esc to cancel",
  });
  root.append(rallyBanner);

  // Connect arming banner (same idea, distinct colour/text).
  const connectBanner = el("div", {
    style:
      "position:absolute;top:70px;left:50%;transform:translateX(-50%);pointer-events:none;" +
      "display:none;align-items:center;gap:.5rem;padding:.5rem .9rem;border-radius:999px;" +
      "background:rgba(102,255,200,.16);border:1px solid rgba(102,255,200,.6);color:#bdffe6;" +
      "font:700 .85rem system-ui;white-space:nowrap;box-shadow:0 2px 18px rgba(102,255,200,.25);",
    html:
      '<i class="fa-solid fa-link"></i>' +
      `Click another body you control to link it (−${CONNECT_ENERGY_COST} energy) — Esc to cancel`,
  });
  root.append(connectBanner);

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
  // Orbiting ships at the SELECTED body, split by type (fighters/defenders) + any enemies.
  const orbitEl = el("div", {
    style:
      "margin-bottom:.8rem;font:600 .82rem system-ui;display:flex;gap:1rem;",
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

  // Manual connection: build a permanent travel link to another body you control (costs
  // energy from this rock). Arms a one-click pick like the rally.
  const connectBtn = el("wa-button", {
    size: "small",
    style: "width:100%;margin-top:.4rem;",
    html: '<i slot="start" class="fa-solid fa-link"></i>Build Connection',
  });
  connectBtn.addEventListener("click", () =>
    api.setConnectMode(!api.isConnectMode()),
  );

  // Inbound-rally view (toggle, also bound to the 'i' key): shows which OTHER bodies have
  // their rally set TO the selected body, instead of this body's own outbound rally.
  const inboundBtn = el("wa-button", {
    size: "small",
    style: "width:100%;margin-top:.4rem;",
    html: '<i slot="start" class="fa-solid fa-arrow-right-to-bracket"></i>Show rallies to here',
  });
  inboundBtn.addEventListener("click", () => api.toggleInbound());

  const hint = el("div", {
    style: "margin-top:.6rem;font:500 .76rem system-ui;opacity:.72;",
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
    orbitEl,
    sendSlider,
    plantSeedBtn,
    plantDefBtn,
    rallyBtn,
    connectBtn,
    inboundBtn,
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

    // Orbiting ships at this body (fighters / defenders / enemies). Selected-body only.
    const oc = orbitCounts(world, id, HUMAN);
    setHtml(
      orbitEl,
      `<span title="Your fighters" style="color:#cfe9ff"><i class="fa-solid fa-jet-fighter-up"></i> ${oc.fMine}</span>` +
        `<span title="Your defenders" style="color:#9fffcf"><i class="fa-solid fa-shuttle-space"></i> ${oc.dMine}</span>` +
        (oc.enemy
          ? `<span title="Enemy ships" style="color:#ff6b6b"><i class="fa-solid fa-skull"></i> ${oc.enemy}</span>`
          : ""),
    );

    const owned = a.owner === HUMAN;
    // Only your own rocks expose send/plant/rally; others are info-only.
    sendSlider.style.display = owned ? "" : "none";
    plantSeedBtn.style.display = owned ? "" : "none";
    plantDefBtn.style.display = owned ? "" : "none";
    rallyBtn.style.display = owned ? "" : "none";
    connectBtn.style.display = owned ? "" : "none";
    hint.style.display = owned ? "" : "none";
    if (owned) {
      const seeds = playerSeeds(world, HUMAN);
      const affordable =
        seeds >= TREE_SEED_COST && a.energy >= TREE_ENERGY_COST;
      setProp(plantSeedBtn, "disabled", !affordable);
      setProp(plantDefBtn, "disabled", !affordable);
      const why = affordable
        ? `Costs ${TREE_SEED_COST} seeds + ${TREE_ENERGY_COST} energy`
        : `Need ${TREE_SEED_COST} seeds + ${TREE_ENERGY_COST} energy`;
      plantSeedBtn.title = why;
      plantDefBtn.title = why;

      const arming = api.isRallyMode();
      setProp(rallyBtn, "variant", arming ? "brand" : "neutral");
      const rallySet = a.rally != null && a.rally >= 0;
      setHtml(
        rallyBtn,
        arming
          ? '<i slot="start" class="fa-solid fa-xmark"></i>Cancel rally pick'
          : rallySet
            ? `<i slot="start" class="fa-solid fa-location-crosshairs"></i>Rally → #${a.rally} (change)`
            : '<i slot="start" class="fa-solid fa-location-crosshairs"></i>Set Rally Point',
      );
      const connecting = api.isConnectMode && api.isConnectMode();
      setProp(connectBtn, "variant", connecting ? "brand" : "neutral");
      setProp(
        connectBtn,
        "disabled",
        !connecting && a.energy < CONNECT_ENERGY_COST,
      );
      setHtml(
        connectBtn,
        connecting
          ? '<i slot="start" class="fa-solid fa-xmark"></i>Cancel connection'
          : `<i slot="start" class="fa-solid fa-link"></i>Build Connection (−${CONNECT_ENERGY_COST}⚡)`,
      );
      connectBtn.title =
        a.energy < CONNECT_ENERGY_COST
          ? `Needs ${CONNECT_ENERGY_COST} stored energy on this body`
          : `Link to another body you control for ${CONNECT_ENERGY_COST} energy`;
      hint.textContent = arming
        ? "Click a target asteroid to set the rally (click this rock to clear)."
        : connecting
          ? "Click another body you control to build a permanent link."
          : "Drag from this asteroid to a target to send seedlings.";
    }

    // Inbound-rally toggle works for ANY selected body (e.g. inspect which of your rocks
    // rally onto an enemy target). Always visible while a body is selected.
    const inbound = api.isInbound && api.isInbound();
    setProp(inboundBtn, "variant", inbound ? "brand" : "neutral");
    setHtml(
      inboundBtn,
      inbound
        ? '<i slot="start" class="fa-solid fa-arrow-right-to-bracket"></i>Hide inbound rallies'
        : '<i slot="start" class="fa-solid fa-arrow-right-to-bracket"></i>Show rallies to here',
    );
  }

  // update — called each frame: refresh top-bar tallies + the open panel.
  function update() {
    const world = api.getWorld();
    if (!world) return;
    seedsStat.set(playerSeeds(world, HUMAN));
    rocksStat.set(ownedRocks(world, HUMAN));
    refreshSpeed();
    refreshTech(world);
    rallyBanner.style.display =
      api.isRallyMode && api.isRallyMode() ? "flex" : "none";
    connectBanner.style.display =
      api.isConnectMode && api.isConnectMode() ? "flex" : "none";
    renderPanel(world);
  }

  // 'i' key toggles the inbound-rally view (when a body is selected). Ignore while typing in
  // a form control.
  function onKey(e) {
    if (e.key !== "i" && e.key !== "I") return;
    const tag = (e.target && e.target.tagName) || "";
    if (/^(INPUT|TEXTAREA)$/.test(tag) || tag.startsWith("WA-")) return;
    if (api.getSelected && api.getSelected() >= 0) api.toggleInbound();
  }
  window.addEventListener("keydown", onKey);

  function destroy() {
    bar.remove();
    panel.remove();
    rallyBanner.remove();
    connectBanner.remove();
    window.removeEventListener("keydown", onKey);
  }

  return { update, refreshSpeed, destroy, dom: { bar, panel } };
}
