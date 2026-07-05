#!/usr/bin/env node
// One-off (Phase 1.5): derive the AAMUSTED brand palette from the official
// logo PNG (cropped-AAMUSTED-NEW-LOGO-26.png at the repo root) by sampling
// actual crest pixels, then compute WCAG 2.x relative-luminance contrast
// ratios for every theme foreground/background pair we set in globals.css,
// iterating lightness until each pair clears 4.5:1.
//
// Not part of the app build — kept in scripts/ for reproducibility. Run:
//   node scripts/derive-brand-palette.mjs
//
// It prints: (1) the dominant maroon/gold/green hex sampled from the logo,
// (2) the final theme tokens as hex, (3) the contrast ratio for each pair.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PNG } from "pngjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logoPath = path.resolve(__dirname, "..", "cropped-AAMUSTED-NEW-LOGO-26.png");

// --- color helpers ---------------------------------------------------------

const toHex = (r, g, b) =>
  "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

// sRGB -> relative luminance (WCAG 2.x definition).
function relLuminance({ r, g, b }) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(hexA, hexB) {
  const l1 = relLuminance(hexToRgb(hexA));
  const l2 = relLuminance(hexToRgb(hexB));
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// RGB <-> HSL so we can nudge *lightness* only (keep the brand hue).
function rgbToHsl({ r, g, b }) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r:
        h = ((g - b) / d) % 6;
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
}

function hslToHex({ h, s, l }) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return toHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

/**
 * Adjust a hex color's lightness (hue/saturation preserved) until it clears
 * `minRatio` against `bg`. `direction` = "darken" (for light backgrounds) or
 * "lighten" (for dark backgrounds).
 */
function fitLightness(hex, bg, minRatio, direction) {
  const hsl = rgbToHsl(hexToRgb(hex));
  const step = 0.01;
  let l = hsl.l;
  let out = hslToHex({ ...hsl, l });
  let guard = 0;
  while (contrastRatio(out, bg) < minRatio && guard < 200) {
    l += direction === "lighten" ? step : -step;
    l = Math.max(0, Math.min(1, l));
    out = hslToHex({ ...hsl, l });
    guard += 1;
    if (l <= 0 || l >= 1) break;
  }
  return out;
}

// --- sample the logo -------------------------------------------------------

const png = PNG.sync.read(readFileSync(logoPath));
const { width, height, data } = png;

// Bucket opaque, reasonably-saturated pixels by coarse hue family and track
// the most common representative in each of maroon / gold / green ranges.
const families = {
  maroon: { hueMin: 330, hueMax: 20, count: 0, r: 0, g: 0, b: 0 },
  gold: { hueMin: 35, hueMax: 65, count: 0, r: 0, g: 0, b: 0 },
  green: { hueMin: 90, hueMax: 160, count: 0, r: 0, g: 0, b: 0 },
};

function inHue(h, min, max) {
  return min > max ? h >= min || h <= max : h >= min && h <= max;
}

for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const idx = (width * y + x) << 2;
    const a = data[idx + 3];
    if (a < 200) continue; // skip transparent background
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const { h, s, l } = rgbToHsl({ r, g, b });
    if (s < 0.25 || l < 0.12 || l > 0.9) continue; // skip near-grey/black/white
    for (const fam of Object.values(families)) {
      if (inHue(h, fam.hueMin, fam.hueMax)) {
        fam.count += 1;
        fam.r += r;
        fam.g += g;
        fam.b += b;
      }
    }
  }
}

const sampled = {};
for (const [name, fam] of Object.entries(families)) {
  if (fam.count === 0) {
    sampled[name] = null;
    continue;
  }
  sampled[name] = toHex(fam.r / fam.count, fam.g / fam.count, fam.b / fam.count);
}

console.log("=== Sampled dominant brand colors (mean of in-family opaque pixels) ===");
for (const [name, hex] of Object.entries(sampled)) {
  console.log(`  ${name.padEnd(8)}: ${hex} (${families[name].count} px)`);
}

// --- derive theme tokens, fitting each pair to >= 4.5:1 --------------------

const MAROON = sampled.maroon ?? "#8E1F44";
const GOLD = sampled.gold ?? "#F2B807";
const GREEN = sampled.green ?? "#1D7A3D";

const WHITE = "#ffffff";
const BLACK = "#000000";
// Backgrounds from globals.css: light bg ~ oklch(1 0 0) = #ffffff;
// card is also white. Dark bg ~ oklch(0.145 0 0) ~= #252525. High-contrast bg #ffffff.
const DARK_BG = "#252525";

function report(label, fg, bg) {
  const ratio = contrastRatio(fg, bg);
  const pass = ratio >= 4.5 ? "PASS" : ratio >= 3 ? "PASS(3:1)" : "FAIL";
  console.log(`  ${label.padEnd(42)} fg=${fg} on bg=${bg}  ratio=${ratio.toFixed(2)}:1  ${pass}`);
  return ratio;
}

console.log("\n=== LIGHT + HIGH-CONTRAST theme (white background) ===");
// primary = maroon, white foreground text sits ON the maroon → check white-on-maroon.
const primaryLight = fitLightness(MAROON, WHITE, 4.5, "darken");
report("primary(maroon) as bg, white text on it", WHITE, primaryLight);
// accent = gold, dark (near-black) foreground on gold.
const accentLight = fitLightness(GOLD, BLACK, 4.5, "darken");
report("accent(gold) as bg, black text on it", BLACK, accentLight);
// success = green, white foreground on green.
const successLight = fitLightness(GREEN, WHITE, 4.5, "darken");
report("success(green) as bg, white text on it", WHITE, successLight);
// Also: these used as text color on white background (e.g. success text/icon).
const successTextLight = fitLightness(GREEN, WHITE, 4.5, "darken");
report("success(green) as text on white bg", successTextLight, WHITE);

console.log("\n=== DARK theme (bg ~ #252525) ===");
// primary lightened maroon; dark foreground on it (primary-foreground in dark is dark).
const primaryDark = fitLightness(MAROON, DARK_BG, 4.5, "lighten");
report("primary(maroon,dark) as text on dark bg", primaryDark, DARK_BG);
// white text on the dark-primary chip:
report("primary(maroon,dark) as bg, black text", BLACK, primaryDark);
const accentDark = fitLightness(GOLD, DARK_BG, 4.5, "lighten");
report("accent(gold,dark) as text on dark bg", accentDark, DARK_BG);
const successDark = fitLightness(GREEN, DARK_BG, 4.5, "lighten");
report("success(green,dark) as text on dark bg", successDark, DARK_BG);

console.log("\n=== FINAL TOKEN HEXES ===");
console.log(
  JSON.stringify(
    {
      sampled: { maroon: MAROON, gold: GOLD, green: GREEN },
      light: { primary: primaryLight, accent: accentLight, success: successLight },
      dark: { primary: primaryDark, accent: accentDark, success: successDark },
    },
    null,
    2,
  ),
);
