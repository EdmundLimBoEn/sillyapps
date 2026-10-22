import {
  clearSessionCookie,
  jsonResponse,
  loginRateLimited,
  readJson,
  requestIsHttps,
  requireAdmin,
  sessionCookie,
} from "../../lib/waitlist.js";

export async function onRequestPost(context) {
  const want = context.env.WAITLIST_ADMIN_TOKEN;
  if (!want) {
    return new Response(null, { status: 404 });
  }

  if (loginRateLimited(context.request)) {
    return jsonResponse(429, { ok: false, error: "rate_limited" });
  }
  const body = await readJson(context.request);
  if (body instanceof Response) return body;
  const token = typeof body?.token === "string" ? body.token : "";
  const gate = requireAdmin(context.request, context.env, token);
  if (!gate.ok) return gate.response;

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
