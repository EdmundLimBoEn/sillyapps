import {
  filterSignups,
  jsonResponse,
  lastSevenDays,
  loadSignups,
  normalizeEmail,
  parseLeadPatch,
  parseListQuery,
  parseSignup,
  postRateLimited,
  presentSignup,
  readJson,
  readSignupBody,
  requireAdmin,
  toCsv,
} from "../lib/waitlist.js";

function missingDatabase() {
  return jsonResponse(503, { ok: false, error: "unavailable" });
}

function getDb(context) {
  const db = context.env.DB;
  if (!db || typeof db.prepare !== "function") {
    return null;
  }
  return db;
}

export async function onRequestPost(context) {
  if (postRateLimited(context.request)) {
    return jsonResponse(429, { ok: false, error: "rate_limited" });
  }

  const body = await readSignupBody(context.request);
  if (body == null) {
    return jsonResponse(400, { ok: false, error: "invalid_json" });
  }

  const parsed = parseSignup(body);
  if (!parsed.ok) {
    if (parsed.code === "spam") {
      return jsonResponse(200, { ok: true });
    }
    return jsonResponse(400, { ok: false, error: parsed.code });
  }

  const db = getDb(context);
  if (!db) {
    return missingDatabase();
  }

  try {
    await db
      .prepare(
        "INSERT OR IGNORE INTO waitlist (email, name, created_at) VALUES (?, ?, datetime('now'))"
      )
      .bind(parsed.signup.email, parsed.signup.name)
      .run();
  } catch (error) {
    console.error("waitlist insert failed", error?.message || error);
    return missingDatabase();
  }

  return jsonResponse(200, { ok: true });
}

export async function onRequestGet(context) {
  const gate = requireAdmin(context.request, context.env);
  if (!gate.ok) {
    return gate.response;
  }

  const db = getDb(context);
  if (!db) {
    return missingDatabase();
  }

  try {
    const loaded = await loadSignups(db);
    const query = parseListQuery(new URL(context.request.url).searchParams);
    const matched = filterSignups(loaded.rows, query).map(presentSignup);
    const format = new URL(context.request.url).searchParams.get("format");
    if (format === "json") {
      return jsonResponse(200, {
        ok: true,
        signups: matched,
        count: matched.length,
        total: loaded.rows.length,
        days: lastSevenDays(loaded.rows),
        admin_fields: loaded.adminFields,
      });
    }
    return new Response(toCsv(matched), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": "attachment; filename=waitlist.csv",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    console.error("waitlist export failed", error?.message || error);
    return missingDatabase();
  }
}

export async function onRequestPatch(context) {
  const gate = requireAdmin(context.request, context.env);
  if (!gate.ok) {
    return gate.response;
  }

  const parsed = parseLeadPatch(await readJson(context.request));
  if (!parsed.ok) {
    return jsonResponse(400, { ok: false, error: parsed.code });
  }

  const db = getDb(context);
  if (!db) {
    return missingDatabase();
  }

  const sets = [];
  const binds = [];
  if (Object.prototype.hasOwnProperty.call(parsed.patch, "emailed")) {
    sets.push("emailed = ?");
    binds.push(parsed.patch.emailed);
  }
  if (Object.prototype.hasOwnProperty.call(parsed.patch, "note")) {
    sets.push("note = ?");
    binds.push(parsed.patch.note);
  }
  binds.push(parsed.email);

  try {
    const result = await db
      .prepare(`UPDATE waitlist SET ${sets.join(", ")} WHERE email = ?`)
      .bind(...binds)
      .run();
    const changes = result?.meta?.changes ?? 0;
    if (!changes) {
      return jsonResponse(404, { ok: false, error: "not_found" });
    }
    const row = await db
      .prepare(
        "SELECT email, name, created_at, emailed, note FROM waitlist WHERE email = ?"
      )
      .bind(parsed.email)
      .first();
    if (!row) {
      return jsonResponse(404, { ok: false, error: "not_found" });
    }
    return jsonResponse(200, { ok: true, signup: presentSignup(row) });
  } catch (error) {
    console.error("waitlist patch failed", error?.message || error);
    return missingDatabase();
  }
}

export async function onRequestDelete(context) {
  const gate = requireAdmin(context.request, context.env);
  if (!gate.ok) {
    return gate.response;
  }

  const url = new URL(context.request.url);
  let email = normalizeEmail(url.searchParams.get("email") || "");
  if (!email) {
    const body = await readJson(context.request);
    email = normalizeEmail(body?.email || "");
  }
  if (!email) {
    return jsonResponse(400, { ok: false, error: "invalid_email" });
  }

  const db = getDb(context);
  if (!db) {
    return missingDatabase();
  }

  try {
    const result = await db
      .prepare("DELETE FROM waitlist WHERE email = ?")
      .bind(email)
      .run();
    const changes = result?.meta?.changes ?? 0;
    if (!changes) {
      return jsonResponse(404, { ok: false, error: "not_found" });
    }
    return jsonResponse(200, { ok: true, email });
  } catch (error) {
    console.error("waitlist delete failed", error?.message || error);
    return missingDatabase();
  }
}
