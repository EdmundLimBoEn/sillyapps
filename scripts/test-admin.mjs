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
