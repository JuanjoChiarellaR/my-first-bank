# Agent proxy Worker

Cloudflare Worker that proxies Ask the Agent's calls to the Anthropic API. Holds the Anthropic API key as a secret (never in this repo), restricts CORS to the live GitHub Pages origin, enforces a per-IP rate limit independent of the client-side session cap, and runs every drafted reply through a second, independent compliance check before returning it — see "Why the second call exists" below. Not served by GitHub Pages — deployed separately.

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
2. Worker checks `Origin` against `ALLOWED_ORIGIN`, checks the per-IP KV rate limit — both still run before any Anthropic call, unchanged by everything below.
3. **Call #1 (generation)**: `POST https://api.anthropic.com/v1/messages`, `stream: false`, `max_tokens: 1500`, the Anthropic key attached server-side, `cache_control: { type: "ephemeral" }` on each system block (see "Token-size sanity check" below). Buffered, not streamed to the browser — the full draft text has to exist before the compliance check (next) can run.
4. **Call #2 (compliance check)**: a second, separate Anthropic call reviewing the draft — `{originalQuestion, draftReplyText}` only, never the dataset/context layers — before the user ever sees it. Uses Structured Outputs (`output_config: { format: { type: "json_schema", schema: {...} } }`) rather than free-text JSON, for reliable parsing on a safety-critical path. Verdict schema is uniform-polarity (`violates_no_recommendation_rule`, `violates_language_rule` — every field `true` means "block," deliberately avoiding a mixed-polarity inversion bug). **Fail-closed by construction**: the block decision defaults to blocked and is only flipped to allowed inside the single narrow success path after every check passes (HTTP 2xx, `stop_reason === "end_turn"`, valid JSON, both fields present and actually `typeof === "boolean"`) — see `runComplianceCheck()` in `src/index.js`. Both calls are wrapped in `AbortController` timeouts (15s generation, 8s classifier) so a hung upstream connection can't leave the whole response unresolved.
5. If call #1's own `stop_reason === "max_tokens"` (truncated) or the compliance check blocks the draft, the Worker returns a warm, on-brand fallback message instead — in the exact same `{ reply: "..." }` JSON shape as a normal reply, so the client never needs a special case for "this was swapped." See `FALLBACK_MESSAGE` in `src/index.js`.
6. On a 429 from either the Worker's own rate limit or Anthropic's, the browser shows a calm "reached its usage limit" message — never a raw error.

