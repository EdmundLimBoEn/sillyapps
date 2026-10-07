#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cssPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "site", "styles.css");
const css = fs.readFileSync(cssPath, "utf8");

const TOKEN_RE =
  /--([a-z0-9-]+)\s*:\s*light-dark\(\s*(#[0-9a-fA-F]{3,8})\s*,\s*(#[0-9a-fA-F]{3,8})\s*\)/g;

const PAIRS = [
  ["body text", "ink", "paper"],
  ["card text", "ink", "card"],
  ["muted text", "muted", "paper"],
  ["muted on card", "muted", "card"],
  ["notes", "muted", "paper"],
  ["link / success", "sage", "paper"],
  ["link / success on card", "sage", "card"],
  ["error / delete", "err", "paper"],
  ["error on card", "err", "card"],
  ["primary button", "btn-ink", "btn"],
  ["ghost button", "ink", "card"],
  ["ghost on paper", "ink", "paper"],
  ["skip link", "card", "ink"],
  ["input text", "ink", "paper"],
  ["placeholder", "muted", "paper"],
  ["table header", "muted", "card"],
  ["admin timestamp", "muted", "card"],
];

const AA_NORMAL = 4.5;

function expandHex(hex) {
  const raw = hex.slice(1);
  if (raw.length === 3 || raw.length === 4) {
    return `#${[...raw].map((ch) => ch + ch).join("")}`;
  }
  return hex;
}

function hexToRgb(hex) {
  const full = expandHex(hex);
  const n = parseInt(full.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function relativeLuminance([r, g, b]) {
  const toLinear = (channel) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [toLinear(r), toLinear(g), toLinear(b)];
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function contrastRatio(fg, bg) {
  const L1 = relativeLuminance(hexToRgb(fg));
  const L2 = relativeLuminance(hexToRgb(bg));
  const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
}

function parseTokens(source) {
  const light = {};
  const dark = {};
  for (const match of source.matchAll(TOKEN_RE)) {
    light[match[1]] = match[2];
    dark[match[1]] = match[3];
  }
  return { light, dark };
}

const { light, dark } = parseTokens(css);
const required = [...new Set(PAIRS.flatMap(([, fg, bg]) => [fg, bg]))];
const missing = required.filter((name) => !light[name] || !dark[name]);
if (missing.length) {
  console.error("Missing light-dark() tokens:", missing.join(", "));
  process.exit(1);
}

let failed = 0;
for (const [themeName, tokens] of [
  ["light", light],
  ["dark", dark],
]) {
  console.log(`\n${themeName}`);
  for (const [label, fgName, bgName] of PAIRS) {
    const ratio = contrastRatio(tokens[fgName], tokens[bgName]);
    const ok = ratio + 1e-9 >= AA_NORMAL;
    const line = `  ${ok ? "PASS" : "FAIL"} ${ratio.toFixed(2)}:1 ${label} (${fgName} ${tokens[fgName]} on ${bgName} ${tokens[bgName]})`;
    if (ok) {
      console.log(line);
    } else {
      console.error(line);
      failed += 1;
    }
  }
}

if (failed) {
  console.error(`\n${failed} text/background pair(s) below WCAG AA (${AA_NORMAL}:1).`);
  process.exit(1);
}

console.log("\ncontrast checks passed");
