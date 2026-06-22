// Ui/Input.js — THE CORE INPUT LOOP. Pointer events on the canvas drive the Eufloria
// select→drag→release send. It mutates the world ONLY via sendSeedlings/plantTree.
//   - pointerdown on an OWNED rock: select it + arm a drag from it.
//   - pointerdown elsewhere: select (info only) or deselect on empty space.
//   - drag the selected owned rock toward another rock: drives the in-world drag line.
//   - release over a target rock: sendSeedlings(from, target, fraction, 0) + send FX.
// All select highlight + drag indicator visuals come from Render (already built).
import { clearTrees as clearTreesSim } from "../Sim/Trees.js";
import { isArmed } from "../Sim/Bombard.js";
import { queueCommand, CMD } from "../Sim/Commands.js";
import { buyTech } from "../Sim/Tech.js";
import { buyUpgrade } from "../Sim/Upgrade.js";
import { ownerColorHex } from "../Render/Palette.js";
import { WORLD_STATUS } from "../Sim/World.js";

const HUMAN = 0;
const DRAG_THRESHOLD = 6; // px before a press becomes a drag

export function createInput({
  canvas,
  getWorld,
  views,
  picking,
  getSendFraction,
}) {
  let downId = -1; // rock under the initial press
  let downX = 0;
  let downY = 0;
  let dragging = false; // armed drag from an owned rock
  let pointerId = null;
  let rallyMode = false; // armed: next click sets the selected rock's rally point
  let connectMode = false; // armed: next click links the selected rock to another owned body
  let fireMode = false; // armed: next click on ANY body fires the selected battery at it
  const activeTouches = new Set(); // live touch pointers — 2+ means a camera gesture, not select

  function selectedId() {
    return views.asteroids.selected();
  }
  function setRallyMode(on) {
    rallyMode = !!on;
    if (rallyMode) connectMode = fireMode = false; // arm-modes are mutually exclusive
  }
  function isRallyMode() {
    return rallyMode;
  }
  function setConnectMode(on) {
    connectMode = !!on;
    if (connectMode) rallyMode = fireMode = false;
  }
  function isConnectMode() {
    return connectMode;
  }
  function setFireMode(on) {
    fireMode = !!on;
    if (fireMode) rallyMode = connectMode = false;
  }
  function isFireMode() {
    return fireMode;
  }

  function select(id) {
    const world = getWorld();
    if (id < 0 || !world.asteroids[id]) {
      views.asteroids.clearSelected();
      return;
    }
    views.asteroids.setSelected(id);
  }

  function onDown(e) {
    if (e.pointerType === "touch") {
      activeTouches.add(e.pointerId);
      if (activeTouches.size >= 2) {
        // Second finger down → two-finger camera gesture (Scene.js). Abort select/drag.
        if (dragging) picking.endDrag();
        dragging = false;
        downId = -1;
        pointerId = null;
        return;
      }
    }
    // Left button only — middle/right drive camera pan in Scene.js.
    if (e.button !== 0) return;
    const world = getWorld();
    if (!world || world.status !== WORLD_STATUS.PLAYING) return;
    const clicked = picking.asteroidAt(e.clientX, e.clientY, world);

    // Rally-set mode: a single click on a target asteroid sets the selected rock's anchor.
    // Clicking the selected rock itself clears it. A click on EMPTY space is ignored (stays
    // armed) so a near-miss never silently wipes the rally — the #1 "rally doesn't work"
    // footgun. Doesn't select or arm a drag.
    if (rallyMode) {
      const src = selectedId();
      if (
        src < 0 ||
        !world.asteroids[src] ||
        world.asteroids[src].owner !== HUMAN
      ) {
        rallyMode = false; // nothing of ours selected to rally — disarm
        return;
      }
      if (clicked < 0) return; // missed an asteroid — keep armed, try again
      queueCommand(world, {
        type: CMD.RALLY,
        from: src,
        to: clicked,
        owner: HUMAN,
      }); // clicking src clears (toId === fromId)
      rallyMode = false;
      return;
    }

    // Connect mode: click a SECOND body you control to build a permanent travel link (costs
    // energy). Empty-space miss keeps it armed; clicking the source itself cancels.
    if (connectMode) {
      const src = selectedId();
      if (
        src < 0 ||
        !world.asteroids[src] ||
        world.asteroids[src].owner !== HUMAN
      ) {
        connectMode = false;
        return;
      }
      if (clicked < 0) return; // missed — keep armed
      if (clicked !== src)
        queueCommand(world, {
          type: CMD.CONNECT,
          from: src,
          to: clicked,
          owner: HUMAN,
        });
      connectMode = false;
      return;
    }

    // Fire mode: the FIRST click on ANY body fires the selected armed battery at it (self/star/
    // blackhole all allowed by fireBombard). An empty-space miss stays armed (like rally), so a
    // near-miss never silently wastes the arm. Disarms only when a body is actually clicked or
    // the selected rock is no longer a valid armed source.
    if (fireMode) {
      const src = selectedId();
      const srcRock = src >= 0 ? world.asteroids[src] : null;
      if (!srcRock || srcRock.owner !== HUMAN || !isArmed(srcRock)) {
        fireMode = false; // nothing valid to fire — disarm
        return;
      }
      if (clicked < 0) return; // missed a body — keep armed, try again
      queueCommand(world, {
        type: CMD.FIRE,
        from: src,
        to: clicked,
        owner: HUMAN,
      });
      fireMode = false;
      return;
    }

    pointerId = e.pointerId;
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    downX = e.clientX;
    downY = e.clientY;
    dragging = false;
    downId = clicked;

    if (downId < 0) {
      // Empty space — deselect.
      views.asteroids.clearSelected();
      return;
    }
    select(downId);
    // A drag is armed in onMove (past threshold) only when downId is an owned rock —
    // you can only command your own asteroids. Non-owned rocks are info-only.
  }

  function onMove(e) {
    if (activeTouches.size >= 2) return; // camera gesture owns the pointers
    if (pointerId === null || e.pointerId !== pointerId) return;
    const world = getWorld();
    if (!world) return;
    if (downId < 0) return;
    if (world.asteroids[downId].owner !== HUMAN) return;
    if (!dragging) {
      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
      dragging = true;
      picking.beginDrag(downId);
    }
    picking.updateDrag(e.clientX, e.clientY);
  }

  function dispatch(fromId, toId) {
    const world = getWorld();
    const from = world.asteroids[fromId];
    const to = world.asteroids[toId];
    if (!from || !to || fromId === toId) return;
    if (from.owner !== HUMAN) return;
    const frac = getSendFraction();
    const sent = queueCommand(world, {
      type: CMD.SEND,
      from: fromId,
      to: toId,
      fraction: frac,
      owner: HUMAN,
    });
    if (sent > 0) views.fx.spawnSend(from.x, from.y, ownerColorHex(HUMAN));
  }

  function onUp(e) {
    if (e.pointerType === "touch") activeTouches.delete(e.pointerId);
    if (pointerId === null || e.pointerId !== pointerId) return;
    const world = getWorld();
    canvas.releasePointerCapture && canvas.releasePointerCapture(e.pointerId);
    pointerId = null;

    const wasDragging = dragging;
    dragging = false;
    picking.endDrag();

    if (!world || world.status !== WORLD_STATUS.PLAYING) {
      downId = -1;
      return;
    }

    const targetId = picking.asteroidAt(e.clientX, e.clientY, world);

    if (wasDragging) {
      // Primary interaction: drag release over a different rock dispatches a send.
      if (targetId >= 0 && targetId !== downId) dispatch(downId, targetId);
    }
    // (A pure click selects on the way down; drag is the only dispatch path so an
    //  accidental click never sends. downId===target, or empty, leaves selection as set.)
    downId = -1;
  }

  // Plant action used by the HUD's plant buttons (owns-rock guard inside plantTree).
  function plant(type) {
    const world = getWorld();
    const id = selectedId();
    if (id < 0 || !world.asteroids[id]) return false;
    return queueCommand(world, {
      type: CMD.PLANT,
      rock: id,
      treeType: type,
      owner: HUMAN,
    });
  }

  // Tech-buy action for the HUD's empire-wide tech panel (player 0). Affordability/headroom
  // are validated inside buyTech; this only routes the human's intent through the sanctioned
  // call. Returns true if a tier was actually purchased.
  function tech(track) {
    const world = getWorld();
    if (!world) return false;
    return buyTech(world, HUMAN, track);
  }

  // Upgrade action for the HUD's per-rock upgrade panel. Validates inside buyUpgrade.
  function upgrade(stat) {
    const world = getWorld();
    const id = selectedId();
    if (id < 0 || !world || !world.asteroids[id]) return false;
    return buyUpgrade(world, id, stat, HUMAN);
  }

  // Clear all trees on the selected owned rock so it can be repurposed. Owns-rock guard + no-op
  // on a bare rock live inside clearTrees; returns true only when something was actually removed.
  function clearTrees() {
    const world = getWorld();
    const id = selectedId();
    if (id < 0 || !world || !world.asteroids[id]) return false;
    return clearTreesSim(world, id, HUMAN) > 0;
  }

  // Escape cancels an armed rally / connect pick (the banner tells the player this is there).
  function onKey(e) {
    if (e.key === "Escape") {
      rallyMode = false;
      connectMode = false;
      fireMode = false;
    }
  }

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  window.addEventListener("keydown", onKey);

  function destroy() {
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("pointercancel", onUp);
    window.removeEventListener("keydown", onKey);
    picking.endDrag();
  }

  return {
    plant,
    tech,
    upgrade,
    clearTrees,
    selectedId,
    setRallyMode,
    isRallyMode,
    setConnectMode,
    isConnectMode,
    setFireMode,
    isFireMode,
    destroy,
  };
}
