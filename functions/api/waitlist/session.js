import {
  clearSessionCookie,
  jsonResponse,
  loginRateLimited,
  readJson,
  requestIsHttps,
  requireAdmin,
  sessionCookie,
  tokensMatch,
} from "../../lib/waitlist.js";

export async function onRequestPost(context) {
  const want = context.env.WAITLIST_ADMIN_TOKEN;
  if (!want) {
    return new Response(null, { status: 404 });
  }

  const body = await readJson(context.request);
  const token = typeof body?.token === "string" ? body.token : "";
  if (!tokensMatch(token, want)) {
    if (loginRateLimited(context.request)) {
      return jsonResponse(429, { ok: false, error: "rate_limited" });
    }
    return jsonResponse(401, { ok: false, error: "unauthorized" });
  }

  const res = jsonResponse(200, { ok: true });
  res.headers.set("Set-Cookie", sessionCookie(token, requestIsHttps(context.request)));
  return res;
}

export async function onRequestDelete(context) {
  const want = context.env.WAITLIST_ADMIN_TOKEN;
  if (!want) {
    return new Response(null, { status: 404 });
  }
  const res = jsonResponse(200, { ok: true });
  res.headers.set(
    "Set-Cookie",
    clearSessionCookie(requestIsHttps(context.request))
  );
  return res;
}

export async function onRequestGet(context) {
  const gate = requireAdmin(context.request, context.env);
  if (!gate.ok) {
    return gate.response;
  }
  return jsonResponse(200, { ok: true });
}
