const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const MAX_EMAIL = 254;
const MAX_NAME = 80;
const MAX_NOTE = 500;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_TOKEN_LENGTH = 512;
const MAX_RATE_KEYS = 10000;
const ADMIN_COOKIE = "waitlist_admin";
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
const POST_LIMIT = 8;
const POST_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LIMIT = 20;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

const rateHits = new Map();

export function normalizeEmail(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

export function parseSignup(input) {
  if (input == null || typeof input !== "object") {
    return { ok: false, code: "invalid_json" };
  }

  const company = typeof input.company === "string" ? input.company.trim() : "";
  if (company) {
    return { ok: false, code: "spam" };
  }

  const email = normalizeEmail(input.email);
  if (!email || email.length > MAX_EMAIL || !EMAIL_RE.test(email)) {
    return { ok: false, code: "invalid_email" };
  }
  if (email.includes("..") || email.startsWith(".") || email.includes("@.")) {
    return { ok: false, code: "invalid_email" };
  }

  let name = null;
  if (typeof input.name === "string") {
    const trimmed = input.name.trim();
    if (trimmed) {
      name = trimmed.slice(0, MAX_NAME);
    }
  }

  return { ok: true, signup: { email, name } };
}

export function parseLeadPatch(input) {
  if (input == null || typeof input !== "object") {
    return { ok: false, code: "invalid_json" };
  }

  const email = normalizeEmail(input.email);
  if (!email || email.length > MAX_EMAIL || !EMAIL_RE.test(email)) {
    return { ok: false, code: "invalid_email" };
  }

  const patch = {};
  if (Object.prototype.hasOwnProperty.call(input, "emailed")) {
    if (typeof input.emailed === "boolean") {
      patch.emailed = input.emailed ? 1 : 0;
    } else if (input.emailed === 0 || input.emailed === 1) {
      patch.emailed = input.emailed;
    } else {
      return { ok: false, code: "invalid_emailed" };
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, "note")) {
    if (input.note == null) {
      patch.note = null;
    } else if (typeof input.note === "string") {
      const trimmed = input.note.trim();
      if (trimmed.length > MAX_NOTE) {
        return { ok: false, code: "invalid_note" };
      }
      patch.note = trimmed || null;
    } else {
      return { ok: false, code: "invalid_note" };
    }
  }

  if (
    !Object.prototype.hasOwnProperty.call(patch, "emailed") &&
    !Object.prototype.hasOwnProperty.call(patch, "note")
  ) {
    return { ok: false, code: "empty_patch" };
  }

  return { ok: true, email, patch };
}

export function parseListQuery(searchParams) {
  const qRaw = searchParams.get("q");
  const q = typeof qRaw === "string" ? qRaw.trim().toLowerCase() : "";
  const from = dateOnly(searchParams.get("from"));
  const to = dateOnly(searchParams.get("to"));
  const emailedParam = searchParams.get("emailed");
  let emailed = null;
  if (emailedParam === "1" || emailedParam === "true") {
    emailed = 1;
  } else if (emailedParam === "0" || emailedParam === "false") {
    emailed = 0;
  }
  return { q, from, to, emailed };
}

export function filterSignups(rows, query) {
  return rows.filter((row) => {
    if (query.q) {
      const hay = `${row.email || ""} ${row.name || ""}`.toLowerCase();
      if (!hay.includes(query.q)) {
        return false;
      }
    }
    const created = String(row.created_at || "").slice(0, 10);
    if (query.from && created < query.from) {
      return false;
    }
    if (query.to && created > query.to) {
      return false;
    }
    if (query.emailed != null) {
      const flag = row.emailed ? 1 : 0;
      if (flag !== query.emailed) {
        return false;
      }
    }
    return true;
  });
}

export function lastSevenDays(rows, now = new Date()) {
  const days = [];
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let i = 6; i >= 0; i -= 1) {
    const key = new Date(start - i * 86400000).toISOString().slice(0, 10);
    days.push({ day: key, count: 0 });
  }
  const index = new Map(days.map((item) => [item.day, item]));
  for (const row of rows) {
    const key = String(row.created_at || "").slice(0, 10);
    const bucket = index.get(key);
    if (bucket) {
      bucket.count += 1;
    }
  }
  return days;
}

export function presentSignup(row) {
  return {
    email: row.email,
    name: row.name == null || row.name === "" ? null : row.name,
    created_at: row.created_at,
    emailed: Boolean(row.emailed),
    note: row.note == null || row.note === "" ? null : String(row.note),
  };
}

