// Netlify serverless proxy for the Sleeper Trade Advisor web app.
//
// The browser app fetches from Sleeper and FantasyCalc directly when those
// APIs allow cross-origin requests. When they don't (or the browser is on a
// restricted network), the app falls back to this proxy, which forwards the
// request server-side and returns the JSON. It is intentionally locked to the
// two hosts the app needs so it can't be abused as an open proxy.

const ALLOWED_HOSTS = new Set(["api.sleeper.app", "api.fantasycalc.com"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(statusCode, obj, extraHeaders) {
  return {
    statusCode,
    headers: { ...CORS, "Content-Type": "application/json", ...(extraHeaders || {}) },
    body: typeof obj === "string" ? obj : JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return json(405, { error: "method not allowed" });
  }

  const target = event.queryStringParameters && event.queryStringParameters.url;
  if (!target) {
    return json(400, { error: "missing 'url' query parameter" });
  }

  let u;
  try {
    u = new URL(target);
  } catch (_e) {
    return json(400, { error: "invalid url" });
  }
  if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname)) {
    return json(403, { error: `host not allowed: ${u.hostname}` });
  }

  try {
    const resp = await fetch(u.toString(), {
      headers: {
        "User-Agent": "sleeper-trade-advisor-web/1.0",
        Accept: "application/json",
      },
    });
    const body = await resp.text();
    // Cache upstream responses briefly at the edge; the heavy player index and
    // value list change slowly, so this keeps repeated tab switches cheap.
    return json(resp.status, body, { "Cache-Control": "public, max-age=300" });
  } catch (e) {
    return json(502, { error: "upstream fetch failed", detail: String(e) });
  }
};
