#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "site");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const js = fs.readFileSync(path.join(root, "waitlist.js"), "utf8");
const page = `${html}\n${css}\n${js}`;

const required = [
  ["title", /<title>Silly Apps, small free apps by Edmund Lim<\/title>/],
  ["meta description", /<meta name="description" content="sillyapps is Edmund Lim's list of small free apps\./],
  ["canonical", /<link rel="canonical" href="https:\/\/sillyapps\.co\/">/],
  ["og:title", /<meta property="og:title" content="Silly Apps, small free apps by Edmund Lim">/],
  ["og:description", /<meta property="og:description"/],
  ["og:image", /<meta property="og:image" content="https:\/\/sillyapps\.co\/assets\/og\.png">/],
  ["og:url", /<meta property="og:url" content="https:\/\/sillyapps\.co\/">/],
  ["twitter:card", /<meta name="twitter:card" content="summary_large_image">/],
  ["Lazy Man's Reminders", /Lazy Man's Reminders/],
  ["UsageWidget", /UsageWidget/],
  ["waitlist heading", /id="waitlist-heading">Join the waitlist</],
  ["waitlist form", /data-waitlist-form/],
  ["email field", /id="waitlist-email"/],
  ["name field", /id="waitlist-name"/],
  ["honeypot", /name="company"/],
  ["privacy line", /Emails are only used to tell you when an app launches\./],
  ["waitlist endpoint", /\/api\/waitlist/],
];

const banned = [
  ["TestFlight", /testflight/i],
  ["App Store CTA", /app store/i],
  ["Apple store host", /apps\.apple\.com/i],
  ["iTunes host", /itunes\.apple\.com/i],
  ["LMR board", /lmr\.edmundlim\.systems/i],
  ["UsageWidget host", /usagewidget\.edmundlim\.systems/i],
  ["Get it CTA", /get it on/i],
];

const missing = required
  .filter(([name, re]) => !(name === "waitlist endpoint" ? re.test(page) : re.test(html)))
  .map(([name]) => name);
if (missing.length) {
  console.error("Missing:", missing.join(", "));
  process.exit(1);
}

const leaked = banned.filter(([, re]) => re.test(page)).map(([name]) => name);
if (leaked.length) {
  console.error("Banned store or outbound CTA still present:", leaked.join(", "));
  process.exit(1);
}

const robots = fs.readFileSync(path.join(root, "robots.txt"), "utf8");
if (!/Disallow: \/admin\b/.test(robots)) {
  console.error("robots.txt must disallow /admin");
  process.exit(1);
}

for (const file of ["assets/og.png", "assets/apple-touch-icon.png", "favicon.svg", "styles.css", "waitlist.js", "404.html", "robots.txt", "_headers", "admin/index.html", "admin/admin.js"]) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    console.error("Missing file:", file);
    process.exit(1);
  }
}

if (fs.existsSync(path.join(root, "apps.js"))) {
  console.error("Stale placeholder script still present: apps.js");
  process.exit(1);
}

const adminHtml = fs.readFileSync(path.join(root, "admin/index.html"), "utf8");
if (!/noindex/.test(adminHtml) || !/data-login-form/.test(adminHtml)) {
  console.error("admin page must be noindex and include the token form");
  process.exit(1);
}

console.log("site checks passed");
