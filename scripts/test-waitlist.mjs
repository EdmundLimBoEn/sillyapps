#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import "./test-admin.mjs";
import "./test-forms.mjs";
import "./test-deploy.mjs";
import {
  onRequestDelete,
  onRequestGet,
  onRequestPatch,
  onRequestPost,
} from "../functions/api/waitlist.js";
import {
  onRequestDelete as onSessionDelete,
  onRequestGet as onSessionGet,
  onRequestPost as onSessionPost,
} from "../functions/api/waitlist/session.js";
import {
  csvCell,
  filterSignups,
  lastSevenDays,
  parseLeadPatch,
  parseListQuery,
  parseSignup,
  toCsv,
  tokensMatch,
} from "../functions/lib/waitlist.js";

function request(url, init) {
  return new Request(url, init);
}

function memoryDb(options = {}) {
  const rows = new Map();
  const sessions = new Map();
  const rateLimits = new Map();
  const missingAdminColumns = Boolean(options.missingAdminColumns);

  function asRow(row) {
    return {
      email: row.email,
      name: row.name,
      created_at: row.created_at,
      emailed: row.emailed ? 1 : 0,
      note: row.note ?? null,
    };
  }

  function statement(sql, bound = []) {
    const text = String(sql);
    function selectedRows() {
      let i = 0;
      const query = {
        q: text.includes("instr(") ? bound[i++] : "",
        from: text.includes(">= ?") ? bound[i++] : "",
        to: text.includes("<= ?") ? bound[i++] : "",
        emailed: /(?:emailed|0) = \?/.test(text) ? bound[i++] : null,
      };
      return filterSignups([...rows.values()].map(asRow), query).sort((a, b) =>
        a.created_at.localeCompare(b.created_at) || a.email.localeCompare(b.email));
    }
    return {
      bind(...args) {
        return statement(sql, args);
      },
      async run() {
        if (text.includes("rate_limits")) {
          if (text.startsWith("UPDATE")) {
            const row = rateLimits.get(JSON.stringify(bound));
            if (row) row.count--;
          } else {
            for (const [key, row] of rateLimits) {
              if (row.window_start < bound[0]) rateLimits.delete(key);
            }
          }
          return { success: true };
        }
        if (text.includes("admin_sessions")) {
          if (text.startsWith("INSERT")) {
            const [session_hash, created_at, expires_at] = bound;
            assert.equal(sessions.has(session_hash), false);
            sessions.set(session_hash, { session_hash, created_at, expires_at });
          } else if (text.includes("session_hash = ?")) {
            sessions.delete(bound[0]);
          } else if (text.includes("expires_at <= ?")) {
            for (const [hash, row] of sessions) {
              if (row.expires_at <= bound[0]) sessions.delete(hash);
            }
          } else {
            throw new Error("Unexpected session SQL");
          }
          return { success: true };
        }
        if (text.includes("INSERT")) {
          const [email, name] = bound;
          if (!rows.has(email)) {
            rows.set(email, {
              email,
              name,
              created_at: "2026-09-15 12:00:00",
              emailed: 0,
              note: null,
            });
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        }
        if (text.includes("UPDATE")) {
          const email = bound[bound.length - 1];
          const row = rows.get(email);
          if (!row) {
            return { success: true, meta: { changes: 0 } };
          }
          if (missingAdminColumns && /emailed|note/.test(text)) {
            throw new Error("no such column: emailed");
          }
          let i = 0;
          if (text.includes("emailed = ?")) {
            row.emailed = bound[i] ? 1 : 0;
            i += 1;
          }
          if (text.includes("note = ?")) {
            row.note = bound[i];
          }
          return { success: true, meta: { changes: 1 } };
        }
        if (text.includes("DELETE")) {
          const existed = rows.delete(bound[0]);
          return { success: true, meta: { changes: existed ? 1 : 0 } };
        }
        return { success: true, meta: { changes: 0 } };
      },
      async all() {
        if (missingAdminColumns && text.includes("created_at, emailed")) {
          throw new Error("no such column: emailed");
        }
        if (text.includes("GROUP BY")) return { results: [] };
        const list = selectedRows();
        return { results: list.slice(bound.at(-1), bound.at(-1) + bound.at(-2)) };
      },
      async first() {
        if (text.startsWith("SELECT COUNT(*)")) return { count: selectedRows().length };
        if (text.startsWith("UPDATE waitlist") && text.includes("RETURNING")) {
          await this.run();
          const row = rows.get(bound[bound.length - 1]);
          return row ? asRow(row) : null;
        }
        if (text.includes("rate_limits")) {
          const [key, window_start] = bound;
          const id = JSON.stringify([key, window_start]);
          let row = rateLimits.get(id);
          if (text.startsWith("INSERT")) {
            if (row && text.includes("WHERE count < ?") && row.count >= bound[2]) return null;
            row = { key, window_start, count: (row?.count || 0) + 1 };
            rateLimits.set(id, row);
          }
          return row || null;
        }
        if (text.includes("admin_sessions")) {
          const row = sessions.get(bound[0]);
          const unexpired = !text.includes("expires_at > ?") || row?.expires_at > bound[1];
          return row && unexpired ? row : null;
        }
        if (missingAdminColumns && text.includes("emailed")) {
          throw new Error("no such column: emailed");
        }
        const row = rows.get(bound[0]);
        return row ? asRow(row) : null;
      },
    };
  }

  return {
    rows,
    sessions,
    prepare(sql) {
      return statement(sql);
    },
  };
}

function seed(db, records) {
  for (const row of records) {
    db.rows.set(row.email, {
      emailed: 0,
      note: null,
      created_at: "2026-09-15 12:00:00",
      ...row,
    });
  }
}

function adminEnv(db) {
  return { DB: db, WAITLIST_ADMIN_TOKEN: "dev-waitlist-token" };
}

function withBearer(init = {}) {
  return {
    ...init,
    headers: {
      authorization: "Bearer dev-waitlist-token",
      ...(init.headers || {}),
    },
  };
}

async function loginSession(env, url = "https://sillyapps.co/api/waitlist/session") {
  const res = await onSessionPost({
    request: request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: env.WAITLIST_ADMIN_TOKEN }),
    }),
    env,
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.get("set-cookie");
  return { cookie, id: decodeURIComponent(cookie.split(";")[0].split("=")[1]) };
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

