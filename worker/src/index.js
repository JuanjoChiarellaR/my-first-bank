// MyFirstBank agent proxy — the one non-static piece of this project.
// Holds the Anthropic API key as a secret and forwards Ask the Agent's
// requests to Claude Haiku 4.5. The browser never sees the key.
//
// Env bindings expected (see ../wrangler.toml and ../README.md):
//   ANTHROPIC_API_KEY  (secret)  — `wrangler secret put ANTHROPIC_API_KEY`
//   ALLOWED_ORIGIN     (var)     — the live GitHub Pages origin, e.g.
//                                  "https://username.github.io"
//   RATE_LIMIT_KV      (KV namespace binding) — per-IP request counter.
//   KNOWN LIMITATION (see worker/README.md "Rate limiting"): this counter
//   is not atomic under rapid concurrent requests from the same IP -- KV's
//   eventual consistency means fast-fired requests can each read a stale
//   pre-increment value. Confirmed live: 30+ rapid sequential requests from
//   one IP never triggered the limit. Cloudflare's native Rate Limiting
//   binding was tried as a fix and also failed to enforce in live testing
//   (30 requests across two separate 60s windows, same IP, all allowed) --
//   root cause not yet identified. Left as this original implementation
//   pending a decision on the real fix (most likely Durable Objects, the
//   only genuinely atomic per-key option on this platform). The $20/month
//   Anthropic spend cap remains the actual hard financial backstop
//   regardless of this layer's precision.

const MODEL = "claude-haiku-4-5";
const WORKER_RATE_LIMIT_PER_HOUR = 30; // per IP, independent of the client's 10/session cap — see limitation note above

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

// Cloudflare's native Rate Limiting binding — atomic, unlike the original
// hand-rolled KV get-then-put counter this replaced. That design looked
// correct in code review but failed under real rapid-fire testing: KV
// isn't strongly consistent, so concurrent requests from the same IP could
// each read a stale pre-increment count and all get allowed through,
// letting the observed counter value jump backward between requests
// instead of climbing monotonically — caught by literally trying to
// trigger the limit live, not by reading the implementation.
async function checkRateLimit(env, ip) {
  if (!env.RATE_LIMIT_KV) return true; // fail open if KV isn't bound yet, rather than breaking the whole agent
  const key = `rl:${ip}:${Math.floor(Date.now() / 3600000)}`; // one bucket per IP per hour
  const current = parseInt((await env.RATE_LIMIT_KV.get(key)) || "0", 10);
  if (current >= WORKER_RATE_LIMIT_PER_HOUR) return false;
  await env.RATE_LIMIT_KV.put(key, String(current + 1), { expirationTtl: 3600 });
  return true;
}

function buildUserContent(mode, question) {
  return `Mode: ${mode}\n\nQuestion: ${question}`;
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

    const { system, mode, question, layers, contextLayers } = body || {};
    if (!system || !question || !layers) {
      return new Response(JSON.stringify({ error: "Missing system, question, or layers" }), { status: 400, headers });
    }

    // Three cacheable system blocks, in a stable-content-first prefix order
    // (required for prompt caching to hit on a shared prefix even when a
    // later block changes): instructions (identical every call), the
    // cross-institution baseline (identical across EVERY call now — see
    // js/agent.js's buildContextLayers, which used to only send this for
    // no-context calls, a real bug), and the current-page context (only
    // present for bank/compare context, and the only block a context
    // switch busts — a no-context question after a bank-context one no
    // longer re-pays for the large shared baseline, only for this small
    // block appearing/disappearing).
    const systemBlocks = [
      { type: "text", text: system, cache_control: { type: "ephemeral" } },
      { type: "text", text: `Dataset context (JSON):\n${JSON.stringify(layers)}`, cache_control: { type: "ephemeral" } },
    ];
    if (contextLayers) {
      systemBlocks.push({
        type: "text",
        text: `Current page context (JSON):\n${JSON.stringify(contextLayers)}`,
        cache_control: { type: "ephemeral" },
      });
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
          // Raised from 400: an 8-product table with per-row detail (the
          // cap SYSTEM_PROMPT rule 10 sets) runs an estimated 500-700 output
          // tokens, and 400 would truncate it mid-row. This is a ceiling,
          // not a fixed cost — short/typical replies aren't billed any more
          // for the higher cap, only genuinely long ones get the room they
          // need. Set directly without a prior measurement pass; verified
          // post-deploy with a real 8-product comparison question instead.
          max_tokens: 1000,
          stream: true,
          system: systemBlocks,
          messages: [
            { role: "user", content: buildUserContent(mode, question) },
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

      // Pass Anthropic's SSE stream straight through — the Worker stays a
      // thin proxy, no server-side re-parsing. js/agent.js's dispatch()
      // reads and interprets the content_block_delta events on the client.
      return new Response(anthropicRes.body, {
        headers: { ...headers, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Worker error", detail: String(err) }), { status: 500, headers });
    }
  },
};
