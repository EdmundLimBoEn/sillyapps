import {
  clearSessionCookie,
  createAdminSession,
  deleteAdminSession,
  jsonResponse,
  loginRateLimited,
  readJson,
  rateLimitedResponse,
  requireAdmin,
  rejectCrossSiteAdmin,
  sessionCookie,
} from "../../lib/waitlist.js";

export async function onRequestPost(context) {
  const want = context.env.WAITLIST_ADMIN_TOKEN;
  if (!want) {
    return new Response(null, { status: 404 });
  }

  const crossSite = rejectCrossSiteAdmin(context.request);
  if (crossSite) return crossSite;
  const body = await readJson(context.request);
  if (body instanceof Response) return body;
  const token = typeof body?.token === "string" ? body.token : "";
  try {
    const retryAfter = token && await loginRateLimited(context.request, context.env.DB);
    if (retryAfter) {
      return rateLimitedResponse(retryAfter);
    }
  } catch {
    return jsonResponse(503, { ok: false, error: "unavailable" });
  }
  const gate = await requireAdmin(context.request, context.env, token);
  if (!gate.ok) return gate.response;

  try {
    const id = await createAdminSession(context.env.DB);
    const res = jsonResponse(200, { ok: true });
    res.headers.set("Set-Cookie", sessionCookie(id));
    return res;
  } catch {
    return jsonResponse(503, { ok: false, error: "unavailable" });
  }
}

export async function onRequestDelete(context) {
  const want = context.env.WAITLIST_ADMIN_TOKEN;
  if (!want) {
    return new Response(null, { status: 404 });
  }
  const crossSite = rejectCrossSiteAdmin(context.request);
  if (crossSite) return crossSite;
  try {
    await deleteAdminSession(context.request, context.env.DB);
  } catch {
    return jsonResponse(503, { ok: false, error: "unavailable" });
  }
  const res = jsonResponse(200, { ok: true });
  res.headers.set(
    "Set-Cookie",
    clearSessionCookie()
  );
  return res;
}

export async function onRequestGet(context) {
  const gate = await requireAdmin(context.request, context.env);
  if (!gate.ok) {
    return gate.response;
  }
  return jsonResponse(200, { ok: true });
}
