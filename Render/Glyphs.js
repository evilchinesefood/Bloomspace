// Render/Glyphs.js — render a Font Awesome (Free, solid weight 900) glyph to a CanvasTexture
// so the WebGL layer can use FA icons as sprites (white glyph on transparent, tint via
// instanceColor). The webfont may not be parsed at first draw, so we redraw when it's ready.
import * as THREE from "three";

// Code points from the vendored Font Awesome 6 Free CSS. Free icons only (no Pro).
export const ICON = {
  fighter: 0xe518, // jet-fighter-up  (free stand-in for a "starfighter")
  defender: 0xf197, // shuttle-space   (free stand-in for a defensive "freighter")
  sprout: 0xf4d8, // seedling        (young seedling tree)
  tree: 0xf1bb, // tree            (mature seedling tree)
  shield: 0xf3ed, // shield-halved   (defense tree)
};

const FONT = '900 %px "Font Awesome 6 Free"';

export function glyphTexture(code, px = 128) {
  const cv = document.createElement("canvas");
  cv.width = cv.height = px;
  const ctx = cv.getContext("2d");
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  function draw() {
    ctx.clearRect(0, 0, px, px);
    ctx.fillStyle = "#ffffff";
    ctx.font = FONT.replace("%", Math.floor(px * 0.82));
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String.fromCharCode(code), px / 2, px / 2);
    tex.needsUpdate = true;
  }
  draw();
  if (typeof document !== "undefined" && document.fonts) {
    document.fonts
      .load('900 1em "Font Awesome 6 Free"')
      .then(draw)
      .catch(() => {});
    document.fonts.ready.then(draw);
  }
  return tex;
}
