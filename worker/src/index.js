// MyFirstBank agent proxy — the one non-static piece of this project.
// Holds the Anthropic API key as a secret and forwards Ask the Agent's
// requests to Claude Haiku 4.5. The browser never sees the key.
//
// Env bindings expected (see ../wrangler.toml and ../README.md):
//   ANTHROPIC_API_KEY  (secret)  — `wrangler secret put ANTHROPIC_API_KEY`
//   ALLOWED_ORIGIN     (var)     — the live GitHub Pages origin, e.g.
//                                  "https://username.github.io"
//   RATE_LIMIT_KV      (KV namespace binding) — per-IP request counter

const MODEL = "claude-haiku-4-5";
const WORKER_RATE_LIMIT_PER_HOUR = 30; // per IP, independent of the client's 10/session cap

function corsHeaders(env, request) {
  const origin = request.headers.get("Origin");
  const allowed = origin && origin === env.ALLOWED_ORIGIN ? origin : env.ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

async function checkRateLimit(env, ip) {
  if (!env.RATE_LIMIT_KV) return true; // fail open if KV isn't bound yet, rather than breaking the whole agent
  const key = `rl:${ip}:${Math.floor(Date.now() / 3600000)}`; // one bucket per IP per hour
  const current = parseInt((await env.RATE_LIMIT_KV.get(key)) || "0", 10);
  if (current >= WORKER_RATE_LIMIT_PER_HOUR) return false;
  await env.RATE_LIMIT_KV.put(key, String(current + 1), { expirationTtl: 3600 });
  return true;
}

function buildUserContent(mode, question, layers) {
  return [
    `Mode: ${mode}`,
    `Question: ${question}`,
    `Dataset context (JSON):`,
    JSON.stringify(layers),
  ].join("\n\n");
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(env, request);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
    }

    const origin = request.headers.get("Origin");
    if (env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN) {
      return new Response(JSON.stringify({ error: "Origin not allowed" }), { status: 403, headers });
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const withinLimit = await checkRateLimit(env, ip);
    if (!withinLimit) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded" }), { status: 429, headers });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers });
    }

    const { system, mode, question, layers } = body || {};
    if (!system || !question || !layers) {
      return new Response(JSON.stringify({ error: "Missing system, question, or layers" }), { status: 400, headers });
    }

    try {
      const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 400,
          system: [
            { type: "text", text: system, cache_control: { type: "ephemeral" } },
          ],
          messages: [
            { role: "user", content: buildUserContent(mode, question, layers) },
          ],
        }),
      });

      if (!anthropicRes.ok) {
        const errText = await anthropicRes.text();
        return new Response(JSON.stringify({ error: "Upstream error", detail: errText }), {
          status: anthropicRes.status === 429 ? 429 : 502,
          headers,
        });
      }

      const data = await anthropicRes.json();
      const reply = data.content?.[0]?.text || "";
      return new Response(JSON.stringify({ reply }), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Worker error", detail: String(err) }), { status: 500, headers });
    }
  },
};