test("parseLeadPatch accepts emailed and note", () => {
  assert.deepEqual(parseLeadPatch({ email: "Ada@Example.com", emailed: true, note: " ping " }), {
    ok: true,
    email: "ada@example.com",
    patch: { emailed: 1, note: "ping" },
  });
});

test("parseLeadPatch rejects an empty body", () => {
  assert.deepEqual(parseLeadPatch({ email: "ada@example.com" }), {
    ok: false,
    code: "empty_patch",
  });
});

test("filterSignups matches email, name, dates, and emailed", () => {
  const rows = [
    { email: "ada@example.com", name: "Ada", created_at: "2026-09-10 09:00:00", emailed: 1 },
    { email: "bob@example.com", name: "Bob", created_at: "2026-09-15 09:00:00", emailed: 0 },
  ];
  assert.equal(filterSignups(rows, parseListQuery(new URLSearchParams("q=ada"))).length, 1);
  assert.equal(filterSignups(rows, parseListQuery(new URLSearchParams("from=2026-09-14"))).length, 1);
  assert.equal(filterSignups(rows, parseListQuery(new URLSearchParams("to=2026-09-10"))).length, 1);
  assert.equal(filterSignups(rows, parseListQuery(new URLSearchParams("emailed=1"))).length, 1);
});

test("lastSevenDays fills empty UTC days", () => {
  const days = lastSevenDays(
    [{ created_at: "2026-09-15 12:00:00" }, { created_at: "2026-09-15 18:00:00" }],
    new Date("2026-09-16T00:00:00Z")
  );
  assert.deepEqual(
    days.map((item) => item.day),
    [
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
      "2026-09-13",
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
    ]
  );
  assert.equal(days.find((item) => item.day === "2026-09-15").count, 2);
  assert.equal(days.find((item) => item.day === "2026-09-16").count, 0);
});

test("toCsv quotes commas and writes admin columns", () => {
  assert.equal(
    toCsv([
      {
        email: "ada@example.com",
        name: "Ada, Lim",
        created_at: "2026-09-15 12:00:00",
        emailed: true,
        note: "said hi",
      },
    ]),
    'email,name,created_at,emailed,note\nada@example.com,"Ada, Lim",2026-09-15 12:00:00,1,said hi\n'
  );
});

test("csvCell quotes quotes and prefixes formulas", () => {
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("=1+1"), "'=1+1");
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
    emailed: 0,
    note: null,
  });
});

