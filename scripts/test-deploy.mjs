import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("deployment pins Wrangler with the GHSA-r4xh-jqrq-34v2 fix", () => {
  const workflow = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
  const pins = [...workflow.matchAll(/^\s*wranglerVersion:\s*["']?(\d+)\.(\d+)\.(\d+)["']?\s*(?:#.*)?$/gm)];
  assert.ok(pins.length > 0, "deployment must explicitly pin a stable Wrangler version");
  for (const [, major, minor] of pins) {
    // Wrangler 4.139.0 first includes smol-toml 1.9.0; 4.136.3 is still affected.
    assert.ok(Number(major) > 4 || (Number(major) === 4 && Number(minor) >= 139),
      "Wrangler must be at least 4.139.0 to include the TOML parser fix");
  }
});
