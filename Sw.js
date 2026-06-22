// Sw.js — service worker. Cache-first with network fallback.
// IMPORTANT: bump CACHE_VERSION on EVERY deploy or clients keep stale assets.
const CACHE_VERSION = "bloomspace-v36";

// App shell + heavy vendored deps. Web Awesome statically imports a graph of chunks from
// its loader and also lazy-loads component chunks on demand; that recursive chunk graph is
// cached at runtime by the fetch handler, not precached here. Full first-load-offline
// support (precaching the whole WA chunk graph) remains a runtime concern: the fetch
// handler caches each WA chunk on first use. All first-party modules ARE precached below —
// when you add a NEW Sim/Render/Ui module, add it here too. URLs stay relative for subpaths.
const SHELL = [
  "./",
  "Index.html",
  "Main.js",
  "Game.js",
  "Manifest.webmanifest",
  "Icons/Icon.svg",
  "Ui/App.js",
  "Ui/Hud.js",
  "Ui/Overlay.js",
  "Ui/Menus.js",
  "Ui/Input.js",
  "Ui/Sound.js",
  "Ui/Persist.js",
  "Ui/Tutorial.js",
  "Audio/Send.wav",
  "Audio/Capture.wav",
  "Audio/Death.wav",
  "Audio/Plant.wav",
  "Audio/Fire.wav",
  "Audio/Win.wav",
  "Audio/Lose.wav",
  "Audio/Alert.wav",
  "Audio/Explosion.wav",
  "Audio/Flare.wav",
  "Audio/Meteor.wav",
  "Audio/AmbientDeep.wav",
  "Audio/AmbientShimmer.wav",
  "Sim/World.js",
  "Sim/Tech.js",
  "Sim/MapGen.js",
  "Sim/Moons.js",
  "Sim/Seedlings.js",
  "Sim/Combat.js",
  "Sim/Economy.js",
  "Sim/Trees.js",
  "Sim/Bombard.js",
  "Sim/Upgrade.js",
  "Sim/Ai.js",
  "Sim/Save.js",
  "Sim/Hazards.js",
  "Sim/Fog.js",
  "Render/Scene.js",
  "Render/SeedlingView.js",
  "Render/AsteroidView.js",
  "Render/EdgeLayer.js",
  "Render/TreeView.js",
  "Render/Fx.js",
  "Render/Picking.js",
  "Render/Palette.js",
  "Render/Minimap.js",
  "Render/Glyphs.js",
  "Render/Theme.js",
  "Vendor/Three/Three.module.js",
  "Vendor/Three/Jsm/postprocessing/EffectComposer.js",
  "Vendor/Three/Jsm/postprocessing/Pass.js",
  "Vendor/Three/Jsm/postprocessing/RenderPass.js",
  "Vendor/Three/Jsm/postprocessing/UnrealBloomPass.js",
  "Vendor/Three/Jsm/postprocessing/OutputPass.js",
  "Vendor/Three/Jsm/postprocessing/ShaderPass.js",
  "Vendor/Three/Jsm/postprocessing/MaskPass.js",
  "Vendor/Three/Jsm/shaders/CopyShader.js",
  "Vendor/Three/Jsm/shaders/LuminosityHighPassShader.js",
  "Vendor/Three/Jsm/shaders/OutputShader.js",
  "Vendor/FontAwesome/Css/All.min.css",
  "Vendor/FontAwesome/Webfonts/fa-solid-900.woff2",
  "Vendor/FontAwesome/Webfonts/fa-regular-400.woff2",
  "Vendor/FontAwesome/Webfonts/fa-brands-400.woff2",
  "Vendor/WebAwesome/webawesome.loader.js",
  "Vendor/WebAwesome/styles/webawesome.css",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) =>
        Promise.allSettled(
          SHELL.map((u) => cache.add(new Request(u, { cache: "reload" }))),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          // Runtime-cache same-origin GETs (e.g. Web Awesome's lazy chunks). status===200
          // only; opaque/cross-origin and partial (206) responses are skipped.
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          // Network failed (offline) and the resource wasn't cached above. For a navigation,
          // boot the cached app shell so the PWA still launches; otherwise return an explicit
          // 504 so respondWith never resolves to undefined (which surfaces as a confusing hard
          // network error). `cached` is always undefined here — the cache hit returned at line 111.
          req.mode === "navigate"
            ? caches.match("Index.html")
            : new Response("", { status: 504, statusText: "Offline" }),
        );
    }),
  );
});