test("POST ignores a repeat email", async () => {
  const db = memoryDb();
  db.rows.set("ada@example.com", {
    email: "ada@example.com",
    name: "Ada",
    created_at: "2026-09-15 12:00:00",
    emailed: 0,
    note: null,
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

test("POST rate-limits a chatty IP", async () => {
  const db = memoryDb();
  const env = { DB: db };
  let last;
  for (let i = 0; i < 9; i += 1) {
    last = await onRequestPost({
      request: request("https://sillyapps.co/api/waitlist", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.9",
        },
        body: JSON.stringify({ email: `n${i}@example.com` }),
      }),
      env,
    });
  }
  assert.equal(last.status, 429);
  assert.equal(db.rows.size, 8);
});

test("GET export returns csv for a valid bearer token", async () => {
  const db = memoryDb();
  seed(db, [
    {
      email: "ada@example.com",
      name: "Ada",
      created_at: "2026-09-15 12:00:00",
      emailed: 1,
      note: "vip",
    },
  ]);
  const res = await onRequestGet({
    request: request("https://sillyapps.co/api/waitlist", withBearer()),
    env: adminEnv(db),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(
    await res.text(),
    "email,name,created_at,emailed,note\nada@example.com,Ada,2026-09-15 12:00:00,1,vip\n"
  );
});

test("GET json filters by search and date", async () => {
  const db = memoryDb();
  seed(db, [
    { email: "ada@example.com", name: "Ada", created_at: "2026-09-10 12:00:00" },
    { email: "bob@example.com", name: "Bob", created_at: "2026-09-15 12:00:00" },
  ]);
  const res = await onRequestGet({
    request: request(
      "https://sillyapps.co/api/waitlist?format=json&q=bob&from=2026-09-14",
      withBearer()
    ),
    env: adminEnv(db),
  });
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.total, 2);
  assert.equal(payload.count, 1);
  assert.equal(payload.signups[0].email, "bob@example.com");
  assert.equal(payload.signups[0].emailed, false);
  assert.equal(payload.admin_fields, true);
  assert.equal(payload.days.length, 7);
});

test("GET rejects invalid date filters before loading signups for JSON and CSV", async () => {
  const invalid = ["garbage", "2026-2-01", "2026-02-29", "1900-02-29", "2026-04-31", "2026-00-10", "2026-13-01", "2026-01-00", "2026-01-32", "2026-01-01T00:00:00Z"];
  for (const format of ["json", "csv"]) {
    const cases = invalid.flatMap(value => [
      [new URLSearchParams({ from: value }), "invalid_date"],
      [new URLSearchParams({ to: value }), "invalid_date"],
    ]);
    cases.push([new URLSearchParams({ from: "2026-09-15", to: "2026-09-14" }), "invalid_date_range"]);
    for (const [params, error] of cases) {
      const db = memoryDb();
      const prepare = db.prepare;
      let reads = 0;
      db.prepare = (sql) => {
        if (sql.includes("FROM waitlist")) reads++;
        return prepare(sql);
      };
      params.set("format", format);
      const res = await onRequestGet({
        request: request(`https://sillyapps.co/api/waitlist?${params}`, withBearer()),
        env: adminEnv(db),
      });
      assert.equal(res.status, 400, params.toString());
      assert.deepEqual(await res.json(), { ok: false, error });
      assert.equal(reads, 0);
    }
  }
});

test("GET accepts leap days, optional bounds, and inclusive same-day ranges", async () => {
  const db = memoryDb();
  seed(db, [
    { email: "before@example.com", created_at: "2000-02-28 23:59:59" },
    { email: "leap@example.com", created_at: "2000-02-29 23:59:59" },
    { email: "after@example.com", created_at: "2000-03-01 00:00:00" },
  ]);
  for (const [query, expected] of [
    ["", ["before", "leap", "after"]],
    ["from=&to=", ["before", "leap", "after"]],
    ["from=2000-02-29", ["leap", "after"]],
    ["to=2000-02-29", ["before", "leap"]],
    ["from=2000-02-29&to=2000-02-29", ["leap"]],
  ]) {
    const res = await onRequestGet({
      request: request(`https://sillyapps.co/api/waitlist?format=json&${query}`, withBearer()),
      env: adminEnv(db),
    });
    assert.equal(res.status, 200, query);
    assert.deepEqual((await res.json()).signups.map(row => row.email), expected.map(name => `${name}@example.com`));
  }
});

test("GET json still lists rows before the admin migration", async () => {
  const db = memoryDb({ missingAdminColumns: true });
  seed(db, [{ email: "ada@example.com", name: "Ada" }]);
  const res = await onRequestGet({
    request: request("https://sillyapps.co/api/waitlist?format=json", withBearer()),
    env: adminEnv(db),
  });
  const payload = await res.json();
  assert.equal(res.status, 200);
  assert.equal(payload.admin_fields, false);
  assert.equal(payload.signups[0].emailed, false);
});

test("GET export is hidden when the admin token is unset", async () => {
  const res = await onRequestGet({
    request: request("https://sillyapps.co/api/waitlist"),
    env: { DB: memoryDb() },
  });
  assert.equal(res.status, 404);
});

test("GET export rejects a bad bearer token", async () => {
  const res = await onRequestGet({
    request: request("https://sillyapps.co/api/waitlist", {
      headers: { authorization: "Bearer wrong-token" },
    }),
    env: adminEnv(memoryDb()),
  });
  assert.equal(res.status, 401);
});

test("PATCH toggles emailed and saves a note", async () => {
  const db = memoryDb();
  seed(db, [{ email: "ada@example.com", name: "Ada" }]);
  const res = await onRequestPatch({
    request: request("https://sillyapps.co/api/waitlist", {
      method: "PATCH",
      headers: {
        authorization: "Bearer dev-waitlist-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: "ada@example.com", emailed: true, note: "sent" }),
    }),
    env: adminEnv(db),
  });
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.signup.emailed, true);
  assert.equal(payload.signup.note, "sent");
  assert.equal(db.rows.get("ada@example.com").emailed, 1);
});

test("PATCH returns 404 for an unknown email", async () => {
  const res = await onRequestPatch({
    request: request("https://sillyapps.co/api/waitlist", {
      method: "PATCH",
      headers: {
        authorization: "Bearer dev-waitlist-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: "missing@example.com", emailed: true }),
    }),
    env: adminEnv(memoryDb()),
  });
  assert.equal(res.status, 404);
});

test("DELETE removes a row by email", async () => {
  const db = memoryDb();
  seed(db, [{ email: "ada@example.com", name: "Ada" }]);
  const res = await onRequestDelete({
    request: request("https://sillyapps.co/api/waitlist?email=Ada@Example.com", withBearer({
      method: "DELETE",
    })),
    env: adminEnv(db),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, email: "ada@example.com" });
  assert.equal(db.rows.size, 0);
});

test("session login sets an HttpOnly cookie that can list rows", async () => {
  const db = memoryDb();
  seed(db, [{ email: "ada@example.com", name: "Ada" }]);
  const login = await onSessionPost({
    request: request("https://sillyapps.co/api/waitlist/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "dev-waitlist-token" }),
    }),
    env: adminEnv(db),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /waitlist_admin=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);

  const listed = await onRequestGet({
    request: request("https://sillyapps.co/api/waitlist?format=json", {
      headers: { cookie: cookie.split(";")[0] },
    }),
    env: adminEnv(db),
  });
  assert.equal(listed.status, 200);
  const payload = await listed.json();
  assert.equal(payload.signups[0].email, "ada@example.com");

  const probe = await onSessionGet({
    request: request("https://sillyapps.co/api/waitlist/session", {
      headers: { cookie: cookie.split(";")[0] },
    }),
    env: adminEnv(db),
  });
  assert.equal(probe.status, 200);

  const logout = await onSessionDelete({
    request: request("https://sillyapps.co/api/waitlist/session", { method: "DELETE" }),
    env: adminEnv(db),
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
});

test("session cookie contains a random id and D1 stores only its hash for 12 hours", async () => {
  const db = memoryDb();
  const env = adminEnv(db);
  const before = Date.now();
  const { cookie, id } = await loginSession(env);
  assert.equal(cookie.includes(env.WAITLIST_ADMIN_TOKEN), false);
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\/(?:;|$)/);
  const hash = createHmac("sha256", env.WAITLIST_ADMIN_TOKEN).update(id).digest("hex");
  assert.equal(db.sessions.size, 1);
  const row = db.sessions.get(hash);
  assert.deepEqual(Object.keys(row).sort(), ["created_at", "expires_at", "session_hash"]);
  assert.ok(row.created_at >= before && row.created_at <= Date.now());
  assert.equal(row.expires_at - row.created_at, 12 * 60 * 60 * 1000);
  assert.notEqual(hash, id);
  const second = await loginSession(env, "http://localhost/api/waitlist/session");
  assert.notEqual(second.id, id);
  assert.match(second.cookie, /Secure/);
  assert.equal(db.sessions.size, 2);
});

for (const state of ["valid", "logged out", "expired", "legacy token", "unknown id", "rotated token"]) {
  test(`admin routes enforce ${state} sessions`, async (t) => {
    const db = memoryDb();
    const env = adminEnv(db);
    const now = Date.now();
    t.mock.method(Date, "now", () => now);
    const { id } = await loginSession(env);
    if (state === "rotated token") env.WAITLIST_ADMIN_TOKEN = "rotated-test-token";
    if (state === "logged out") {
      const logout = await onSessionDelete({
        request: authRequest("DELETE", "/session", id, "", true), env,
      });
      assert.equal(logout.status, 200);
      assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
      assert.equal(db.sessions.size, 0);
    }
    if (state === "expired") {
      t.mock.method(Date, "now", () => now + 12 * 60 * 60 * 1000 - 1);
      const probe = await onSessionGet({ request: authRequest("GET", "/session", id, "", true), env });
      assert.equal(probe.status, 200);
      t.mock.method(Date, "now", () => now + 12 * 60 * 60 * 1000);
    }
    const credential = state === "legacy token" ? env.WAITLIST_ADMIN_TOKEN :
      state === "unknown id" ? "0".repeat(64) : id;
    for (const [method, suffix, handler] of adminRoutes.filter(([method]) => method !== "POST")) {
      seed(db, [{ email: "ada@example.com" }]);
      const res = await handler({ request: authRequest(method, suffix, credential, "", true), env });
      assert.equal(res.status, state === "valid" ? 200 : 401);
      if (state !== "valid") assert.equal(db.rows.get("ada@example.com").emailed, 0);
    }
  });
}

test("login cleans up expired sessions without deleting live sessions", async (t) => {
  const db = memoryDb();
  const env = adminEnv(db);
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const old = await loginSession(env);
  t.mock.method(Date, "now", () => now + 6 * 60 * 60 * 1000);
  const live = await loginSession(env);
  t.mock.method(Date, "now", () => now + 12 * 60 * 60 * 1000);
  await loginSession(env);
  assert.equal(db.sessions.size, 2);
  assert.equal(db.sessions.has(createHmac("sha256", env.WAITLIST_ADMIN_TOKEN).update(old.id).digest("hex")), false);
  const probe = await onSessionGet({ request: authRequest("GET", "/session", live.id, "", true), env });
  assert.equal(probe.status, 200);
});

test("logout revokes only the supplied session", async () => {
  const env = adminEnv(memoryDb());
  const first = await loginSession(env);
  const second = await loginSession(env);
  const logout = await onSessionDelete({
    request: authRequest("DELETE", "/session", first.id, "", true), env,
  });
  assert.equal(logout.status, 200);
  assert.equal(env.DB.sessions.size, 1);
  const probe = await onSessionGet({ request: authRequest("GET", "/session", second.id, "", true), env });
  assert.equal(probe.status, 200);
});

test("token rotation rejects old credentials and allows new sessions to log out", async () => {
  const env = adminEnv(memoryDb());
  const oldToken = env.WAITLIST_ADMIN_TOKEN;
  const old = await loginSession(env);
  env.WAITLIST_ADMIN_TOKEN = "rotated-test-token";
  const bearer = await onSessionGet({ request: authRequest("GET", "/session", oldToken), env });
  assert.equal(bearer.status, 401);
  const fresh = await loginSession(env);
  for (const [id, status] of [[old.id, 401], [fresh.id, 200]]) {
    const probe = await onSessionGet({ request: authRequest("GET", "/session", id, "", true), env });
    assert.equal(probe.status, status);
  }
  const logout = await onSessionDelete({
    request: authRequest("DELETE", "/session", fresh.id, "", true), env,
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
  const replay = await onSessionGet({ request: authRequest("GET", "/session", fresh.id, "", true), env });
  assert.equal(replay.status, 401);
});

test("session database failures deny access and do not report successful login or logout", async () => {
  const env = adminEnv(memoryDb());
  const { id } = await loginSession(env);
  env.DB = { prepare() { throw new Error("database unavailable"); } };
  for (const [method, handler] of [["POST", onSessionPost], ["GET", onSessionGet], ["DELETE", onSessionDelete]]) {
    const res = await handler({
      request: authRequest(method, "/session", method === "POST" ? env.WAITLIST_ADMIN_TOKEN : id, "", true), env,
    });
    assert.equal(res.status, 503);
    assert.equal(res.headers.has("set-cookie"), false);
  }
});

test("session login rejects a bad token", async () => {
  const res = await onSessionPost({
    request: request("https://sillyapps.co/api/waitlist/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "nope" }),
    }),
    env: adminEnv(memoryDb()),
  });
  assert.equal(res.status, 401);
});

const adminRoutes = [
  ["GET", "", onRequestGet],
  ["PATCH", "", onRequestPatch],
  ["DELETE", "", onRequestDelete],
  ["GET", "/session", onSessionGet],
  ["POST", "/session", onSessionPost],
];

function authRequest(method, suffix, token, ip, cookie = false) {
  return request(`https://sillyapps.co/api/waitlist${suffix}`, {
    method,
    headers: {
      "cf-connecting-ip": ip,
      "content-type": "application/json",
      ...(cookie ? { cookie: `waitlist_admin=${encodeURIComponent(token)}` } :
        { authorization: `Bearer ${token}` }),
    },
    ...(method === "GET" ? {} : {
      body: JSON.stringify({ token, email: "ada@example.com", emailed: true }),
    }),
  });
}

for (const [name, limit, handler, makeRequest, allowedStatus] of [
  ["signup", 8, onRequestPost, () => request("https://sillyapps.co/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "retry@example.com" }),
  }), 200],
  ...adminRoutes.map(([method, suffix, handler]) => [
    `${method} ${suffix || "waitlist"}`, 20, handler,
    () => authRequest(method, suffix, "bad", "192.0.2.80"), 401,
  ]),
]) {
  test(`${name} Retry-After counts down to the limiter window reset`, async (t) => {
    const env = adminEnv(memoryDb());
    const start = 1800000000000;
    let now = start + 123456;
    t.mock.method(Date, "now", () => now);
    const call = () => handler({ request: makeRequest(), env });
    for (let i = 0; i < limit; i++) {
      const response = await call();
      assert.equal(response.status, allowedStatus);
      assert.equal(response.headers.get("retry-after"), null);
    }
    for (const [offset, expected] of [[123456, "477"], [599000, "1"], [599999, "1"]]) {
      now = start + offset;
      const response = await call();
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), expected);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { ok: false, error: "rate_limited" });
    }
    now = start + 600000;
    const response = await call();
    assert.equal(response.status, allowedStatus);
    assert.equal(response.headers.get("retry-after"), null);
  });
}

for (const [index, [method, suffix, handler]] of adminRoutes.entries()) {
  for (const cookie of [false, true]) {
    test(`${method} ${suffix || "waitlist"} counts only failed auth (${cookie ? "cookie" : "bearer"})`, async (t) => {
      const db = memoryDb();
      const env = adminEnv(db);
      const valid = cookie && method !== "POST" ? (await loginSession(env)).id : env.WAITLIST_ADMIN_TOKEN;
      const ip = `198.51.${index}.${cookie ? 1 : 2}`;
      const call = async (token, address = ip) => {
        seed(db, [{ email: "ada@example.com" }]);
        return handler({ request: authRequest(method, suffix, token, address, cookie), env });
      };
      for (let i = 0; i < 20; i++) {
        assert.equal((await call("bad")).status, 401);
        if (i < 19) assert.equal((await call(valid)).status, 200);
      }
      if (cookie && method !== "POST") {
        assert.equal((await call(valid)).status, 200);
        assert.equal((await call("bad")).status, 401);
        return;
      }
      assert.equal((await call(valid)).status, 429);
      assert.equal((await call("bad")).status, 429);
      // All authentication paths share the same failed-attempt bucket.
      for (const [otherMethod, otherSuffix, otherHandler] of adminRoutes) {
        assert.equal((await otherHandler({
          request: authRequest(otherMethod, otherSuffix, env.WAITLIST_ADMIN_TOKEN, ip), env,
        })).status, 429);
      }
      assert.equal((await call(valid, `${ip}0`)).status, 200);
      const now = Date.now();
      t.mock.method(Date, "now", () => now + 10 * 60 * 1000);
      assert.equal((await call(valid)).status, 200);
    });
  }
}

test("admin tokens accept 512 characters and reject 513 even when matching configuration", async () => {
  for (const length of [64, 512, 513]) {
    const token = "a".repeat(length);
    const db = memoryDb();
    const env = { DB: db, WAITLIST_ADMIN_TOKEN: token };
    for (const [method, suffix, handler] of adminRoutes) {
      for (const cookie of [false, true]) {
        seed(db, [{ email: "ada@example.com" }]);
        const res = await handler({ request: authRequest(method, suffix, token, "", cookie), env });
        assert.equal(res.status, length <= 512 && (!cookie || method === "POST") ? 200 : 401);
      }
    }
  }
});

const bodyRoutes = [
  ["signup JSON", onRequestPost, "POST", "application/json"],
  ["signup URL form", onRequestPost, "POST", "application/x-www-form-urlencoded"],
  ["signup multipart", onRequestPost, "POST", "multipart/form-data; boundary=test"],
  ["login", onSessionPost, "POST", "application/json"],
  ["patch", onRequestPatch, "PATCH", "application/json"],
  ["delete", onRequestDelete, "DELETE", "application/json"],
];
for (const [name, handler, method, contentType] of bodyRoutes) {
  for (const contentLength of [null, "1"]) {
    test(`${name} cancels oversized streamed bodies (${contentLength === null ? "absent" : "false"} Content-Length)`, async () => {
      let pulls = 0;
      let cancelled = false;
      const body = new ReadableStream({
        pull(controller) {
          pulls++;
          controller.enqueue(new TextEncoder().encode("é".repeat(2048)));
          if (pulls === 10) controller.close();
        },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 });
      const db = memoryDb();
      seed(db, [{ email: "ada@example.com" }]);
      const res = await handler({
        request: request("https://sillyapps.co/api/waitlist", withBearer({
          method, body, duplex: "half",
          headers: { "content-type": contentType, ...(contentLength ? { "content-length": contentLength } : {}) },
        })),
        env: adminEnv(db),
      });
      assert.equal(res.status, 413);
      assert.equal(cancelled, true);
      assert.equal(pulls, 3);
      assert.equal(db.rows.size, 1);
      assert.equal(db.rows.get("ada@example.com").emailed, 0);
    });
  }
}

test("body limit accepts exactly 8192 bytes and rejects 8193", async () => {
  for (const size of [8192, 8193]) {
    const base = JSON.stringify({ email: "ada@example.com" });
    const res = await onRequestPost({
      request: request("https://sillyapps.co/api/waitlist", {
        method: "POST", headers: { "content-type": "application/json" },
        body: base.padEnd(size, " "),
      }), env: { DB: memoryDb() },
    });
    assert.equal(res.status, size === 8192 ? 200 : 413);
  }
});


// Separate module trees ensure even imported limiter state is isolated. SQLite
// executes the actual migration and SQL, while both handlers share one DB file.
async function sharedLimitFixture(t) {
  const { mkdtempSync, cpSync, rmSync, readFileSync, readdirSync, openSync, closeSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { pathToFileURL } = await import("node:url");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(`${tmpdir()}/silly-rate-`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  function sql(query, params = [], script = false) {
    const output = openSync(`${dir}/result.json`, "w");
    try {
      execFileSync("python3", ["-c", `
import json, sqlite3, sys
query, params, script = json.loads(sys.argv[2])
with sqlite3.connect(sys.argv[1]) as db:
    db.row_factory = sqlite3.Row
    if script:
        db.executescript(query)
        result = []
    else:
        result = [dict(row) for row in db.execute(query, params).fetchall()]
print(json.dumps(result))
`, `${dir}/db.sqlite`, JSON.stringify([query, params, script])], { stdio: ["ignore", output, "pipe"], timeout: 10000 });
    } catch (error) {
      throw new Error(error.stderr?.toString() || "SQLite fixture failed");
    } finally {
      closeSync(output);
    }
    return JSON.parse(readFileSync(`${dir}/result.json`, "utf8"));
  }
  for (const file of readdirSync(new URL("../migrations/", import.meta.url)).filter(file => file.endsWith(".sql")).sort()) {
    sql(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"), [], true);
  }
  const bindings = [];
  const db = {
    prepare(query) {
      return {
        async all() { return { results: sql(query) }; },
        bind(...params) {
          bindings.push(params);
          return {
            async run() {
              const rows = sql(`${query} RETURNING *`, params);
              return { success: true, meta: { changes: rows.length } };
            },
            async all() { return { results: sql(query, params) }; },
            async first() {
              const row = sql(query, params)[0] || null;
              // D1 results arrive asynchronously, including concurrent stale reads.
              await new Promise(resolve => setImmediate(resolve));
              return row;
            },
          };
        },
      };
    },
  };
  const handlers = [];
  for (const name of ["isolate-a", "isolate-b"]) {
    cpSync(new URL("../functions", import.meta.url), `${dir}/${name}`, { recursive: true });
    handlers.push({
      authorize: (await import(pathToFileURL(`${dir}/${name}/lib/waitlist.js`))).requireAdmin,
      signup: (await import(pathToFileURL(`${dir}/${name}/api/waitlist.js`))).onRequestPost,
      login: (await import(pathToFileURL(`${dir}/${name}/api/waitlist/session.js`))).onRequestPost,
    });
  }
  return { handlers, db, sql, bindings };
}

for (const mutation of ["update", "delete"]) {
  test(`PATCH returns its applied row despite an intervening ${mutation}`, async (t) => {
    const { db, sql } = await sharedLimitFixture(t);
    const email = "ada@example.com";
    const created = "2026-09-15 12:00:00";
    sql("INSERT INTO waitlist (email, name, created_at) VALUES (?, ?, ?)", [email, "Ada", created]);
    const prepare = db.prepare;
    let intervened = false;
    db.prepare = (query) => {
      const statement = prepare(query);
      if (!query.startsWith("UPDATE waitlist")) return statement;
      return {
        bind(...params) {
          const bound = statement.bind(...params);
          return Object.fromEntries(["run", "first"].map(method => [method, async () => {
            const result = await bound[method]();
            // A second writer commits after this mutation, before its result
            // reaches the handler (and before any separate SELECT can run).
            if (mutation === "update") {
              sql("UPDATE waitlist SET emailed = 0, note = ? WHERE email = ?", ["another writer", email]);
            } else {
              sql("DELETE FROM waitlist WHERE email = ?", [email]);
            }
            intervened = true;
            return result;
          }]));
        },
      };
    };
    const res = await onRequestPatch({
      request: request("https://sillyapps.co/api/waitlist", withBearer({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, emailed: true, note: "sent" }),
      })),
      env: adminEnv(db),
    });
    assert.equal(intervened, true);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      signup: { email, name: "Ada", created_at: created, emailed: true, note: "sent" },
    });
    assert.deepEqual(sql("SELECT emailed, note FROM waitlist WHERE email = ?", [email]),
      mutation === "update" ? [{ emailed: 0, note: "another writer" }] : []);
  });
}

for (const [purpose, limit] of [["post", 8], ["login", 20]]) {
  test(`${purpose} limit is shared across isolated handlers and stores only hashed IPs`, async (t) => {
    const { handlers, db, sql, bindings } = await sharedLimitFixture(t);
    const env = adminEnv(db);
    const ip = "203.0.113.87";
    const windowMs = 600000;
    let now = 1800000000000;
    t.mock.method(Date, "now", () => now);
    const call = (index, token = "bad") => purpose === "login"
      ? handlers[index].login({ request: authRequest("POST", "/session", token, ip), env })
      : handlers[index].signup({ request: request("https://sillyapps.co/api/waitlist", {
        method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ email: "shared@example.com" }),
      }), env });
    // Each isolate alone sees fewer attempts than the threshold.
    for (let i = 0; i < limit; i++) {
      assert.equal((await call(i % 2)).status, purpose === "login" ? 401 : 200);
    }
    const throttled = await call(1, env.WAITLIST_ADMIN_TOKEN);
    assert.equal(throttled.status, 429);
    assert.equal(throttled.headers.get("retry-after"), "600");
    now += 123456;
    const retried = await call(0, env.WAITLIST_ADMIN_TOKEN);
    assert.equal(retried.status, 429);
    assert.equal(retried.headers.get("retry-after"), "477");
    now -= 123456;
    const rows = sql("SELECT * FROM rate_limits");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, limit, "rejected retries must not consume reservations");
    assert.equal(rows[0].key, `${purpose}:${createHash("sha256").update(ip).digest("hex")}`);
    assert.equal(JSON.stringify(bindings).includes(ip), false);
    assert.equal(JSON.stringify(sql("SELECT * FROM waitlist") ).includes(ip), false);
    assert.equal(JSON.stringify(sql("SELECT * FROM admin_sessions")).includes(ip), false);
    now += windowMs;
    assert.equal((await call(0)).status, purpose === "login" ? 401 : 200);
    assert.equal(sql("SELECT * FROM rate_limits").length, 2);
    now += 86400000;
    await call(1);
    const retained = sql("SELECT * FROM rate_limits");
    assert.equal(retained.length, 2);
    assert.ok(retained.every(row => row.window_start >= now - 86400000));
  });
}

