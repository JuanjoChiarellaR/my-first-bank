# Agent proxy Worker

Cloudflare Worker that proxies Ask the Agent's calls to the Anthropic API. Holds the Anthropic API key as a secret (never in this repo), restricts CORS to the live GitHub Pages origin, and enforces a per-IP rate limit independent of the client-side session cap. Not served by GitHub Pages — deployed separately.

## One-time setup

1. **Install Wrangler** (Cloudflare's CLI), if not already: `npm install -g wrangler` (or use `npx wrangler` for every command below without a global install).
2. **Log in**: `wrangler login` — opens a browser, needs a free Cloudflare account.
3. **Get an Anthropic API key** if you don't have one: console.anthropic.com → Settings → API Keys → Create Key. Set a **monthly spend cap of $20** in the Console under Settings → Limits — this is the outer financial safety net for the whole project, separate from the rate limits below.
4. **Set the key as a Worker secret** (never put it in a file):
   ```
   cd worker
   wrangler secret put ANTHROPIC_API_KEY
   ```
   Paste the key when prompted.
5. **(Recommended) Create the rate-limit KV namespace**:
   ```
   wrangler kv:namespace create RATE_LIMIT_KV
   ```
   Copy the `id` it prints into `wrangler.toml`'s commented-out `[[kv_namespaces]]` block and uncomment it. Without this, the Worker still runs but the per-IP rate limit fails open (allows all requests) — fine for local testing, not for a public deploy.
6. **Set `ALLOWED_ORIGIN`** in `wrangler.toml` to the real GitHub Pages URL once Phase 11 (Deploy) is done — e.g. `https://<username>.github.io` for a user site, or `https://<username>.github.io/my-first-bank` for a project site (check whether GitHub Pages serves your repo from the root or a subpath, and match exactly, no trailing slash).

## Deploy

```
cd worker
wrangler deploy
```

Wrangler prints the live Worker URL (`https://myfirstbank-agent.<your-subdomain>.workers.dev`). Paste that into `WORKER_URL` at the top of `js/agent.js` back in the repo root, commit, and push — the site's Ask the Agent page won't call the Worker until that constant is filled in (it currently ships empty on purpose, with a visible "not connected yet" message instead of a broken fetch).

## Local dev

`wrangler dev` runs the Worker locally (defaults to `http://localhost:8787`). Point `WORKER_URL` at that during local testing, and set `ALLOWED_ORIGIN` in `wrangler.toml` to match whatever origin you're serving the static site from locally (e.g. `http://localhost:8765` if using `python3 -m http.server 8765` from the repo root, which is already the default in `wrangler.toml`).

## What it does, end to end

1. Browser POSTs `{ system, mode, question, layers }` to the Worker (see `js/agent.js`'s `dispatch()`).
2. Worker checks `Origin` against `ALLOWED_ORIGIN`, checks the per-IP KV rate limit, then calls `POST https://api.anthropic.com/v1/messages` with the Anthropic key attached server-side, `cache_control: { type: "ephemeral" }` on the system prompt block for prompt caching.
3. Worker returns `{ reply: "..." }` to the browser.
4. On a 429 from either the Worker's own rate limit or Anthropic's, the browser shows a calm "reached its usage limit" message — never a raw error.

See `README.md` (repo root) → "The AI agent" for the full behavior-rule spec this Worker's system prompt (built client-side in `js/agent.js`) has to satisfy, and → "Semantic layer" for what `layers` actually contains per request.

## Token-size sanity check (layer b)

Measured directly against the final Phase 2b dataset (127 products across 15 institutions), not assumed in advance: the cross-institution product-type index alone (`all_checking_accounts` + `all_savings_accounts` + `all_credit_cards`, the compact per-product fields only) is **~37.8K characters, ~9,400 tokens** — meaningfully bigger than it would have been against the original one-product-per-type dataset, since the full-catalog backfill roughly tripled the product count.

Combined with the system prompt (~550 tokens) and the smaller (c)/(g)/(h) layers, a no-context `open_qa` call — the highest-traffic entry point — runs **~10,300 input tokens** on the first (uncached) call of a session, then hits the cached system prompt + shared layers on the following calls within the same cache window. At a rough planning estimate (~$1/MTok input, ~$5/MTok output, 90% cache discount on repeat calls, `max_tokens: 400`), a full 10-question session comes out to **roughly $0.04** — comfortably inside the $20/month cap (roughly 500 full sessions/month of headroom at this estimate). No trimming needed at this size.

This is a planning estimate, not a guarantee — actual Haiku 4.5 pricing may differ from the assumption above. Watch actual spend in the Anthropic Console once the Worker is live, and revisit which fields go into layer (b) if real usage patterns push cost meaningfully past this estimate.
