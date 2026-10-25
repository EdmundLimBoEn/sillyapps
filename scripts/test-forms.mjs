import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

for (const [page, marker, endpoint] of [
  ["index.html", "data-waitlist-form", "/api/waitlist"],
  ["admin/index.html", "data-login-form", "/api/waitlist/session"],
]) {
  test(`${marker} keeps native submissions out of the URL`, () => {
    const html = readFileSync(new URL(`../site/${page}`, import.meta.url), "utf8");
    const form = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)]
      .find((match) => new RegExp(`\\b${marker}\\b`).test(match[1]));
    assert.ok(form, "the sensitive form must exist");
    // Inspect the shipped HTML: JavaScript handlers cannot protect native submission.
    assert.match(form[1], /\bmethod\s*=\s*["']post["']/i);
    const action = form[1].match(/\baction\s*=\s*["']([^"']*)["']/i);
    assert.equal(action?.[1], endpoint);
    assert.doesNotMatch(form[2], /\bform(?:method|action)\s*=/i,
      "submit controls must not override the safe form destination or method");
  });
}