for (const operation of ["INSERT", "DELETE", "UPDATE"]) {
  test(`admin fails closed on limiter ${operation} error`, async () => {
    const db = memoryDb();
    const prepare = db.prepare;
    db.prepare = (sql) => {
      if (sql.includes("rate_limits") && sql.startsWith(operation)) throw new Error("D1 unavailable");
      return prepare(sql);
    };
    const env = adminEnv(db);
    for (const token of operation === "UPDATE" ? [env.WAITLIST_ADMIN_TOKEN] : ["bad", env.WAITLIST_ADMIN_TOKEN]) {
      const res = await onSessionPost({ request: authRequest("POST", "/session", token, "192.0.2.77"), env });
      assert.equal(res.status, 503);
      assert.equal(res.headers.has("set-cookie"), false);
      assert.equal(db.sessions.size, 0);
    }
  });
}

test("signup fails open when the limiter database operation fails", async () => {
  const db = memoryDb();
  const prepare = db.prepare;
  db.prepare = (sql) => {
    if (sql.includes("rate_limits")) throw new Error("D1 unavailable");
    return prepare(sql);
  };
  const res = await onRequestPost({
    request: request("https://sillyapps.co/api/waitlist", {
      method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.78" },
      body: JSON.stringify({ email: "open@example.com" }),
    }), env: { DB: db },
  });
  assert.equal(res.status, 200);
  assert.ok(db.rows.has("open@example.com"));
});

