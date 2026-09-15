#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";
import { onRequestGet, onRequestPost } from "../functions/api/waitlist.js";
import {
  csvCell,
  parseSignup,
  toCsv,
  tokensMatch,
} from "../functions/lib/waitlist.js";

function request(url, init) {
  return new Request(url, init);
}

function memoryDb() {
  const rows = new Map();
  function statement(sql, bound = []) {
    return {
      bind(...args) {
        return statement(sql, args);
      },
      async run() {
        if (String(sql).includes("INSERT")) {
          const [email, name] = bound;
          if (!rows.has(email)) {
            rows.set(email, { email, name, created_at: "2026-09-15 12:00:00" });
          }
        }
      },
      async all() {
        return { results: [...rows.values()] };
      },
    };
  }
  return {
    rows,
    prepare(sql) {
      return statement(sql);
    },
  };
}

test("parseSignup lowercases and trims email", () => {
  assert.deepEqual(parseSignup({ email: "  Ada@Example.COM ", name: " Ada " }), {
    ok: true,
    signup: { email: "ada@example.com", name: "Ada" },
  });
});

test("parseSignup treats missing name as null", () => {
  assert.deepEqual(parseSignup({ email: "ada@example.com" }), {
    ok: true,
    signup: { email: "ada@example.com", name: null },
  });
});

test("parseSignup rejects a missing or malformed email", () => {
  assert.deepEqual(parseSignup({}), { ok: false, code: "invalid_email" });
  assert.deepEqual(parseSignup({ email: "nope" }), { ok: false, code: "invalid_email" });
  assert.deepEqual(parseSignup({ email: "a@b.c" }), { ok: false, code: "invalid_email" });
  assert.deepEqual(parseSignup({ email: "ada@.com" }), { ok: false, code: "invalid_email" });
  assert.deepEqual(parseSignup({ email: "ada@ex..com" }), { ok: false, code: "invalid_email" });
});

test("parseSignup flags a filled honeypot as spam", () => {
  assert.deepEqual(
    parseSignup({ email: "ada@example.com", company: "bots inc" }),
    { ok: false, code: "spam" }
  );
});

test("parseSignup caps name length at 80", () => {
  const name = "n".repeat(100);
  assert.equal(parseSignup({ email: "ada@example.com", name }).signup.name.length, 80);
});

test("toCsv quotes commas and writes a header", () => {
  assert.equal(
    toCsv([
      { email: "ada@example.com", name: "Ada, Lim", created_at: "2026-09-15 12:00:00" },
    ]),
    'email,name,created_at\nada@example.com,"Ada, Lim",2026-09-15 12:00:00\n'
  );
});

test("csvCell quotes quotes", () => {
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
});

test("tokensMatch compares equal secrets", () => {
  assert.equal(tokensMatch("secret-token", "secret-token"), true);
  assert.equal(tokensMatch("secret-token", "other-token-x"), false);
  assert.equal(tokensMatch("", "secret-token"), false);
});

test("POST writes a valid signup", async () => {
  const db = memoryDb();
  const res = await onRequestPost({
    request: request("https://sillyapps.co/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "Ada@Example.com", name: "Ada" }),
    }),
    env: { DB: db },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(db.rows.get("ada@example.com"), {
    email: "ada@example.com",
    name: "Ada",
    created_at: "2026-09-15 12:00:00",
  });
});

test("POST ignores a repeat email", async () => {
  const db = memoryDb();
  db.rows.set("ada@example.com", {
    email: "ada@example.com",
    name: "Ada",
    created_at: "2026-09-15 12:00:00",
  });
  const res = await onRequestPost({
    request: request("https://sillyapps.co/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com", name: "Other" }),
    }),
    env: { DB: db },
  });
  assert.equal(res.status, 200);
  assert.equal(db.rows.get("ada@example.com").name, "Ada");
});

test("POST drops honeypot spam without writing", async () => {
  const db = memoryDb();
  const res = await onRequestPost({
    request: request("https://sillyapps.co/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "bot@example.com", company: "spam" }),
    }),
    env: { DB: db },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(db.rows.size, 0);
});

test("POST rejects an invalid email with 400", async () => {
  const res = await onRequestPost({
    request: request("https://sillyapps.co/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nope" }),
    }),
    env: { DB: memoryDb() },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { ok: false, error: "invalid_email" });
});

test("GET export returns csv for a valid bearer token", async () => {
  const db = memoryDb();
  db.rows.set("ada@example.com", {
    email: "ada@example.com",
    name: "Ada",
    created_at: "2026-09-15 12:00:00",
  });
  const res = await onRequestGet({
    request: request("https://sillyapps.co/api/waitlist", {
      headers: { authorization: "Bearer dev-waitlist-token" },
    }),
    env: { DB: db, WAITLIST_ADMIN_TOKEN: "dev-waitlist-token" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(
    await res.text(),
    "email,name,created_at\nada@example.com,Ada,2026-09-15 12:00:00\n"
  );
});

test("GET export is hidden when the admin token is unset", async () => {
  const res = await onRequestGet({
    request: request("https://sillyapps.co/api/waitlist"),
    env: { DB: memoryDb() },
  });
  assert.equal(res.status, 404);
});
