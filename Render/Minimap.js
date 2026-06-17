// Render/Minimap.js — a 2D-canvas HUD overview of the whole map (bottom-right corner).
// Owns NO game truth: it READS the sim via getWorld() + the camera via getViewRect(), and
// the only action it triggers is camera.centerOn() (a view change, not a world mutation).
// Bodies are owner-tinted dots; the central star/black hole gets a distinct ringed marker;
// the live viewport rectangle tracks the main camera; click/drag re-centers the camera.
// Throttled to ~30 Hz so it costs nothing on top of the render loop.
import { ownerColorHex } from "./Palette.js";

const SIZE = 180; // long-edge px of the panel (short edge scales by map aspect)
const PAD = 6; // inner padding (px) so dots/rect don't kiss the border
const THROTTLE_MS = 33; // ~30 Hz redraw cap
const DOT_MIN = 1.6; // smallest drawn body radius (px) so tiny rocks stay visible
const DOT_MAX = 6; // clamp so a planet/star dot doesn't dominate

const css = (n) => "#" + (n >>> 0).toString(16).padStart(6, "0").slice(-6);

export function createMinimap(root, getWorld, camera) {
  // Size the panel to the map's aspect: long edge = SIZE, short edge proportional.
  const w0 = getWorld();
  const mapW = (w0 && w0.width) || 1;
  const mapH = (w0 && w0.height) || 1;
  const aspect = mapW / mapH;
  let pxW, pxH;
  if (aspect >= 1) {
    pxW = SIZE;
    pxH = Math.round(SIZE / aspect);
  } else {
    pxH = SIZE;
    pxW = Math.round(SIZE * aspect);
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(pxW * dpr);
  canvas.height = Math.round(pxH * dpr);
  canvas.style.cssText =
    "position:absolute;right:12px;bottom:12px;pointer-events:auto;cursor:crosshair;" +
    `width:${pxW}px;height:${pxH}px;border-radius:8px;` +
    "border:1px solid rgba(120,150,200,.35);background:rgba(5,7,15,.55);" +
    "box-shadow:0 2px 16px rgba(0,0,0,.45);touch-action:none;";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  root.append(canvas);

  // --- Pure coordinate mapping (world↔minimap, CSS px) -----------------------
  // Drawable area is the panel minus PAD on every edge. World maps linearly onto it; aspect
  // is already baked into pxW/pxH, so a single uniform scale per axis suffices. World-y grows
  // UP on screen (three.js +y up) while canvas-y grows DOWN, so the y axis is flipped to keep
  // the minimap visually aligned with the main view.
  const innerW = pxW - 2 * PAD;
  const innerH = pxH - 2 * PAD;
  const worldToMap = (wx, wy) => ({
    x: PAD + (wx / mapW) * innerW,
    y: PAD + (1 - wy / mapH) * innerH,
  });
  const mapToWorld = (mx, my) => ({
    x: ((mx - PAD) / innerW) * mapW,
    y: (1 - (my - PAD) / innerH) * mapH,
  });

  // Map a pointer event to world coords, then re-center the camera there.
  function recenterFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const wpt = mapToWorld(
      Math.max(PAD, Math.min(pxW - PAD, mx)),
      Math.max(PAD, Math.min(pxH - PAD, my)),
    );
    if (camera && camera.centerOn) camera.centerOn(wpt.x, wpt.y);
  }

  // --- Click + drag to pan ---------------------------------------------------
  let dragging = false;
  function onDown(e) {
    e.preventDefault();
    e.stopPropagation(); // don't fall through to the game canvas behind us
    dragging = true;
    try {
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    } catch {
      /* not capturable — fine */
    }
    recenterFromEvent(e);
  }
  function onMove(e) {
    if (!dragging) return;
    e.preventDefault();
    e.stopPropagation();
    recenterFromEvent(e);
  }
  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    try {
      canvas.releasePointerCapture && canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* fine */
    }
  }
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);

  // --- Draw ------------------------------------------------------------------
  let lastDraw = 0;
  function dotRadius(bodyR) {
    // Modest scale by body radius (world units ~12..210) into a small px range.
    const t = Math.max(0, Math.min(1, (bodyR - 12) / (210 - 12)));
    return Math.max(
      DOT_MIN,
      Math.min(DOT_MAX, DOT_MIN + t * (DOT_MAX - DOT_MIN)),
    );
  }

  function update() {
    const now = performance.now();
    if (now - lastDraw < THROTTLE_MS) return;
    lastDraw = now;

    const world = getWorld();
    if (!world || !world.asteroids) return;

    ctx.clearRect(0, 0, pxW, pxH);

    for (const a of world.asteroids) {
      if (a.dead) continue; // destroyed bodies vanish from the overview
      const p = worldToMap(a.x, a.y);
      const r = dotRadius(a.radius || 0);
      if (a.kind === "star" || a.kind === "blackhole") {
        // Central star/black hole: a distinct ringed neutral marker so it reads as the hub.
        const sr = Math.max(r, 3.5);
        ctx.beginPath();
        ctx.arc(p.x, p.y, sr, 0, Math.PI * 2);
        ctx.fillStyle =
          a.kind === "blackhole" ? "#1a2030" : "rgba(255,244,210,.95)";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x, p.y, sr + 1.5, 0, Math.PI * 2);
        ctx.strokeStyle =
          a.kind === "blackhole"
            ? "rgba(150,120,255,.9)"
            : "rgba(255,210,120,.9)";
        ctx.lineWidth = 1;
        ctx.stroke();
        continue;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = css(ownerColorHex(a.owner));
      ctx.fill();
    }

    // Viewport rectangle: map the visible world rect's corners into minimap px (the y flip
    // swaps which world corner is top), then take min/max + clamp so a zoomed-out rect that
    // spills past the panel still draws inside it.
    const view = camera && camera.getViewRect && camera.getViewRect();
    if (view) {
      const a = worldToMap(view.cx - view.halfW, view.cy - view.halfH);
      const b = worldToMap(view.cx + view.halfW, view.cy + view.halfH);
      const clampX = (v) => Math.max(PAD, Math.min(pxW - PAD, v));
      const clampY = (v) => Math.max(PAD, Math.min(pxH - PAD, v));
      const x0 = clampX(Math.min(a.x, b.x));
      const y0 = clampY(Math.min(a.y, b.y));
      const x1 = clampX(Math.max(a.x, b.x));
      const y1 = clampY(Math.max(a.y, b.y));
      ctx.strokeStyle = "rgba(230,240,255,.9)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    }
  }

  function destroy() {
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("pointercancel", onUp);
    canvas.remove();
  }

  return { update, destroy, canvas };
}