for (const mode of ["bearer", "login"]) {
  test(`concurrent ${mode} attempts reserve the remaining comparison atomically`, async (t) => {
    const { handlers, db, sql } = await sharedLimitFixture(t);
    const env = adminEnv(db);
    const ip = "192.0.2.90";
    const now = 1800000000000;
    t.mock.method(Date, "now", () => now);
    const key = `login:${createHash("sha256").update(ip).digest("hex")}`;
    sql("INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, ?)", [key, now, 19]);
    const token = "concurrent-invalid-token";
    const requests = Array.from({ length: 64 }, () => authRequest(
      mode === "login" ? "POST" : "GET", "/session", token, ip
    ));
    let comparisons = 0;
    const encode = TextEncoder.prototype.encode;
    t.mock.method(TextEncoder.prototype, "encode", function(value) {
      if (value === token) comparisons++;
      return encode.call(this, value);
    });
    const statuses = await Promise.all(requests.map(async (request, i) => {
      const handler = handlers[i % 2];
      if (mode === "login") return (await handler.login({ request, env })).status;
      return (await handler.authorize(request, env)).response.status;
    }));
    assert.equal(comparisons, 1, "only the last available attempt may compare credentials");
    assert.equal(statuses.filter(status => status === 401).length, 1);
    assert.equal(statuses.filter(status => status === 429).length, 63);
    assert.deepEqual(sql("SELECT count FROM rate_limits"), [{ count: 20 }]);
  });
}