**This replaced true token-by-token streaming** (the Worker previously passed Anthropic's SSE response straight through as `text/event-stream`). A compliance gate can't sit in front of a response that's already streaming live to the browser — by the time a violation is detected, some of it would already be visible. `js/agent.js` now reveals the final buffered text with a client-side simulated animation instead (`revealText()`) — see the root README's "Ask the Agent" section for the UX rationale (two-phase typing-indicator copy, `prefers-reduced-motion` handling).

## Why the second call exists

Live adversarial testing (persona injection — "act as my financial coach" — combined with urgency framing and an elaborate multi-step scenario) found the system prompt alone failed non-deterministically: the identical adversarial prompt produced a real "here's what to open, in this order" recommendation in **2 of 4 identical trials**, confirmed by repetition, not a one-off. A strengthened prompt (see `js/agent.js`'s `SYSTEM_PROMPT` — an absolute boundary paragraph immune to persona/urgency/language override, restated at the end for the recency effect) meaningfully improves this, but LLM instruction-following can't be made mathematically deterministic through wording alone. The second call is a genuine technical backstop, not just stronger wording: 12/12 adversarial re-tests passed clean after both changes shipped together (persona-injection, direct non-persona ranking requests, and prompt-injection attempts targeting the classifier itself — all in English and Spanish).

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

**`max_tokens` raised from 400 to 1,000, then to 1,500** — the first raise (400→1,000) was set for the 8-product table cap; live adversarial testing then found even 1,000 wasn't always enough for elaborate combined table+commentary responses (confirmed truncating mid-sentence on a real "coach"-style question), so it moved to 1,500. `max_tokens` is a ceiling, not a fixed cost: short/typical replies aren't billed any more for a higher cap. **Truncation is now also caught deterministically**, independent of whether 1,500 is "enough": call #1's own `stop_reason === "max_tokens"` triggers the same fallback path as a compliance-check block, so an unusually long response that still hits the ceiling gets replaced cleanly rather than shown cut off mid-sentence.

**The compliance check (call #2) adds real, mostly-uncached cost.** Its system prompt isn't cache-annotated — Claude Haiku 4.5's minimum cacheable prefix is 4,096 tokens, and this prompt (~200 tokens) would never actually hit that floor, so `cache_control` here would be dead weight, not a real optimization. Per-call cost is small regardless (short system prompt + the draft reply as input, ~150-token output ceiling for the verdict) — roughly $0.002-0.004/call at Haiku rates, all uncached. Over a 10-question session that's an estimated +$0.02-0.04 on top of the existing ~$0.07/session figure above — still comfortably inside the $20/month cap, though this is a planning estimate to revisit against real Anthropic Console spend, same as every other number on this page.

## Phase 13 — cost audit: real billing data, extended cache TTL, layer (b) de-duplication

**Status: complete, live in production** (Worker version `46c43a16-1a5c-473c-a912-b344f2327e9c`).

A full audit against real Anthropic Console billing data (not just token-counting) found actual per-question cost running well past the ~$0.07-0.11/session estimate above: isolating a day of concentrated manual/adversarial testing, 805,185 tokens billed $0.48 total — **~$0.024/question** average across a realistic mix (open questions, bank/compare-context, heavy 10-11-row table requests, repeated adversarial persona-injection tests). At that rate a 10-question session costs ~$0.24, giving **~83 sessions/month** at the $20 cap.

**Root cause, confirmed against the real numbers**: the generation call's cacheable payload (system prompt + the unconditional cross-institution baseline, ≈18,400 tokens on the low end from a chars÷4 estimate, more once a bank/compare-context institution layer is added — matching the ~22,900-23,265 tokens actually observed per call in the real request logs) was mostly landing as a **cache miss**, not the cache-discounted hit the original cost model assumed. The default ephemeral cache TTL is 5 minutes — shorter than realistic pacing between a user's questions (reading an answer, asking a follow-up minutes later; adversarial/manual testing sessions have multi-minute gaps too). Backing out the blended rate from the real billing data (~$0.60/MTok vs. the ~$1/MTok base rate) confirmed *some* caching benefit was landing, just not most of it.

**Fix 1 — extended (1-hour) cache TTL.** Both cacheable system blocks on the generation call now use `cache_control: { type: "ephemeral", ttl: "1h" }` instead of the default 5-minute ephemeral cache, via the `anthropic-beta: extended-cache-ttl-2025-04-11` header (see `EXTENDED_CACHE_HEADERS` in `src/index.js`). No behavior or output change — pure cache infrastructure, so this didn't need the adversarial safety battery re-run, only structural verification. **Verified live in production** via `wrangler tail` with temporary debug logging (removed after verification): a first real question showed a clean cache write (`cache_creation_input_tokens: 21644`, correctly bucketed under `ephemeral_1h_input_tokens` rather than the 5-minute bucket); a second, identical question sent ~64 minutes later — after one intervening request that touched the same cache ~9 minutes in — came back as a full cache read (`cache_read_input_tokens: 21644`, `cache_creation_input_tokens: 0`, no fresh write). This is real evidence the 1-hour window (and Anthropic's cache-read-refreshes-TTL behavior) is doing exactly what recommendation 1 predicted: realistic multi-minute gaps between questions now land as hits far more often than under the old 5-minute window.

**Fix 2 — de-duplicated `last_verified_date`.** Every one of the 129 cross-institution product records in layer (b) carried the identical string `"2026-08-29"` after the Phase 9 normalization — repeating it per-record cost ~1,064 tokens (~6.5% of the baseline) for zero new information. `js/semantic-layer.js`'s `uniformProductsDate()` now collapses this into one top-level `productsLastVerifiedDate` field whenever every product's date genuinely matches, self-checking rather than a static one-time trim: the moment a future data refresh staggers verification dates again, it automatically falls back to per-record dates with no code change needed (see the function's own comment). `js/agent.js`'s system prompt field glossary was updated so the agent knows to read whichever shape it gets. **Measured live, not estimated**: the real payload shrank from 23,237 to 21,644 tokens — confirmed via the same `wrangler tail` session above (matching the `cache_creation_input_tokens: 21644` figure) — a real 1,593-token (~6.9%) reduction, larger than the ~1,064-token chars÷4 estimate, consistent with this project's established finding that the chars÷4 heuristic undercounts real Anthropic-billed tokens for JSON-heavy content by roughly 15-25%.

**Not changed, per explicit decision**: layer-trimming per context type (evaluated and rejected — would risk reopening the exact cross-institution-access regression Phase 11.1 fixed, for a saving that isn't needed given current headroom).

**Pending**: a real post-deploy per-session cost re-measurement against fresh Anthropic Console billing data, once enough real usage has accumulated under the new caching behavior, to confirm the ~83-sessions/month headroom actually improves in practice (not just structurally verified via the cache-hit test above).

## Latency

Measured directly against the live two-call flow (a pre-production Cloudflare preview, not a local mock), 6 diverse real questions (typical factual lookups, a table-comparison request, and one adversarial persona-injection question): **3.7s-7.3s, median ~4.8s**. A separate adversarial test batch (12 questions across persona-injection, direct-ranking, and classifier-injection attack angles) ranged 4.2s-16.5s, with the slow outlier on a long table-generating question — call #1 (generation) dominates total latency, especially for longer replies; call #2 (the classifier) is comparatively fast given its small, fixed-shape output.

This is meaningfully slower than true token-by-token streaming's "first token in under a second" feel — an accepted, deliberate trade-off for gating every response behind a compliance check before the user sees it (see "Why the second call exists" above). `js/agent.js`'s two-phase typing-indicator copy (`startTypingPhaseCycle()`) is tuned to these real numbers — switches from "Thinking through your question…" to "Double-checking the answer…" at 4s, to "Still working on it…" at 9s — rather than a guessed threshold. Revisit these thresholds if real production traffic's latency profile drifts from this measurement.
