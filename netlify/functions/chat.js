// Serverless chat backend for the Sleeper Trade Advisor "Ask AI" tab.
//
// Holds the Groq API key server-side (never exposed to the browser) and calls
// Groq's OpenAI-compatible endpoint with an open-weights model (Llama 3.3 70B).
// The browser sends the user's question plus a snapshot of their live league
// data; this function wraps it in a trade-strategy system prompt and returns
// the model's reply. Optionally gated behind a shared password.
//
// Required Netlify environment variable:
//   GROQ_API_KEY   — free key from https://console.groq.com
// Optional:
//   CHAT_PASSWORD  — if set, callers must send the matching password
//   GROQ_MODEL     — override the model id (default below)

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

const MAX_HISTORY = 12; // messages kept from the conversation
const MAX_MSG_CHARS = 4000; // per-message cap
const MAX_CONTEXT_CHARS = 24000; // league-snapshot cap
const MAX_OUTPUT_TOKENS = 800;

// Best-effort in-memory rate limit (per warm instance, per client IP).
const RATE = { windowMs: 60_000, max: 20, hits: new Map() };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(statusCode, obj) {
  return { statusCode, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function rateLimited(ip) {
  const now = Date.now();
  const entry = RATE.hits.get(ip) || { count: 0, reset: now + RATE.windowMs };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + RATE.windowMs;
  }
  entry.count += 1;
  RATE.hits.set(ip, entry);
  return entry.count > RATE.max;
}

function systemPrompt(context) {
  return `You are a sharp, decisive fantasy football trade advisor for the user's Sleeper league.

You are given a LIVE SNAPSHOT of their league below: rosters, objective market trade values (from FantasyCalc), each team's positional needs and surplus, and suggested trade targets. Ground every answer in that snapshot.

Rules:
- Never invent players, values, injuries, byes, or matchups that are not in the snapshot. If the data doesn't contain something, say so plainly.
- A good trade wins on VALUE (do the totals roughly balance?) and FIT (does it fix a starting need without piling onto a position you're already deep at?). The best trades win on both. Consolidating two good bench pieces into one starter at a position of need is often correct even if it looks slightly "down" on value.
- Value bands from the user's side: > +15% clear win; +5–15% favorable; -5 to +5% a coin flip (decide on fit); -15 to -5% an overpay only worth it to fill a real need; < -15% decline or counter.
- Buy-low = a quality player whose value has dropped; sell-high = a player whose value just spiked. Use the values in the snapshot.
- Respect the league format shown (dynasty vs redraft, QB count, PPR).
- Lead with a clear recommendation ("Yes, do it" / "I'd counter" / "Pass"), then 2–3 concrete reasons tied to the data, flag the main risk, and suggest a next step.
- Be concise and specific. Trade values are a market snapshot, not gospel — treat sub-5% gaps as coin flips.

=== LEAGUE SNAPSHOT ===
${context || "(no league data was provided)"}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed." });

  const key = process.env.GROQ_API_KEY;
  if (!key) {
    return json(500, {
      error:
        "The chat backend isn't configured yet — set GROQ_API_KEY in your Netlify site's environment variables (free key at console.groq.com).",
    });
  }

  const ip =
    (event.headers && (event.headers["x-nf-client-connection-ip"] || event.headers["x-forwarded-for"])) ||
    "unknown";
  if (rateLimited(String(ip).split(",")[0].trim())) {
    return json(429, { error: "Too many messages in a short window — give it a minute and try again." });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_e) {
    return json(400, { error: "Invalid request body." });
  }

  const required = process.env.CHAT_PASSWORD;
  if (required && body.password !== required) {
    return json(401, { error: "Incorrect access password." });
  }

  const history = (Array.isArray(body.messages) ? body.messages : [])
    .slice(-MAX_HISTORY)
    .map((m) => ({
      role: m && m.role === "assistant" ? "assistant" : "user",
      content: String((m && m.content) || "").slice(0, MAX_MSG_CHARS),
    }))
    .filter((m) => m.content);

  if (!history.length) return json(400, { error: "No message to send." });

  const context = String(body.context || "").slice(0, MAX_CONTEXT_CHARS);
  const model = process.env.GROQ_MODEL || DEFAULT_MODEL;
  const messages = [{ role: "system", content: systemPrompt(context) }, ...history];

  try {
    const resp = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, temperature: 0.4, max_tokens: MAX_OUTPUT_TOKENS }),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const msg = (data && data.error && data.error.message) || `Groq request failed (HTTP ${resp.status}).`;
      return json(resp.status === 401 ? 502 : resp.status, { error: msg });
    }
    const reply =
      (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) ||
      "(the model returned an empty response)";
    return json(200, { reply, model });
  } catch (e) {
    return json(502, { error: "Couldn't reach Groq: " + String(e) });
  }
};
