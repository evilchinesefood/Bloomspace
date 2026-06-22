// Ui/Overlay.js — transient overlay channel: alert pings + event ticker + Space snap-to.
// Mounts an absolutely-positioned, pointer-events:none layer on the #Ui root.
// Consumer of Game.setEventSink; pure RENDER/UI — no Sim writes.
import { EVENT } from "../Sim/World.js";
import { ownerColorHex } from "../Render/Palette.js";
import * as Theme from "../Render/Theme.js";

const PING_POOL = 8; // max concurrent pings
const PING_LIFE = 1.5; // seconds
const PING_DEDUP_MS = 400; // collapse same (type, near pos) within this window
const PING_DEDUP_R2 = 40 * 40; // world-units² radius for dedup
const PING_SIZE = 22; // px
const TICKER_COUNT = 4; // visible ticker rows
const TICKER_LIFE = 4; // seconds each row lives

const PING_LABEL = {
  [EVENT.LOST]: "Lost Rock",
  [EVENT.DESTROY]: "Body destroyed",
  [EVENT.FIRE]: "Under bombardment",
};

// World→screen projection given the view rect {x,y,w,h} (world coords) and canvas size.
function worldToScreen(wx, wy, rect, cw, ch) {
  const px = ((wx - rect.x) / rect.w) * cw;
  const py = ((wy - rect.y) / rect.h) * ch;
  return { px, py };
}

// Clamp px,py to the viewport edge with a margin. Returns clamped coords + whether it was clamped.
function clampToEdge(px, py, cw, ch, margin) {
  const m = margin;
  const cx = Math.max(m, Math.min(cw - m, px));
  const cy = Math.max(m, Math.min(ch - m, py));
  return { cx, cy, clamped: cx !== px || cy !== py };
}

