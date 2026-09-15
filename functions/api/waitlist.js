import {
  jsonResponse,
  parseSignup,
  readSignupBody,
  toCsv,
  tokensMatch,
} from "../lib/waitlist.js";

function missingDatabase() {
  return jsonResponse(503, { ok: false, error: "unavailable" });
}

export async function onRequestPost(context) {
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

  const db = context.env.DB;
  if (!db || typeof db.prepare !== "function") {
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
  const want = context.env.WAITLIST_ADMIN_TOKEN;
  if (!want) {
    return new Response(null, { status: 404 });
  }

  const header = context.request.headers.get("authorization") || "";
  const got = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!tokensMatch(got, want)) {
    return jsonResponse(401, { ok: false, error: "unauthorized" });
  }

  const db = context.env.DB;
  if (!db || typeof db.prepare !== "function") {
    return missingDatabase();
  }

  try {
    const result = await db
      .prepare(
        "SELECT email, name, created_at FROM waitlist ORDER BY created_at ASC"
      )
      .all();
    const rows = result.results || [];
    const format = new URL(context.request.url).searchParams.get("format");
    if (format === "json") {
      return jsonResponse(200, { ok: true, signups: rows });
    }
    return new Response(toCsv(rows), {
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
