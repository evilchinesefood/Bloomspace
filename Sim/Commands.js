// Sim/Commands.js — deterministic intent seam between Input/AI and the sim mutators. NO three/DOM
// (headless). queueCommand is the single call site Input + AI use to mutate the world; in normal
// play it applies the command IMMEDIATELY and returns the mutator's result, so the refactor is
// byte-for-byte behavior-preserving (the AI's per-tick orbit census + rng draw order are unchanged
// because an earlier AI's send THIS tick is still applied before a later AI decides). The
// pendingCommands list + drainCommands are DORMANT scaffolding here (the list is always empty, so
// drain is a no-op); they activate only for human staged-while-paused orders in a later step.
import { sendSeedlings, setRally } from "./Seedlings.js";
import { tryConnect } from "./MapGen.js";
import { fireBombard } from "./Bombard.js";
import { plantTree } from "./Trees.js";

// Intent-type discriminator. `c.type` is one of these; the PLANT intent carries the tree kind as
// `c.treeType` so it never collides with this `type` tag.
export const CMD = {
  SEND: "send",
  RALLY: "rally",
  CONNECT: "connect",
  FIRE: "fire",
  PLANT: "plant",
};

// applyCommand — dispatch ONE intent to its mutator and return the mutator's result verbatim.
// Unknown type is a defensive no-op (returns undefined).
export function applyCommand(world, c) {
  switch (c.type) {
    case CMD.SEND:
      return sendSeedlings(world, c.from, c.to, c.fraction, c.owner);
    case CMD.RALLY:
      return setRally(world, c.from, c.to, c.owner);
    case CMD.CONNECT:
      return tryConnect(world, c.from, c.to, c.owner);
    case CMD.FIRE:
      return fireBombard(world, c.from, c.to, c.owner);
    case CMD.PLANT:
      return plantTree(world, c.rock, c.treeType, c.owner);
    default:
      return undefined;
  }
}

// queueCommand — the seam Input + AI call. In THIS step it applies the command immediately and
// returns the mutator's result (NOT a deferring append). Staying immediate + returning the result
// is what keeps the refactor byte-identical. Deferred staging-while-paused arrives in a later step.
export function queueCommand(world, c) {
  return applyCommand(world, c);
}

// drainCommands — apply world.pendingCommands (the staged-orders list, always empty in this step)
// in OWNER-ASCENDING order, then clear it. Guards an absent/empty list (a deserialized world that
// predates the field). The sort is STABLE (insertion order preserved within one owner) so a future
// staged batch resolves deterministically. Called once at the TOP of step(), before updateOrbits.
export function drainCommands(world) {
  const q = world.pendingCommands;
  if (!q || !q.length) return;
  q.sort((a, b) => a.owner - b.owner); // stable in modern V8/Node
  for (let i = 0; i < q.length; i++) applyCommand(world, q[i]);
  q.length = 0;
}
