/*
 * Regenerates icons/icon-32.png and icons/icon-64.png from icons/icon.svg.
 *
 * This is a one-off asset step, NOT part of building the add-on, and the
 * rasteriser is deliberately not a project dependency. Run it only when the
 * artwork in icons/icon.svg changes:
 *
 *   npm install --no-save @resvg/resvg-js@2.6.2
 *   node tools/render-icons.js
 *
 * The committed PNGs are the authoritative artwork used by manifest.json; this
 * script is included so they can be reproduced from the SVG source.
 */

const fs = require("fs");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");

const SIZES = [32, 64];

const root = path.resolve(__dirname, "..");
const svgPath = path.join(root, "icons", "icon.svg");
const svg = fs.readFileSync(svgPath, "utf8");

for (const size of SIZES) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    // No `background` option, so the output keeps a transparent background.
    shapeRendering: 2, // geometricPrecision
    imageRendering: 0, // optimizeQuality
  });
  const png = resvg.render().asPng();
  const out = path.join(root, "icons", `icon-${size}.png`);
  fs.writeFileSync(out, png);
  console.log(`${path.relative(root, out).replace(/\\/g, "/")}  ${png.length} bytes`);
}
