#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "site");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

const required = [
  ["title", /<title>Silly Apps, small free apps by Edmund Lim<\/title>/],
  ["meta description", /<meta name="description" content="Silly Apps is Edmund Lim's list of small free apps\./],
  ["canonical", /<link rel="canonical" href="https:\/\/sillyapps\.co\/">/],
  ["og:title", /<meta property="og:title" content="Silly Apps, small free apps by Edmund Lim">/],
  ["og:description", /<meta property="og:description"/],
  ["og:image", /<meta property="og:image" content="https:\/\/sillyapps\.co\/assets\/og\.png">/],
  ["og:url", /<meta property="og:url" content="https:\/\/sillyapps\.co\/">/],
  ["twitter:card", /<meta name="twitter:card" content="summary_large_image">/],
  ["Lazy Man's Reminders", /Lazy Man's Reminders/],
  ["UsageWidget", /UsageWidget/],
  ["TestFlight CTA", /Get it on TestFlight/],
  ["App Store placeholder", /Get it on the App Store/],
  ["web board", /https:\/\/lmr\.edmundlim\.systems/],
  ["UsageWidget GitHub", /https:\/\/github\.com\/EdmundLimBoEn\/UsageWidget/],
];

const missing = required.filter(([, re]) => !re.test(html)).map(([name]) => name);
if (missing.length) {
  console.error("Missing:", missing.join(", "));
  process.exit(1);
}

for (const file of ["assets/og.png", "assets/apple-touch-icon.png", "favicon.svg", "styles.css", "apps.js", "404.html", "robots.txt", "_headers"]) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    console.error("Missing file:", file);
    process.exit(1);
  }
}

console.log("site checks passed");
