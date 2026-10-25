#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../site/admin/admin.js", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const listed = { signups: [{ email: "ada@example.com" }] };
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function element() {
  return {
    hidden: false, dataset: {}, textContent: "", children: [], fields: {}, listeners: {},
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    setAttribute() {},
    reset() { this.fields = {}; },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    fire(type) { return this.listeners[type]({ preventDefault() {} }); },
    querySelector() { return this.clear ||= element(); },
  };
}
async function browser() {
  const nodes = new Map();
  const get = (name) => {
    if (!nodes.has(name)) nodes.set(name, element());
    return nodes.get(name);
  };
  const calls = [];
  const queue = [];
  vm.runInNewContext(source, {
    document: {
      querySelector: (selector) => get(selector.slice(6, -1)),
      querySelectorAll: () => [], createElement: element,
    },
    FormData: class {
      constructor(form) { this.fields = { ...form.fields }; }
      get(key) { return this.fields[key]; }
      entries() { return Object.entries(this.fields); }
    },
    URLSearchParams, AbortController,
    window: { confirm: () => true },
    fetch: async (url, init) => {
      calls.push({ url, ...init });
      // Deliberately ignore abort to exercise the generation guard as well.
      return queue.length ? queue.shift() : Response.json({}, { status: 401 });
    },
  });
  await tick();
  return {
    get, calls, queue,
    async login() {
      queue.push(Response.json({ ok: true }), Response.json(listed));
      get("login-form").fields.token = "test-only-token";
      await get("login-form").fire("submit");
      assert.equal(get("board").hidden, false);
      assert.equal(get("rows").children.length, 1);
    },
  };
}

test("browser login uses only the session cookie for subsequent requests", async () => {
  const app = await browser();
  await app.login();
  assert.deepEqual(JSON.parse(app.calls[1].body), { token: "test-only-token" });
  assert.equal(app.get("login-form").fields.token, undefined);
  app.queue.push(Response.json(listed));
  await app.get("filters").fire("submit");
  app.queue.push(Response.json({ ok: true }));
  await app.get("logout").fire("click");
  for (const call of app.calls.slice(2)) {
    assert.equal(new Headers(call.headers).has("authorization"), false);
    assert.equal(call.credentials, "same-origin");
  }
});

for (const field of ["emailed", "note"]) {
  for (const status of [200, 500]) {
    test(`failed ${field} save (${status}) restores persisted values and keeps its error`, async () => {
      const app = await browser();
      await app.login();
      const column = field === "emailed" ? 3 : 4;
      const control = app.get("rows").children[0].children[column].children[0];
      if (field === "emailed") control.checked = true;
      else control.value = "Unsaved note";
      app.queue.push(Response.json({ ok: false }, { status }), Response.json(listed));
      await control.fire("change");
      assert.equal(app.calls.at(-2).method, "PATCH");
      assert.deepEqual(JSON.parse(app.calls.at(-2).body), {
        email: "ada@example.com", [field]: field === "emailed" ? true : "Unsaved note",
      });
      const restored = app.get("rows").children[0].children[column].children[0];
      assert.equal(field === "emailed" ? restored.checked : restored.value,
        field === "emailed" ? false : "");
      assert.equal(app.get("board-status").textContent, "Could not save that row.");
      assert.equal(app.get("board-status").dataset.kind, "err");
    });
  }
}

for (const phase of ["headers", "body"]) {
  test(`delayed filter ${phase} after logout cannot render rows`, async () => {
    const app = await browser();
    await app.login();
    const delayed = deferred();
    app.queue.push(phase === "headers" ? delayed.promise : {
      ok: true, status: 200, json: () => delayed.promise,
    });
    const filtering = app.get("filters").fire("submit");
    await tick();
    const pending = app.calls.at(-1);
    app.queue.push(Response.json({ ok: true }));
    await app.get("logout").fire("click");
    delayed.resolve(phase === "headers" ? Response.json(listed) : listed);
    await filtering;
    assert.equal(app.get("rows").children.length, 0);
    assert.equal(app.get("board").hidden, true);
    assert.equal(app.get("login").hidden, false);
    assert.equal(pending.signal.aborted, true);
  });
}

test("a stale 401 cannot log out a newer login", async () => {
  const app = await browser();
  await app.login();
  const delayed = deferred();
  app.queue.push(delayed.promise);
  const filtering = app.get("filters").fire("submit");
  app.queue.push(Response.json({ ok: true }));
  await app.get("logout").fire("click");
  await app.login();
  delayed.resolve(Response.json({}, { status: 401 }));
  await filtering;
  assert.equal(app.get("board").hidden, false);
  assert.equal(app.get("rows").children.length, 1);
});

for (const operation of ["filter", "delete"]) {
  test(`${operation} receiving 401 shows login and clears rows`, async () => {
    const app = await browser();
    await app.login();
    app.queue.push(Response.json({}, { status: 401 }));
    if (operation === "filter") await app.get("filters").fire("submit");
    else await app.get("rows").children[0].children[5].children[0].fire("click");
    assert.equal(app.get("login").hidden, false);
    assert.equal(app.get("board").hidden, true);
    assert.equal(app.get("rows").children.length, 0);
  });
}

for (const phase of ["headers", "body"]) {
  for (const newerAction of ["filter", "clear"]) {
    test(`stale filter ${phase} cannot overwrite newer ${newerAction} results`, async () => {
      const app = await browser();
      await app.login();
      const delayed = deferred();
      const stale = { ...listed, total: 9, admin_fields: false, days: [] };
      app.queue.push(phase === "headers" ? delayed.promise : {
        ok: true, status: 200, json: () => delayed.promise,
      });
      app.get("filters").fields.q = "ada";
      const older = app.get("filters").fire("submit");
      await tick();
      const latest = {
        signups: [{ email: "new@example.com" }], total: 2, count: 1,
        days: [{ count: 1 }],
      };
      app.queue.push(Response.json(latest));
      if (newerAction === "clear") await app.get("filters").querySelector().fire("click");
      else {
        app.get("filters").fields.q = "new";
        await app.get("filters").fire("submit");
      }
      assert.equal(new URL(app.calls.at(-1).url, "https://example.com").searchParams.get("q"),
        newerAction === "clear" ? null : "new");
      delayed.resolve(phase === "headers" ? Response.json(stale) : stale);
      await older;
      assert.equal(app.get("rows").children[0].dataset.email, "new@example.com");
      assert.equal(app.get("count").textContent, "Showing 1 of 2");
      assert.equal(app.get("migration-banner").hidden, true);
      assert.equal(app.get("spark").hidden, false);
      assert.equal(app.get("board-status").textContent, "");
    });
  }
}

for (const status of [200, 401, 404, 500]) {
  test(`stale filter response ${status} leaves the newer pending request alone`, async () => {
    const app = await browser();
    await app.login();
    const first = deferred();
    const second = deferred();
    app.queue.push(first.promise, second.promise);
    const older = app.get("filters").fire("submit");
    const newer = app.get("filters").fire("submit");
    first.resolve(Response.json(listed, { status }));
    await older;
    assert.equal(app.get("board-status").textContent, "Filtering…");
    assert.equal(app.get("board").hidden, false);
    second.resolve(Response.json({ ok: false }, { status: 500 }));
    await newer;
    assert.equal(app.get("board-status").textContent, "Could not load the waitlist.");
  });
}