for (const mode of ["bearer", "login"]) {
  test(`concurrent valid ${mode} requests refund reservations without leaving a lockout`, async (t) => {
    const { handlers, db, sql } = await sharedLimitFixture(t);
    const env = adminEnv(db);
    t.mock.method(Date, "now", () => 1800000000000);
    const call = async (i) => {
      const req = authRequest(mode === "login" ? "POST" : "GET", "/session",
        env.WAITLIST_ADMIN_TOKEN, "192.0.2.92");
      if (mode === "login") return (await handlers[i % 2].login({ request: req, env })).status;
      const gate = await handlers[i % 2].authorize(req, env);
      return gate.ok ? 200 : gate.response.status;
    };
    const statuses = await Promise.all(Array.from({ length: 64 }, (_, i) => call(i)));
    assert.equal(statuses.filter(status => status === 200).length, 20);
    assert.equal(statuses.filter(status => status === 429).length, 44);
    assert.deepEqual(sql("SELECT count FROM rate_limits"), [{ count: 0 }]);
    assert.equal(await call(0), 200);
  });
}

test("login uses one atomic reservation and no preliminary limiter read", async (t) => {
  const { db } = await sharedLimitFixture(t);
  const queries = [];
  const prepare = db.prepare;
  db.prepare = (query) => {
    queries.push(query);
    return prepare(query);
  };
  await loginSession(adminEnv(db));
  assert.equal(queries.length, 5, "reservation cleanup, reservation, refund, session cleanup and insertion");
  assert.equal(queries.filter(query => query.startsWith("SELECT") && query.includes("rate_limits")).length, 0);
  assert.equal(queries.filter(query => query.startsWith("DELETE FROM rate_limits")).length, 1);
});

