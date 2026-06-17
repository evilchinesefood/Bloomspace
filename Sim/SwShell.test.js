// SwShell.test.js — guards the buildless deploy footgun: Sw.js precaches a hand-maintained
// SHELL list of first-party modules. If a new Sim/Render/Ui module is imported but not added
// to SHELL, the app still works online but breaks offline / on a stale service worker after
// deploy. This walks the import graph from Main.js and asserts every reachable first-party
// module appears in Sw.js's SHELL. A forgotten entry becomes a red `npm test`, not a prod bug.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Collect every relative import specifier from a JS source file.
function importsOf(src) {
  const out = [];
  const re = /(?:import|export)[^"']*?from\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  // Also dynamic import("...") forms.
  const dre = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dre.exec(src))) out.push(m[1]);
  return out;
}

// Walk first-party imports reachable from Main.js. Bare specifiers (three, three/addons)
// and anything under Vendor/ are vendored deps, cached at runtime — not part of this check.
function firstPartyGraph(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const abs = stack.pop();
    const rel = path.relative(ROOT, abs).split(path.sep).join("/");
    if (seen.has(rel)) continue;
    seen.add(rel);
    let src;
    try {
      src = readFileSync(abs, "utf8");
    } catch {
      assert.fail(`import graph references missing file: ${rel}`);
    }
    for (const spec of importsOf(src)) {
      if (!spec.startsWith(".")) continue; // bare (three, etc.) — vendored
      const target = path.resolve(path.dirname(abs), spec);
      const t = path.relative(ROOT, target).split(path.sep).join("/");
      if (t.startsWith("Vendor/")) continue;
      stack.push(target);
    }
  }
  return seen;
}

test("every first-party module reachable from Main.js is precached in Sw.js SHELL", () => {
  const sw = readFileSync(path.join(ROOT, "Sw.js"), "utf8");
  const graph = firstPartyGraph(path.join(ROOT, "Main.js"));
  const missing = [...graph].filter(
    (rel) => rel.endsWith(".js") && !sw.includes(`"${rel}"`),
  );
  assert.deepEqual(
    missing,
    [],
    `Sw.js SHELL is missing precache entries: ${missing.join(", ")}`,
  );
});

test("Sw.js cache version matches the Menus.js build stamp", () => {
  // Two hand-maintained version strings that must agree every deploy (Sw.js busts the cache;
  // Menus.js shows the player which build they're on). Drift = stale-build confusion — catch it.
  const sw = readFileSync(path.join(ROOT, "Sw.js"), "utf8");
  const menus = readFileSync(path.join(ROOT, "Ui", "Menus.js"), "utf8");
  const swV = (sw.match(/bloomspace-v(\d+)/) || [])[1];
  const menuV = (menus.match(/build v(\d+)/) || [])[1];
  assert.ok(swV, "Sw.js CACHE_VERSION (bloomspace-vN) not found");
  assert.ok(menuV, "Menus.js build stamp (build vN) not found");
  assert.equal(
    swV,
    menuV,
    `version drift: Sw.js v${swV} vs Menus.js v${menuV} — bump both together on deploy`,
  );
});
