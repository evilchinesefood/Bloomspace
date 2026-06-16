# Vendored dependencies

All runtime third-party code is **free, redistributable, and committed** so a fresh
`git clone` runs fully offline. No CDN fetch, no npm at runtime, no license/kit token.

| Dependency          | Version      | License                          | Source URL                                                                                                                    | Vendored at             |
| ------------------- | ------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| three.js (core)     | 0.160.0      | MIT                              | https://unpkg.com/three@0.160.0/build/three.module.js                                                                         | `Three/Three.module.js` |
| three.js jsm addons | 0.160.0      | MIT                              | https://unpkg.com/three@0.160.0/examples/jsm/...                                                                              | `Three/Jsm/...`         |
| Web Awesome (free)  | 3.0.0-beta.3 | MIT                              | npm `@awesome.me/webawesome@3.0.0-beta.3` (`dist-cdn/`), mirror of https://early.webawesome.com/webawesome@3.0.0-beta.3/dist/ | `WebAwesome/`           |
| Font Awesome Free   | 6.5.1        | SIL OFL 1.1 (fonts) / MIT (code) | https://unpkg.com/@fortawesome/fontawesome-free@6.5.1/                                                                        | `FontAwesome/`          |

## three.js addon path exception (important)

Our project rule is PascalCase for every file/directory **we author**. Third-party
vendored code keeps its **upstream paths untouched** so the library's own imports resolve.

The three jsm addons use **bare `import ... from "three"`** (resolved by the import map in
`Index.html`) and import siblings via **lowercase relative paths** like
`../shaders/CopyShader.js`. We therefore keep the addon subtree under `Three/Jsm/` with the
upstream lowercase folder names `postprocessing/` and `shaders/` so those relative imports
work without modification. We did NOT rewrite three's internal paths.

Vendored addons (under `Three/Jsm/`):

- `postprocessing/` — EffectComposer, RenderPass, UnrealBloomPass, OutputPass, ShaderPass, MaskPass
- `shaders/` — CopyShader, LuminosityHighPassShader, OutputShader (imported by the passes above)

Import map (in `Index.html`):

```json
{
  "three": "./Vendor/Three/Three.module.js",
  "three/addons/": "./Vendor/Three/Jsm/"
}
```

## Font Awesome webfont casing

`FontAwesome/Css/All.min.css` originally referenced `../webfonts/` (lowercase). Because
HTTP paths are case-sensitive and our folder is PascalCase `Webfonts/`, the CSS `url(...)`
references were rewritten to `../Webfonts/`. The webfont binaries themselves are upstream,
unmodified.

## Web Awesome

The whole `dist-cdn/` build is vendored (relative-import chunks, offline-safe). It
lazy-loads component chunks on demand; `Index.html` calls `setBasePath()` to point the
loader at this folder so nothing is ever fetched from a CDN and no kit token is used.
