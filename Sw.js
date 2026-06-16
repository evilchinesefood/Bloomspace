// Sw.js — service worker. Cache-first with network fallback.
// IMPORTANT: bump CACHE_VERSION on EVERY deploy or clients keep stale assets.
const CACHE_VERSION = "bloomspace-v1";

// App shell + heavy vendored deps. Web Awesome statically imports a graph of chunks from
// its loader and also lazy-loads component chunks on demand; that recursive chunk graph is
// cached at runtime by the fetch handler, not precached here. Full first-load-offline
// support (precaching the whole WA chunk graph) is scheduled for T8's final SW cache pass.
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
        .catch(() => cached);
    }),
  );
});
