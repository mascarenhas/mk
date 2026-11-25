#!/usr/bin/env node
/**
 * Verifies src/styles/brand.css against Cassini's surfaces in both themes:
 *   - each theme block overrides exactly Cassini's 7 `--brand-*` tokens, nothing else
 *   - WCAG 2.x contrast ratios of the solid brand colors on every surface
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRAND_CSS = path.join(ROOT, "src/styles/brand.css");
const TOKENS_CSS = path.join(ROOT, ".generated/cassini/src/styles/tokens.css");

const BRAND_TOKENS = [
  "--brand-accent",
  "--brand-accent-bright",
  "--brand-accent-muted",
  "--brand-accent-secondary",
  "--brand-accent-ink",
  "--brand-glow",
  "--brand-ring-gradient",
];
const SURFACES = ["--surface-void", "--surface-canvas", "--surface-elevated", "--surface-raised"];

// Minimum ratio of each foreground on every surface. 7:1 is WCAG AAA for body text;
// kickers (`--brand-accent-muted`) are bold uppercase micro-labels held to AA 4.5:1.
const SURFACE_MINIMUMS = {
  "--brand-accent": 7,
  "--brand-accent-bright": 7,
  "--brand-accent-secondary": 7,
  "--brand-accent-muted": 4.5,
};

const SELECTORS = {
  dark: /(?:^|\n)\s*:root\s*\{([^}]*)\}/,
  light: /(?:^|\n)\s*:root\[data-theme="light"\]\s*\{([^}]*)\}/,
};

function declarations(css, theme, file) {
  const block = css.replace(/\/\*[\s\S]*?\*\//g, "").match(SELECTORS[theme]);
  if (!block) throw new Error(`No ${theme} :root block in ${file}`);
  const decls = new Map();
  for (const m of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) decls.set(m[1], m[2].trim());
  return decls;
}

function luminance(hex) {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) throw new Error(`Expected #rrggbb color, got ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const brandCss = fs.readFileSync(BRAND_CSS, "utf8");
const tokensCss = fs.readFileSync(TOKENS_CSS, "utf8");
const errors = [];
const report = {};

for (const theme of ["dark", "light"]) {
  const brand = declarations(brandCss, theme, "brand.css");
  const tokens = declarations(tokensCss, theme, "tokens.css");

  const declared = [...brand.keys()].sort();
  const expected = [...BRAND_TOKENS].sort();
  if (declared.join() !== expected.join()) {
    errors.push(`${theme}: brand.css must declare exactly ${expected.join(", ")}; found ${declared.join(", ")}`);
    continue;
  }

  const rows = {};
  for (const [token, min] of Object.entries(SURFACE_MINIMUMS)) {
    rows[token] = {};
    for (const surface of SURFACES) {
      const ratio = contrast(brand.get(token), tokens.get(surface));
      rows[token][surface.replace("--surface-", "")] = +ratio.toFixed(2);
      if (ratio < min) {
        errors.push(`${theme}: ${token} ${brand.get(token)} on ${surface} is ${ratio.toFixed(2)}:1 (< ${min}:1)`);
      }
    }
  }
  for (const solid of ["--brand-accent", "--brand-accent-bright"]) {
    const ratio = contrast(brand.get("--brand-accent-ink"), brand.get(solid));
    rows[`--brand-accent-ink on ${solid}`] = +ratio.toFixed(2);
    if (ratio < 7) errors.push(`${theme}: --brand-accent-ink on ${solid} is ${ratio.toFixed(2)}:1 (< 7:1)`);
  }
  report[theme] = rows;
}

console.log("[check-contrast] WCAG contrast ratios:\n" + JSON.stringify(report, null, 2));
if (errors.length > 0) {
  console.error(`\n[check-contrast] FAILED with ${errors.length} error(s):`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log("[check-contrast] PASS — brand tokens meet AAA (accent/bright/secondary/ink) and AA (muted) in both themes.");
