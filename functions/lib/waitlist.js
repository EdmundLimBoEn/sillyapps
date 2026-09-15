const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const MAX_EMAIL = 254;
const MAX_NAME = 80;

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
  const text = value == null ? "" : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

export function toCsv(rows) {
  const lines = ["email,name,created_at"];
  for (const row of rows) {
    lines.push(
      [csvCell(row.email), csvCell(row.name), csvCell(row.created_at)].join(",")
    );
  }
  return `${lines.join("\n")}\n`;
}

export function tokensMatch(got, want) {
  if (typeof got !== "string" || typeof want !== "string" || !want) {
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

export async function readSignupBody(request) {
  const contentType = request.headers.get("content-type") || "";
  try {
    if (contentType.includes("application/json")) {
      return await request.json();
    }
    if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      const form = await request.formData();
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
