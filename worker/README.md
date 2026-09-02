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
2. Worker checks `Origin` against `ALLOWED_ORIGIN`, checks the per-IP KV rate limit, then calls `POST https://api.anthropic.com/v1/messages` with `stream: true` and the Anthropic key attached server-side, with `cache_control: { type: "ephemeral" }` on each system block (see "Token-size sanity check" below for the block split).
3. Worker passes Anthropic's SSE response stream straight through to the browser (`Content-Type: text/event-stream`) — it stays a thin proxy, no server-side re-parsing. `js/agent.js`'s `dispatch()` reads and renders `content_block_delta` events as they arrive.
4. On a 429 from either the Worker's own rate limit or Anthropic's, the browser shows a calm "reached its usage limit" message — never a raw error, and never a partial stream.

## Rate limiting — known limitation

The per-IP counter (`RATE_LIMIT_KV`, see `checkRateLimit()` in `src/index.js`) is **not atomic under rapid concurrent requests from the same IP**. Confirmed live via `wrangler tail`: the stored counter value went non-monotonic under rapid same-IP requests (e.g. `...9, 7, 10, 11, 12, 13, 8, 16...`) because Cloudflare KV is only eventually consistent — a classic get-then-put race, not a bug introduced later. In a rigorous test, 30+ rapid sequential requests from one IP never triggered the 30/hour limit at all.

Cloudflare's native Rate Limiting binding (`[[ratelimits]]` in `wrangler.toml`) was tried as an atomic replacement — correctly configured, API usage confirmed correct via `wrangler types`' generated `RateLimit` interface — but it **also failed to enforce the limit** in equally rigorous live testing (forced IPv4, single confirmed IP via `wrangler tail`, 30 requests spanning two separate complete 60-second windows, `success: true` all 30 times). Root cause not identified; reverted to the original KV counter rather than ship a "fix" that's also broken.

**Net effect**: this layer is a soft, imperfect speed bump, not a hard guarantee — under adversarial rapid-fire from one IP it may not trigger at all. The **$20/month Anthropic Console spend cap remains the actual hard financial backstop** regardless of this layer's precision. A real fix would need Durable Objects (the only genuinely atomic per-key rate-limiting primitive on Workers) — out of scope until it's explicitly prioritized.

See `README.md` (repo root) → "The AI agent" for the full behavior-rule spec this Worker's system prompt (built client-side in `js/agent.js`) has to satisfy, and → "Semantic layer" for what `layers` actually contains per request.

## Token-size sanity check (layer b)

Measured directly against the final Phase 2b dataset (127 products across 15 institutions), not assumed in advance: the cross-institution product-type index alone (`all_checking_accounts` + `all_savings_accounts` + `all_credit_cards`, the compact per-product fields only) was **~37.8K characters, ~9,400 tokens** — meaningfully bigger than it would have been against the original one-product-per-type dataset, since the full-catalog backfill roughly tripled the product count.

Combined with the system prompt (~550 tokens) and the smaller (c)/(g)/(h) layers, a no-context `open_qa` call — the highest-traffic entry point — ran **~10,300 input tokens** on the first call of a session. The Worker sends the instructions and the dataset layers as two separate `cache_control`-tagged blocks in `system` (see `src/index.js`), so a second, third, etc. no-context question in the same session hits the cache on both blocks — only the actual question text (in `messages`, never cached) is fresh each time. Switching context mid-session (e.g. opening a bank-context chat after a no-context one) only busts the smaller per-context layers block, not the shared instructions block. At a rough planning estimate (~$1/MTok input, ~$5/MTok output, 90% cache-read discount, `max_tokens: 400`), a full 10-question session came out to **roughly $0.04** — comfortably inside the $20/month cap (roughly 500 full sessions/month of headroom at this estimate). No trimming needed at this size.

**Correction from the original Phase 8 implementation**: the first version of this Worker only put `cache_control` on the system-prompt block and concatenated the dataset layers into the per-call user message — meaning the ~9,400-token layer block was never actually cached and got billed at full price on every single call, not just the first one. Fixed by moving the layers into their own cached system block (above) and shrinking the user message down to just the mode + question.

**Re-measured after Phase 2d** added `welcome_bonus_description` to layer (b) across all three product types (checking, savings, credit cards) — a deliberate decision so a no-context question like "which checking account has the best welcome bonus?" is answerable in one lookup, rather than staying layer-(a)-only where only bank-scoped calls could see it. (`relationship_programs`/`referral_program` stayed layer-(a)-only on purpose — they're not the kind of field someone compares across all 15 institutions in one no-context question the way a bonus amount is, so they didn't need this trade-off.) Layer (b) grew to **~47.0K characters, ~11,700 tokens** (+~2,300 tokens, +~25%), pushing the full no-context call to **~12,600 input tokens** and the 10-question session cost to **roughly $0.05** — monthly headroom at the $20 cap moves from ~500 to **roughly 410 full sessions/month**. Still comfortably sized for this project's expected traffic; re-measure again if a future refresh adds another free-text field at this scale (`monthly_fee_waiver_conditions` stayed array-of-short-tags rather than prose specifically to avoid this cost, and should keep doing so).

**Re-measured after Phase 11.1** fixed the bank/compare-context bug where context *replaced* the cross-institution baseline instead of adding to it, and added the new bank-level `bankProgramsIndex` (layer i) to that same unconditional baseline:

| Call type | Phase 2d (tokens) | Phase 11.1 (tokens) |
|---|---|---|
| No-context | ~12,600 | ~16,900 (+34%, from `bank_programs_index`) |
| Bank-context | ~2,000 (broken — this was the bug) | ~18,100 |
| Compare-context (2 products) | ~2,500 (broken) | ~19,400 |

10-question session cost moves from ~$0.05 to **roughly $0.07**; monthly headroom at the $20 cap moves from ~410 to **roughly 285 full sessions/month** (~9-10/day) — still comfortably sized for this project's realistic traffic. No trimming planned at this size; `bank_programs_index` ships at full fidelity rather than a trimmed summary. Re-measure again if a future data addition pushes this further.

This also motivated splitting the `system` payload into two `cache_control` blocks instead of one (see `src/index.js`): the cross-institution baseline (b/c/g/i, identical across every call now) and the context-specific addition (institution/institutions, present only for bank/compare context), in that prefix order. Previously, one merged block meant any context switch busted the *entire* dataset view, including the large shared baseline, even though only the small per-institution slice actually changed. Now a context switch only busts the small block — a session that opens a bank page, asks a follow-up, then asks a no-context question pays full price for the shared baseline only once.

This is a planning estimate, not a guarantee — actual Haiku 4.5 pricing may differ from the assumption above. Watch actual spend in the Anthropic Console once the Worker is live, and revisit which fields go into layer (b) if real usage patterns push cost meaningfully past this estimate.

**`max_tokens` raised from 400 to 1,000**, set directly rather than measured first — an 8-product table with per-row detail (the cap `SYSTEM_PROMPT` rule 10 sets) was estimated at 500-700 output tokens, and 400 would truncate it mid-row. `max_tokens` is a ceiling, not a fixed cost: short/typical ~4-line replies aren't billed any more for the higher cap, since output billing is by tokens actually generated. Worst-case output cost per call roughly doubles (400→1,000 tokens at ~$5/MTok output ≈ +$0.003/call) if every single call happened to hit the new ceiling, which typical conversational questions won't — the real-world session-cost estimate above stays a reasonable planning figure, not a hard bound. Verified post-deploy with a real 8-product comparison question that the response completes without truncation.