export function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function csvCell(value) {
  let text = value == null ? "" : String(value);
  if (/^[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

export function toCsv(rows) {
  const lines = ["email,name,created_at,emailed,note"];
  for (const row of rows) {
    const emailed = row.emailed ? "1" : "0";
    const note = row.note == null ? "" : row.note;
    lines.push(
      [
        csvCell(row.email),
        csvCell(row.name),
        csvCell(row.created_at),
        csvCell(emailed),
        csvCell(note),
      ].join(",")
    );
  }
  return `${lines.join("\n")}\n`;
}

export function tokensMatch(got, want) {
  if (
    typeof got !== "string" || typeof want !== "string" || !want ||
    got.length > MAX_TOKEN_LENGTH || want.length > MAX_TOKEN_LENGTH
  ) {
    return false;
  }
  const encoder = new TextEncoder();
  const a = encoder.encode(got);
  const b = encoder.encode(want);
  const len = Math.max(a.byteLength, b.byteLength);
  let diff = a.byteLength ^ b.byteLength;
  for (let i = 0; i < len; i += 1) {
    diff |= (a[i] || 0) ^ (b[i] || 0);
  }
  return diff === 0;
}

async function boundedBody(request) {
  const reader = request.body?.getReader();
  const chunks = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          void reader.cancel().catch(() => {});
          return jsonResponse(413, { ok: false, error: "payload_too_large" });
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  return new Response(new Blob(chunks), {
    headers: { "content-type": request.headers.get("content-type") || "" },
  });
}

export async function readSignupBody(request) {
  const contentType = request.headers.get("content-type") || "";
  try {
    const body = await boundedBody(request);
    if (body.status === 413) return body;
    if (contentType.includes("application/json")) {
      return await body.json();
    }
    if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      const form = await body.formData();
      return {
        email: form.get("email"),
        name: form.get("name"),
        company: form.get("company"),
      };
    }
  } catch {
    return null;
  }
  return null;
}

export async function readJson(request) {
  try {
    const body = await boundedBody(request);
    if (body.status === 413) return body;
    return await body.json();
  } catch {
    return null;
  }
}

export function readCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) {
      continue;
    }
    const key = part.slice(0, idx).trim();
    if (key === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return "";
      }
    }
  }
  return "";
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sessionHash(id) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id))));
}

function readSessionId(request) {
  const id = readCookie(request, ADMIN_COOKIE);
  return /^[a-f0-9]{64}$/.test(id) ? id : "";
}

async function cleanExpiredSessions(db) {
  await db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").bind(Date.now()).run();
}

export async function createAdminSession(db) {
  const id = hex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await cleanExpiredSessions(db);
  await db.prepare(
    "INSERT INTO admin_sessions (session_hash, created_at, expires_at) VALUES (?, ?, ?)"
  ).bind(await sessionHash(id), now, now + SESSION_LIFETIME_MS).run();
  return id;
}

export async function deleteAdminSession(request, db) {
  const id = readSessionId(request);
  if (id) {
    await db.prepare("DELETE FROM admin_sessions WHERE session_hash = ?")
      .bind(await sessionHash(id)).run();
  }
  await cleanExpiredSessions(db);
}

export function sessionCookie(id) {
  const parts = [
    `${ADMIN_COOKIE}=${encodeURIComponent(id)}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/",
  ];
  return parts.join("; ");
}

export function clearSessionCookie() {
  const parts = [
    `${ADMIN_COOKIE}=`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/",
    "Max-Age=0",
  ];
  return parts.join("; ");
}

export function clientIp(request) {
  return (request.headers.get("cf-connecting-ip") || "").trim();
}

export function hitLimit(bucket, ip, limit, windowMs, record = true) {
  const now = Date.now();
  for (const [key, entry] of rateHits) {
    if (entry.expires <= now) rateHits.delete(key);
  }
  if (!ip) return false;
  const key = `${bucket}:${ip}`;
  const recent = (rateHits.get(key)?.hits || []).filter((stamp) => now - stamp < windowMs);
  if (recent.length >= limit) return true;
  if (record) {
    if (!rateHits.has(key) && rateHits.size >= MAX_RATE_KEYS) {
      rateHits.delete(rateHits.keys().next().value);
    }
    rateHits.set(key, { hits: [...recent, now], expires: now + windowMs });
  }
  return false;
}

export function postRateLimited(request) {
  return hitLimit("post", clientIp(request), POST_LIMIT, POST_WINDOW_MS);
}

export function loginRateLimited(request) {
  return hitLimit("login", clientIp(request), LOGIN_LIMIT, LOGIN_WINDOW_MS, false);
}

export async function requireAdmin(request, env, token) {
  const want = env.WAITLIST_ADMIN_TOKEN;
  if (!want) {
    return { ok: false, response: new Response(null, { status: 404 }) };
  }
  if (loginRateLimited(request)) {
    return { ok: false, response: jsonResponse(429, { ok: false, error: "rate_limited" }) };
  }
  const header = request.headers.get("authorization") || "";
  let authenticated = false;
  if (token !== undefined || header.startsWith("Bearer ")) {
    authenticated = tokensMatch(token === undefined ? header.slice(7) : token, want);
  } else {
    const id = readSessionId(request);
    if (id) {
      try {
        authenticated = Boolean(await env.DB.prepare(
          "SELECT session_hash FROM admin_sessions WHERE session_hash = ? AND expires_at > ?"
        ).bind(await sessionHash(id), Date.now()).first());
      } catch {
        return { ok: false, response: jsonResponse(503, { ok: false, error: "unavailable" }) };
      }
    }
  }
  if (!authenticated) {
    hitLimit("login", clientIp(request), LOGIN_LIMIT, LOGIN_WINDOW_MS);
    return { ok: false, response: jsonResponse(401, { ok: false, error: "unauthorized" }) };
  }
  return { ok: true };
}

function dateOnly(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : "";
}

export const WAITLIST_SELECT_ADMIN =
  "SELECT email, name, created_at, emailed, note FROM waitlist ORDER BY created_at ASC";
export const WAITLIST_SELECT_BASE =
  "SELECT email, name, created_at FROM waitlist ORDER BY created_at ASC";

export async function loadSignups(db) {
  try {
    const result = await db.prepare(WAITLIST_SELECT_ADMIN).all();
    return { rows: result.results || [], adminFields: true };
  } catch {
    const result = await db.prepare(WAITLIST_SELECT_BASE).all();
    const rows = (result.results || []).map((row) => ({
      ...row,
      emailed: 0,
      note: null,
    }));
    return { rows, adminFields: false };
  }
}