test("migrations index rate limit cleanup by window_start", async (t) => {
  const { sql } = await sharedLimitFixture(t);
  const indexes = sql("PRAGMA index_list(rate_limits)");
  assert.ok(indexes.some(index => {
    const columns = sql("SELECT name FROM pragma_index_info(?) ORDER BY seqno", [index.name]);
    return columns[0]?.name === "window_start";
  }), "cleanup needs an index starting with window_start");
  const plan = sql("EXPLAIN QUERY PLAN DELETE FROM rate_limits WHERE window_start < ?", [1800000000000]);
  assert.ok(plan.some(row => /SEARCH rate_limits USING INDEX/.test(row.detail)));
});

test("successful authentication refunds its original window", async (t) => {
  const { handlers, db, sql } = await sharedLimitFixture(t);
  const env = adminEnv(db);
  const ip = "192.0.2.91";
  const start = 1800000000000;
  let now = start;
  t.mock.method(Date, "now", () => now);
  const key = `login:${createHash("sha256").update(ip).digest("hex")}`;
  sql("INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, ?)", [key, start, 19]);
  const encode = TextEncoder.prototype.encode;
  t.mock.method(TextEncoder.prototype, "encode", function(value) {
    if (value === env.WAITLIST_ADMIN_TOKEN) now = start + 600000;
    return encode.call(this, value);
  });
  const gate = await handlers[0].authorize(authRequest("GET", "/session", env.WAITLIST_ADMIN_TOKEN, ip), env);
  assert.equal(gate.ok, true);
  assert.deepEqual(sql("SELECT window_start, count FROM rate_limits"), [{ window_start: start, count: 19 }]);
});


test("credential-free probes do not consume the token budget", async () => {
  const env = adminEnv(memoryDb());
  for (const [method, suffix, handler] of adminRoutes) {
    for (let i = 0; i < 24; i++) {
      const res = await handler({
        request: request(`https://sillyapps.co/api/waitlist${suffix}`, {
          method,
          ...(method === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}),
        }), env,
      });
      assert.equal(res.status, 401);
    }
  }
  await loginSession(env);
});

test("valid sessions survive exhausted token budgets and 64 concurrent requests", async () => {
  const env = adminEnv(memoryDb());
  const { id } = await loginSession(env);
  const probe = () => onSessionGet({ request: authRequest("GET", "/session", id, "", true), env });
  const responses = await Promise.all(Array.from({ length: 64 }, probe));
  assert.ok(responses.every(res => res.status === 200));
  assert.equal((await probe()).status, 200);
  for (let i = 0; i < 20; i++) {
    assert.equal((await onSessionGet({ request: authRequest("GET", "/session", "bad", ""), env })).status, 401);
  }
  assert.equal((await onSessionGet({ request: authRequest("GET", "/session", "bad", ""), env })).status, 429);
  for (const [method, suffix, handler] of adminRoutes.filter(([method]) => method !== "POST")) {
    seed(env.DB, [{ email: "ada@example.com" }]);
    assert.equal((await handler({ request: authRequest(method, suffix, id, "", true), env })).status, 200);
  }
});

