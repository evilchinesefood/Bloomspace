// Render/Preview.js — ghost overlay for staged (queued-while-paused) human orders.
// Shows faint dashed lines for every pending command that has both `from` and `to` fields
// (SEND/RALLY/CONNECT/FIRE). NEVER mutates world. Allocation-stable (EdgeLayer reallocates
// only on count change). Disposed on match teardown in Game.js.
import { createEdgeLayer } from "./EdgeLayer.js";
import { reducedMotion } from "./Theme.js";

export function createPreview(scene, world) {
  // Ghost style: low-opacity cyan dashes, drawn above the link layer.
  const layer = createEdgeLayer(scene, {
    color: 0x88ffff,
    opacity: 0.35,
    z: -1.8,
    dashed: true,
    dashSize: 20,
    gapSize: 14,
    getList: () => {
      const q = world.pendingCommands;
      if (!q || !q.length) return [];
      return q
        .filter((c) => c.from != null && c.to != null)
        .map((c) => [c.from, c.to]);
    },
    getPoint: (id) => world.asteroids[id],
  });

  let animAcc = 0;

  function update(dt = 0) {
    const q = world.pendingCommands;
    const visible = q && q.length > 0;
    layer.object.visible = visible;
    if (!visible) return;
    // hasMoving=false: asteroids don't move; the list itself drives reallocation via countChanged.
    layer.update(false, null);
    if (!reducedMotion()) {
      animAcc += dt;
      layer.animate(animAcc);
      animAcc = 0;
    }
  }

  function dispose() {
    layer.dispose();
  }

  return { update, dispose };
}
