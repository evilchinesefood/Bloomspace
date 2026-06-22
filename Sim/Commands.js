// Sim/Commands.js — deterministic intent seam between Input/AI and the sim mutators. NO three/DOM
// (headless). queueCommand is the single call site Input + AI use to mutate the world; while the
// world is PAUSED and the command owner is HUMAN (0), the command is STAGED onto pendingCommands
// instead of applied immediately — queueCommand returns STAGED in that case. All other paths
// (AI commands, unpaused human commands) apply immediately and return the mutator's result, keeping
// the AI per-tick draw order byte-for-byte identical. drainCommands (called at the top of step())
// applies the staged batch owner-ascending on the next step after resume.
import { sendSeedlings, setRally } from "./Seedlings.js";
import { tryConnect } from "./MapGen.js";
import { fireBombard } from "./Bombard.js";
import { plantTree } from "./Trees.js";

// Sentinel returned by queueCommand when a human command is staged (world.paused). Callers
// (Input.js) check for this to skip immediate execute-FX; the ghost preview is the feedback.
export const STAGED = Symbol("staged");

// Owner constant: human player is always owner 0.
const HUMAN_OWNER = 0;

// Intent-type discriminator. `c.type` is one of these; the PLANT intent carries the tree kind as
// `c.treeType` so it never collides with this `type` tag.
export const CMD = {
  SEND: "send",
  RALLY: "rally",
  CONNECT: "connect",
  FIRE: "fire",
  PLANT: "plant",
  RETREAT: "retreat",
};

// applyRetreat — arm/disarm a rock's "retreat if outmatched" + set its fallback body. Only the
// rock's OWNER may arm its own rock (else no-op). The fallback is validated each tick by
// updateRetreat, so a junk fallbackId here is harmless ("no retreat"). Returns true on a change.
function applyRetreat(world, c) {
  const rock = world.asteroids[c.rock];
  if (!rock || rock.owner !== c.owner) return false;
  rock.retreatArmed = !!c.armed;
  rock.fallbackId = c.fallbackId;
  return true;
}

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
    case CMD.RETREAT:
      return applyRetreat(world, c);
    default:
      return undefined;
  }
}

// queueCommand — the seam Input + AI call. While world.paused AND c.owner === HUMAN_OWNER (0),
// the command is STAGED: a clone is pushed onto world.pendingCommands and STAGED is returned so
// the caller (Input.js) knows to skip immediate execute-FX. In all other cases (AI commands,
// unpaused human commands) the command is applied immediately and its mutator result is returned
// — this path is byte-for-byte identical to before staging was added.
export function queueCommand(world, c) {
  if (world.paused && c.owner === HUMAN_OWNER) {
    world.pendingCommands.push({ ...c });
    return STAGED;
  }
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