test("cross-site admin requests are rejected before database access", async () => {
  const env = adminEnv({ prepare() { throw new Error("unexpected database access"); } });
  for (const [method, suffix, handler] of [...adminRoutes, ["DELETE", "/session", onSessionDelete]]) {
    for (const headers of [
      { "sec-fetch-site": "cross-site" },
      { origin: "https://attacker.example" },
    ]) {
      for (const credential of ["", "bad"]) {
        const req = authRequest(method, suffix, credential, "192.0.2.123");
        for (const [key, value] of Object.entries(headers)) req.headers.set(key, value);
        const res = await handler({ request: req, env });
        assert.equal(res.status, 403);
      }
    }
  }
});


test("list pages bound real SQL results, filters, totals, CSV and legacy schema", async (t) => {
  const { db, sql } = await sharedLimitFixture(t);
  sql("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 205) INSERT INTO waitlist(email, name, created_at, emailed) SELECT printf('user%03d@example.com', x), 'Group', datetime('now'), x % 2 FROM n");
  const get = (params) => onRequestGet({
    request: request(`https://sillyapps.co/api/waitlist?${params}`, withBearer()), env: adminEnv(db),
  });
  const first = await (await get("format=json")).json();
  assert.equal(first.signups.length, 100);
  assert.equal(first.count, 205);
  assert.equal(first.total, 205);
  assert.equal(first.days.reduce((sum, day) => sum + day.count, 0), 205);
  assert.equal(first.next_offset, 100);
  const second = await (await get("format=json&offset=100")).json();
  const last = await (await get("format=json&offset=200")).json();
  assert.equal(second.signups.length, 100);
  assert.equal(last.signups.length, 5);
  assert.equal(last.next_offset, null);
  assert.deepEqual([...first.signups, ...second.signups, ...last.signups].map(row => row.email),
    Array.from({ length: 205 }, (_, i) => `user${String(i + 1).padStart(3, '0')}@example.com`));
  const day = first.signups[0].created_at.slice(0, 10);
  const filtered = await (await get(`format=json&q=GROUP&emailed=1&from=${day}&to=${day}&limit=2&offset=2`)).json();
  assert.equal(filtered.count, 103);
  assert.equal(filtered.total, 205);
  assert.deepEqual(filtered.signups.map(row => row.email), ['user005@example.com', 'user007@example.com']);
  assert.equal((await (await get("format=json&q=%25")).json()).count, 0);
  assert.equal((await (await get("format=json&q=' OR 1=1--")).json()).count, 0);
  for (const params of ["limit=0", "limit=101", "limit=-1", "limit=1.5", "limit=", "offset=-1", "offset=abc", "offset=9007199254740992"]) {
    assert.equal((await get(params)).status, 400, params);
  }
  const csv = await get("offset=100");
  assert.equal(csv.headers.get("x-next-offset"), "200");
  const lines = (await csv.text()).trim().split("\n");
  assert.equal(lines.length, 101);
  assert.match(lines[1], /^user101@example.com,/);
  assert.equal((await (await get("format=json&offset=999")).json()).signups.length, 0);
  sql("ALTER TABLE waitlist DROP COLUMN emailed");
  sql("ALTER TABLE waitlist DROP COLUMN note");
  const legacy = await (await get("format=json&offset=200&emailed=0")).json();
  assert.equal(legacy.admin_fields, false);
  assert.equal(legacy.signups.length, 5);
  assert.equal(legacy.count, 205);
  assert.equal((await (await get("format=json&emailed=1")).json()).count, 0);
});

test("Unicode searches preserve matching, counts and pages on real SQLite", async (t) => {
  const { db, sql } = await sharedLimitFixture(t);
  // Put matches beyond the first SQL batch, with nonmatches between them.
  sql("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 205) INSERT INTO waitlist(email, name, created_at, emailed) SELECT printf('user%03d@example.com', x), CASE WHEN x IN (101, 103, 205) THEN 'Élodie' ELSE 'Other' END, '2026-09-15 12:00:00', 0 FROM n");
  const get = (q, extra = "") => onRequestGet({
    request: request(`https://sillyapps.co/api/waitlist?q=${encodeURIComponent(q)}&${extra}`, withBearer()),
    env: adminEnv(db),
  });
  for (const q of ["Élodie", "élodie"]) {
    const first = await (await get(q, "format=json&limit=2&from=2026-09-15&to=2026-09-15&emailed=0")).json();
    assert.equal(first.count, 3);
    assert.equal(first.total, 205);
    assert.equal(first.next_offset, 2);
    assert.deepEqual(first.signups.map(row => row.email), ["user101@example.com", "user103@example.com"]);
    const last = await (await get(q, "format=json&limit=2&offset=2")).json();
    assert.equal(last.count, 3);
    assert.equal(last.next_offset, null);
    assert.deepEqual(last.signups.map(row => row.email), ["user205@example.com"]);
  }
  const csv = await get("ÉLODIE", "limit=2&offset=2");
  assert.equal(csv.headers.get("x-next-offset"), "");
  assert.match(await csv.text(), /user205@example.com,Élodie/);
  assert.equal((await (await get("élodie", "format=json&emailed=1")).json()).count, 0);
  const beyond = await (await get("élodie", "format=json&offset=3")).json();
  assert.equal(beyond.count, 3);
  assert.deepEqual(beyond.signups, []);

  // Include non-Latin case mappings, contextual sigma and expanding lowercase.
  for (const [name, q] of [["МОСКВА", "москва"], ["ΟΣ", "ος"], ["İpek", "i\u0307pek"], ["Kelvin", "kelvin"]]) {
    sql("UPDATE waitlist SET name = ? WHERE email = 'user205@example.com'", [name]);
    const payload = await (await get(q, "format=json")).json();
    assert.equal(payload.count, 1, name);
    assert.equal(payload.signups[0].name, name);
  }
  sql("ALTER TABLE waitlist DROP COLUMN emailed");
  sql("ALTER TABLE waitlist DROP COLUMN note");
  const legacy = await (await get("Élodie", "format=json&emailed=0&limit=1&offset=1")).json();
  assert.equal(legacy.admin_fields, false);
  assert.equal(legacy.count, 2);
  assert.equal(legacy.signups[0].email, "user103@example.com");
});
