#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";
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
    return {
      bind(...args) {
        return statement(sql, args);
      },
      async run() {
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
        if (missingAdminColumns && text.includes("emailed")) {
          throw new Error("no such column: emailed");
        }
        const list = [...rows.values()].map(asRow);
        list.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
        return { results: list };
      },
      async first() {
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
