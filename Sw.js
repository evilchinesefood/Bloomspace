// Sw.js — service worker. Cache-first with network fallback.
// IMPORTANT: bump CACHE_VERSION on EVERY deploy or clients keep stale assets.
const CACHE_VERSION = "bloomspace-v1";

// App shell + heavy vendored deps. Web Awesome lazy-loads its ~150 component chunks on
// demand; those are cached at runtime by the fetch handler rather than precached here.
// All URLs are relative so they resolve correctly under a deploy subpath.
const SHELL = [
  "./",
  "Index.html",
  "Main.js",
  "Game.js",
  "Manifest.webmanifest",
  "Icons/Icon.svg",
  "Sim/World.js",
  "Render/Scene.js",
  "Render/SeedlingView.js",
  "Vendor/Three/Three.module.js",
  "Vendor/Three/Jsm/postprocessing/EffectComposer.js",
  "Vendor/Three/Jsm/postprocessing/RenderPass.js",
  "Vendor/Three/Jsm/postprocessing/UnrealBloomPass.js",
  "Vendor/Three/Jsm/postprocessing/OutputPass.js",
  "Vendor/Three/Jsm/postprocessing/ShaderPass.js",
  "Vendor/Three/Jsm/postprocessing/MaskPass.js",
  "Vendor/Three/Jsm/shaders/CopyShader.js",
  "Vendor/Three/Jsm/shaders/LuminosityHighPassShader.js",
  "Vendor/Three/Jsm/shaders/OutputShader.js",
  "Vendor/FontAwesome/Css/All.min.css",
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
          if (res && res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
    }),
  );
});