export function createOverlay(root, { getViewRect, centerOn }) {
  // Layer
  const layer = document.createElement("div");
  layer.style.cssText =
    "position:absolute;inset:0;pointer-events:none;overflow:hidden;";
  root.appendChild(layer);

  // --- Ping pool ---
  const pings = Array.from({ length: PING_POOL }, () => {
    const d = document.createElement("div");
    d.style.cssText =
      `position:absolute;width:${PING_SIZE}px;height:${PING_SIZE}px;` +
      "border-radius:50%;border:2.5px solid #fff;display:flex;align-items:center;" +
      "justify-content:center;font-size:11px;font-weight:700;color:#fff;" +
      "pointer-events:none;opacity:0;transform:translate(-50%,-50%);transition:none;";
    layer.appendChild(d);
    return { el: d, active: false, life: 0, wx: 0, wy: 0 };
  });

  // Dedup: track recent (type, wx, wy, time) to collapse rapid repeat events.
  const dedupLog = []; // { type, wx, wy, ms }

  // --- Ticker ---
  const tickerWrap = document.createElement("div");
  tickerWrap.style.cssText =
    "position:absolute;bottom:48px;left:12px;display:flex;flex-direction:column-reverse;" +
    "gap:2px;pointer-events:none;";
  layer.appendChild(tickerWrap);

  // Ring buffer for ticker rows.
  const tickerRows = Array.from({ length: TICKER_COUNT }, () => {
    const d = document.createElement("div");
    d.style.cssText =
      "font-size:11px;color:#e0e8f0;background:rgba(0,0,0,0.45);border-radius:4px;" +
      "padding:1px 6px;opacity:0;pointer-events:none;white-space:nowrap;";
    tickerWrap.appendChild(d);
    return { el: d, life: 0, active: false };
  });
  let tickerHead = 0; // ring-buffer write head

  function pushTicker(label) {
    const row = tickerRows[tickerHead % TICKER_COUNT];
    tickerHead++;
    row.el.textContent = label;
    row.el.style.opacity = "1";
    row.life = TICKER_LIFE;
    row.active = true;
  }

  // Most recent alert world position (for Space snap-to).
  let snapWx = null,
    snapWy = null;

  let lastMs = performance.now();

  // push — the event sink called by Game.render drain.
  function push(type, wx, wy, owner, x2, y2) {
    if (type !== EVENT.LOST && type !== EVENT.DESTROY && type !== EVENT.FIRE)
      return;
    if (type === EVENT.FIRE && owner === 0) return; // only enemy fire is an alert

    const now = performance.now();

    // Dedup: check recent log for same type + nearby position.
    for (let i = dedupLog.length - 1; i >= 0; i--) {
      const d = dedupLog[i];
      if (now - d.ms > PING_DEDUP_MS) break;
      if (d.type !== type) continue;
      const dx = d.wx - wx,
        dy = d.wy - wy;
      if (dx * dx + dy * dy < PING_DEDUP_R2) return; // deduplicated
    }
    // Trim old dedup entries (keep only within window).
    while (dedupLog.length && now - dedupLog[0].ms > PING_DEDUP_MS)
      dedupLog.shift();
    dedupLog.push({ type, wx, wy, ms: now });

    snapWx = wx;
    snapWy = wy;

    // Find a free ping slot (oldest active if all busy).
    let slot = pings.find((p) => !p.active);
    if (!slot) {
      // Evict the one furthest into its life (closest to expiry).
      let minLife = Infinity;
      for (const p of pings) {
        if (p.life < minLife) {
          minLife = p.life;
          slot = p;
        }
      }
    }

    const color = "#" + ownerColorHex(owner).toString(16).padStart(6, "0");
    const shape = Theme.getTags() ? Theme.ownerShape(owner) : null;
    slot.el.style.borderColor = color;
    slot.el.style.background = "rgba(0,0,0,0.5)";
    slot.el.textContent = shape ? shapeGlyph(shape) : "";
    slot.el.style.opacity = "1";
    slot.wx = wx;
    slot.wy = wy;
    slot.life = PING_LIFE;
    slot.active = true;

    pushTicker(PING_LABEL[type] || "Alert");
  }

  function shapeGlyph(shape) {
    const map = {
      circle: "●",
      square: "■",
      triangle: "▲",
      diamond: "◆",
      star: "★",
      cross: "✚",
      hexagon: "⬡",
      dot: "·",
    };
    return map[shape] || "";
  }

  // update — called per frame by App.tick().
  function update() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastMs) / 1000);
    lastMs = now;

    const rm = Theme.reducedMotion();
    const rect = getViewRect();
    const cw = window.innerWidth,
      ch = window.innerHeight;

    for (const p of pings) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        p.el.style.opacity = "0";
        continue;
      }
      const fade = Math.min(1, p.life / 0.3); // fade out in last 0.3s
      p.el.style.opacity = String(fade);

      if (rect) {
        const { px, py } = worldToScreen(p.wx, p.wy, rect, cw, ch);
        const { cx, cy, clamped } = clampToEdge(px, py, cw, ch, PING_SIZE);
        p.el.style.left = cx + "px";
        p.el.style.top = cy + "px";
        // Edge-clamped: show as a square to distinguish from on-screen circular ping.
        p.el.style.borderRadius = clamped ? "3px" : "50%";
      }
    }

    for (const row of tickerRows) {
      if (!row.active) continue;
      row.life -= dt;
      if (row.life <= 0) {
        row.active = false;
        row.el.style.opacity = "0";
        continue;
      }
      // Fade out in last 0.8s; no slide when reduced motion.
      const fade = Math.min(1, row.life / 0.8);
      row.el.style.opacity = String(fade);
      if (!rm) {
        // Subtle slide-in on appear (only when motion is allowed).
        const slideIn = Math.min(1, (TICKER_LIFE - row.life) / 0.15);
        row.el.style.transform = `translateX(${(1 - slideIn) * -8}px)`;
      } else {
        row.el.style.transform = "";
      }
    }
  }

  // Space snap-to: center camera on most recent alert.
  function onKey(e) {
    if (e.code !== "Space") return;
    if (
      e.target &&
      e.target.tagName &&
      /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)
    )
      return;
    if (snapWx === null) return;
    e.preventDefault();
    centerOn(snapWx, snapWy);
  }
  window.addEventListener("keydown", onKey, { capture: true });

  function destroy() {
    window.removeEventListener("keydown", onKey, { capture: true });
    layer.remove();
  }

  return { push, update, destroy };
}
