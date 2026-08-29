# MyFirstBank

A static web app that helps international students and professionals compare US banks, digital banks, and fintechs while navigating the US banking system as newcomers.

## Who this is for

International students and professionals relocating to the US — recently graduated (MBA or Master's), starting a new job, moving to a new US city. The audience spans the **full newcomer spectrum**, not one narrow segment:

- People with nothing yet: no SSN, no ITIN, no US credit history (may have credit history in their home country).
- People with an ITIN but no SSN yet.
- People who already have an SSN and are simply comparing options as newcomers to the US banking system.

"No SSN" is **one filter among several** the product supports — it is not the premise the whole app is scoped around. Product copy, data, and framing must not narrow to that one segment.

## Language rules — non-negotiable

- **Every piece of the product is in English**: UI copy, data, labels, the AI agent's responses, disclaimers, everything.
- **The AI agent must understand questions in any language** the user types in, but **always responds in English**, regardless of input language. This is not an explicit "translate then answer" pipeline — the model is simply instructed to understand the question regardless of input language and respond in English. Both halves of this rule are written explicitly into the agent's system prompt (see below), not just the output half.

## Scope — 15 institutions

**Traditional banks (11):** JPMorgan Chase, Bank of America, Wells Fargo, Citibank, Capital One (acquired Discover in 2025), US Bank, PNC Bank, Truist, M&T Bank, TD Bank, HSBC (relevant for its Premier program allowing account opening before arriving in the US, for existing HSBC customers abroad).

**Digital-first bank (1):** Ally Bank (no branches, competitive APY, popular alternative to fee-heavy traditional checking).

**Fintechs (3):**
- Zolve — built for internationals, open account before arriving in the US.
- Firstcard — no SSN or ITIN required, reports to all 3 credit bureaus.
- Nova Credit — **not a bank**; a service that translates international credit history into something US lenders can use. Modeled with `"type": "credit_history_bridge"` and deliberately omits checking/savings/credit_card product records and branch-related fields that don't apply to it.

## Data architecture — 3 levels, all field names in English

Data was researched and last refreshed 2026-08. Before touching or re-researching any of `data/*.json`, read **[`data/RESEARCH_NOTES.md`](data/RESEARCH_NOTES.md)** first — it records which sources were used per field, which fields are `null` on purpose (and why), known business changes to re-check, and the exact rollup-recomputation logic for the `has_product_*` flags below. Treat it as the starting point for every future data refresh, not just a one-time research log.

### Level 1 — `data/banks.json`

Per institution:

```json
{
  "bank_id": "chase",
  "name": "JPMorgan Chase",
  "type": "traditional_bank",
  "headquarters": "New York, NY",
  "founded": 1799,
  "official_url": "chase.com",
  "total_assets_billion_usd": 3900,
  "num_branches_total": 4900,
  "num_atms_total": 15000,
  "coverage": "national",
  "num_states_present": 48,
  "online_banking": true,
  "mobile_app": true,
  "mobile_app_rating_ios": 4.8,
  "mobile_app_rating_android": 4.5,
  "mobile_app_rating_last_updated": "2026-08",
  "live_chat": true,
  "phone_support_24_7": true,
  "spanish_language_support": true,
  "can_open_account_online": true,
  "has_product_without_ssn": false,
  "has_product_with_itin": true,
  "has_product_no_us_credit_history_required": true,
  "num_checking_products": 4,
  "num_savings_products": 2,
  "num_credit_card_products": 6,
  "logo_path": "assets/logos/chase.svg",
  "logo_source": "chase.com/brand-assets",
  "logo_last_verified": "2026-08",
  "state_coverage_completeness": "exhaustive_fdic",
  "relationship_programs": [],
  "referral_program": {
    "terms": [{ "applies_to": ["checking"], "reward_description": "...", "official_url": "https://..." }],
    "last_verified_date": "2026-08-29"
  }
}
```

Notes:
- `mobile_app_rating_*` fields are a manual monthly snapshot — not real-time. Track `mobile_app_rating_last_updated`.
- `has_product_*` flags and `num_checking_products`/`num_savings_products`/`num_credit_card_products` are **rollups derived from the product level** (level 3) — the `has_product_*` flags mean at least one product of this bank satisfies the condition (checking/savings check `accepts_no_ssn`; credit cards check `requires_ssn === false`, so both must be considered), and the `num_*_products` fields are a straight count of that bank's records in the corresponding product file. Never hand-type these independently of the product data — run `scripts/recompute_rollups.py` after any change to `checking_accounts.json`, `savings_accounts.json`, or `credit_cards.json` to keep them from silently drifting out of sync.
- `logo_source` is a **required field** for every institution — record where the logo asset actually came from (official brand page, Wikimedia Commons, etc.), alongside `logo_last_verified`.
- `state_coverage_completeness`: `"exhaustive_fdic"` (every one of the 50 states + DC individually verified against the FDIC API — see Level 2), `"not_applicable_no_branches"` (digital-only/no physical branches, e.g. Ally, Zolve, Firstcard), or `"partial"` (reserved for any future institution researched to a lesser depth — flags that its `locations.json` entry is a sample, not exhaustive). Omitted entirely for Nova Credit (no branch concept applies).
- **Nova Credit** uses `"type": "credit_history_bridge"` and omits product-related and branch-related fields that don't apply.
- `relationship_programs` is an **array**, not a nullable single object — a bank can have zero, one, or (in principle) several bank-wide relationship/rewards tier programs. `[]` means genuinely confirmed absent, not unresearched. See `data/RESEARCH_NOTES.md`'s "Relationship programs, referral programs, and welcome bonuses" section for the full field shape, which 6 of 15 institutions actually have one, and why Chase deliberately gets `[]` rather than a synthesized program name.
- `referral_program` is normally a single nullable object with a `terms` array (multiple entries only when one program pays a different amount per product type). **Chase is an exception**: its `referral_program` is an array of two separate objects, because it genuinely runs two independently-administered referral programs (checking vs. credit card). Any code reading this field must check whether it's an array before treating it as one object — this is intentional, not a bug.

### Level 2 — `data/locations.json`

```json
{
  "chase": {
    "states": {
      "CA": { "branches": 1200, "atms": null },
      "WY": { "branches": 0, "atms": null }
    }
  }
}
```

**Three-value state model — not binary.** Every bank/state pair is one of: **confirmed present** (`branches` > 0), **confirmed absent** (`branches: 0` — an explicit, individually-verified zero), or **not yet verified** (the state key is simply absent from the object). These must never collapse into each other. For a bank tagged `state_coverage_completeness: "exhaustive_fdic"` in `banks.json`, all 51 states appear explicitly — a missing key would be a bug. For a `"partial"`-tagged bank, a missing key legitimately means "not verified," never "not present."

- `branches` per state: sourced from the FDIC BankFind API, queried **individually per state** (all 50 + DC), not aggregated from a single top-N pull — see `data/RESEARCH_NOTES.md` for the exact method and a query-syntax gotcha (state code `OR` must be quoted or the API misparses it as a boolean operator).
- `atms` per state: **not guaranteed to have a reliable public source.** If no reliable source exists, set to `null` — never estimate and present it as real. This null-over-guess discipline applies to every field in the dataset, not just ATMs.
- Granularity is state-level, not city-level — do not imply city-level precision the data doesn't support.
- **Copy rule (applies to the UI and the agent, not just the data):** a state with no confirmed-present data — whether confirmed-absent or not-yet-verified — must never be displayed or spoken as "not available here." Use: *"No confirmed branches found for [Bank] in [State] as of [date] — verify directly with the bank."* Same phrasing on Browse Banks/Bank Detail's state filter (Phase 5-7) and in the agent's responses (Phase 8).
- **Representative fee rule** (Browse Banks cards, Phase 5): the lowest `monthly_fee_usd` among a bank's checking products, shown as "Checking from $X/mo" — full rule and rationale in `data/RESEARCH_NOTES.md`.

### Level 3 — Products

`data/checking_accounts.json`, `data/savings_accounts.json`, `data/credit_cards.json` — one array each, all fields in English.

**Checking account fields** (per product):

```json
{
  "product_id": "chase_total_checking",
  "bank_id": "chase",
  "name": "Chase Total Checking",
  "product_type": "checking",
  "monthly_fee_usd": 12,
  "monthly_fee_waiver_conditions": ["direct_deposit_500_plus", "balance_1500_daily", "combined_balance_5000"],
  "min_opening_deposit_usd": 0,
  "min_balance_required_usd": 0,
  "interest_bearing": false,
  "apy": 0,
  "overdraft_fee_usd": 34,
  "overdraft_protection_available": true,
  "atm_fee_out_of_network_usd": 3,
  "atm_fee_reimbursement": false,
  "debit_card_included": true,
  "zelle_available": true,
  "accepts_no_ssn": true,
  "no_ssn_requirements": ["passport", "F-1 or J-1 visa", "I-20 or DS-2019", "in_person_application_required"],
  "accepts_itin": false,
  "can_open_online": true,
  "requires_branch_visit": false,
  "welcome_bonus_description": "Earn a $400 bonus by opening a new Chase Total Checking account and completing $1,000+ in qualifying direct deposits within 90 days. Offer through 2026-10-14.",
  "product_url": "chase.com/checking/total-checking",
  "last_verified_date": "2026-08"
}
```

`no_ssn_requirements` (array of strings, checking/savings only) is populated **only when `accepts_no_ssn` is true** and there's a specific pathway worth describing beyond the boolean — most often a real, narrower pathway than the product's general/standard flow (e.g. international students opening in person with a passport + visa + I-20, distinct from the online flow that requires an SSN). **This never overrides `can_open_online` or `requires_branch_visit`**, which describe the general product — a product can be genuinely online-capable in general while still requiring an in-person visit specifically for the no-SSN pathway; both facts coexist on the same record. See `data/RESEARCH_NOTES.md` → "International-student / visa-holder no-SSN pathway" for the research method and per-institution findings.

`welcome_bonus_description` (string or `null`, checking/savings — mirrors the field that already existed on credit cards) is the **most time-sensitive field in the dataset**: these are promotional account-opening offers that rotate every few months, so the expiration date is written directly into the text rather than tracked as a separate field. Re-verify these first on any data refresh — see `data/RESEARCH_NOTES.md` → "Relationship programs, referral programs, and welcome bonuses."

**Savings account fields**: same pattern as checking (`apy_current`, `fdic_insured`, `accepts_no_ssn`, `no_ssn_requirements`, `accepts_itin`, `can_open_online`, `requires_branch_visit`, `welcome_bonus_description`, `last_verified_date`, etc.).

**Credit card fields** — include both **eligibility** and **benefits/rewards** as distinct groups (needed for the Compare field selector):

```json
{
  "product_id": "chase_freedom_rise",
  "bank_id": "chase",
  "name": "Chase Freedom Rise",
  "product_type": "credit_card",
  "annual_fee_usd": 0,
  "apr_regular_min": 26.99,
  "apr_regular_max": 26.99,
  "foreign_transaction_fee_pct": 3,
  "eligibility_requirements": ["SSN or ITIN", "no prior US credit history required", "proof of income"],
  "requires_ssn": true,
  "accepts_itin": false,
  "accepts_no_us_credit_history": true,
  "reports_to_equifax": true,
  "reports_to_experian": true,
  "reports_to_transunion": true,
  "rewards_type": "cashback",
  "rewards_rate_description": "1.5% cashback on all purchases",
  "points_or_miles_per_dollar": null,
  "redemption_options": ["statement credit", "travel", "gift cards"],
  "annual_rewards_cap_usd": null,
  "card_benefits": ["no foreign transaction fee", "free credit score access"],
  "welcome_bonus_description": "$25 statement credit with autopay in first 3 months",
  "product_url": "chase.com/credit-cards/freedom-rise",
  "last_verified_date": "2026-08"
}
```

Every product record needs `last_verified_date` — **it must be displayed in the UI** (product card, flipped detail, and every Compare table) so users know the data isn't stale, alongside the standing disclaimer to verify with the bank directly. This is part of the trust design, not just data hygiene — it is not enough for the field to exist only in the JSON.

## Site architecture

Navbar (fixed, visible on every page): **Browse Banks** (= home, root `/`) · **Compare** · **Ask the Agent**

### Page 1 — Browse Banks (root `/`)
- Compact hero at the top: 2-3 lines max, what this is, who it's for (the full newcomer spectrum), how it works. No call-to-action leading elsewhere — the user is already where they need to be.
- Filter bar directly below the hero (product type, documentation status, state, etc.).
- Grid of institution cards (15 total): logo, name, type, 2-3 eligibility badges (derived flags from level 1), a representative fee, and its `last_verified_date`.
- Clicking a card navigates to that bank's detail page.
- On mobile, the filter bar collapses into a "Filters" button opening a drawer/modal rather than eating the whole screen.

### Page 1a — Bank Detail (child of Browse Banks, not in the navbar)
- Top section: full bank detail.
- Below: product cards grouped by type (checking / savings / credit card), each with a flip interaction (tap/click to flip and reveal detail; each card keeps independent state, so several can be flipped open at once). Flip is on the Y axis, ~400-500ms, ease-in-out (no bounce), touch-friendly with a generous tap target (min 44x44px). `last_verified_date` is visible on both the front and the flipped detail of every product card.
- A button, "Ask about this bank," which sends the user to Ask the Agent with this bank preloaded as context.

### Page 2 — Compare
- Selection flow, in this order: (1) user picks a product **type** to compare (checking / savings / credit card) — comparisons only happen within the same type, never mixed; (2) user clicks "Add to Compare" on individual products from Browse Banks or Bank Detail, up to **4 products max**; (3) once products are selected, a field selector appears showing only fields relevant to that product type (grouped as eligibility vs. benefits for credit cards), letting the user choose what to display. `last_verified_date` is always one of the rendered rows — never optional in the field selector.
- Result renders as a **table**, not cards — one row per field, one column per product.
- Compare is entirely static/deterministic — **no AI agent call happens here.** No auto-generated summary text. The table speaks for itself, sourced directly from the JSON data, with zero risk of the agent misstating a number.
- A button at the bottom of the table, "Ask the Agent about these," sends the user to Ask the Agent with these specific products preloaded as context.
- Persist the current Compare selection in `localStorage` so an accidental reload doesn't lose it.

### Page 3 — Ask the Agent
See "The AI agent" below. This is the **only** part of the site that calls the Claude API (via the Cloudflare Worker proxy — see Stack).

## Design system

### Palette — deliberately grayscale + white, with one functional accent
The site must read as clean, neutral, and digital — **not** using any color that could be mistaken for a specific bank's brand color, and specifically not the warm cream/terracotta palette associated with Claude's own product interface. Color exists in exactly one place: signaling eligibility.

| Token | Value |
|---|---|
| Page background | `#FAFAF9` |
| Card surfaces | `#FFFFFF`, border `#E4E3DD` (1px hairline) |
| Primary text | `#1F1F1D` |
| Secondary/metadata text | `#6B6B65` |
| Placeholder/tertiary text | `#A3A29B` |
| Hover background (rows, cards, nav items) | `#F2F1EC` |
| Active nav item | primary text color + 2px bottom border in the same primary color — never a color fill |
| Functional green — fill | `#3FA76B` / `#2E9563` |
| Functional green — muted background | `#E7F3EC` |
| Functional green — text-on-tint | `#1F6B42` |
| Primary button | solid `#1F1F1D` fill, white text, hover `#3A3A36` |
| Secondary button | transparent, gray border, hover fill `#F2F1EC` |

The functional green is **the only accent in the entire site**, reserved exclusively for eligibility signals (badges like "no SSN needed," the logo's checkmark, "yes" states). Never reuse this green for navigation states, buttons, or decoration — it must stay a single, unambiguous signal.

Bank logos: since each of the 15 logos carries its own brand color, contain every logo inside a neutral white card-token (white background matching most official logo assets, 1px hairline border, same corner radius as the site's cards) so the logo's own color reads clearly without clashing with the page.

### Typography
- Display/headings: Inter Tight, semi-bold (600)
- Body/UI text: Inter, regular/medium
- All numeric data (fees, APR, figures) in a monospace face (IBM Plex Mono or JetBrains Mono) — this is what makes comparison data feel precise and "digital," and makes columns in the Compare table align cleanly.

### Logo concept (placeholder — good enough to ship the MVP with, expected to be redesigned later)
A tilted bank card icon: white card body, gray chip (top-left), a four-arc contactless symbol (top-right, matching the real ISO contactless payment symbol — concentric quarter-circle arcs of increasing radius, not a generic wifi icon), and a green checkmark badge overlapping the bottom-right corner. Card sits on the light gray page background. This same green checkmark visual language is reused throughout the UI for eligibility badges, tying the brand mark to the product's actual function.

### Motion
- Page transitions (Browse Banks ↔ Bank Detail): a subtle slide + fade, ~300ms, content entering from the right when going deeper into the journey, reversing when going back. The navbar itself never animates — it's the fixed anchor.
- No bounce/spring easing anywhere in this project — always ease-in-out, consistent with a serious financial-decision context.

### Accessibility (not optional)
- Flip cards must announce front/back state to screen readers, not just visually.
- WCAG AA contrast verified on the green functional accent — both the solid fill and the muted-background/text-on-tint combinations.
- `prefers-reduced-motion` respected across every animation: page transitions and flip cards alike.
- Full keyboard navigation with visible focus states, site-wide (navbar, filters, cards, compare table, chat) — not just the flip cards.

## The AI agent

### Where it lives
The agent participates in **exactly one section of the site: Ask the Agent.** Nowhere else — Browse Banks, Bank Detail, and Compare are all static and free. This is a deliberate cost and reliability decision (see Costs below) and a product decision (informs-never-recommends — see Behavior rules).

### Three context entry points, always feeding the same underlying agent
1. **No context** — user navigates to Ask the Agent directly from the navbar.
2. **Bank context** — user arrives via "Ask about this bank" from a Bank Detail page. The agent receives a banner like `"The user was just viewing: Chase"` — this resolves implicit pronouns ("does this bank accept ITIN?") but never restricts what the agent can discuss. The user can ask about any other institution in the same conversation and the agent must answer normally.
3. **Compare context** — user arrives via "Ask the Agent about these" from Compare, with up to 4 specific products preloaded as a banner.

### Two question modes, available regardless of entry point
1. **Open question** — free text, any question within banking scope, any input language accepted, response always in English.
2. **Filtered search** — five fields, **all required** before the "Ask" button is enabled (nothing is sent to the API until all five are filled):
   - Product type (checking / savings / credit card)
   - Documentation status (has SSN / has ITIN / has neither yet)
   - US credit history status (has it / doesn't / has international history only)
   - State
   - Priority (lowest fees / branches nearby / building US credit history)

   Plus an optional free-text clarification. When arriving with bank/compare context already loaded, pre-fill whatever fields that context already answers.

### Behavior rules (system prompt), non-negotiable
- **Only informs, never recommends.** Never says "you should choose X" — presents facts side by side and lets the user decide. This is a deliberate product and liability-reduction decision — a hard rule, not a style preference.
- **Language, both halves, stated explicitly in the prompt text**: (a) understand/accept questions in any input language the user types in; (b) always respond in English, regardless of what language the question was asked in.
- **Only uses the provided dataset.** No connection to, or claims sourced from, any external knowledge, even if the model "knows" something about these banks from training. If the dataset doesn't cover something, say so plainly rather than filling the gap from general knowledge.
- **Refuses out-of-scope questions** (visa status, immigration law, tax filing, general financial/legal advice) politely, and redirects to what it can help with — this is banking-product information only.
- **Never asks for or stores personal identifiers.** If a user pastes something like a full SSN or account number into a question, the agent should gently note they don't need to share that to get an answer, and proceed without repeating it back.
- Max ~4 lines per response. Always include a short reminder to verify current terms directly with the bank before applying, and that the data has a `last_verified_date`.

### Semantic layer — do not send the raw source JSONs directly to the model
A flattened, per-institution view is built in JavaScript before any API call, rather than making the model cross-reference `bank_id` across separate files at question time:

```json
{
  "chase": {
    "name": "JPMorgan Chase",
    "type": "traditional_bank",
    "eligibility_summary": { "no_ssn_available": false, "itin_accepted": true, "no_us_credit_history_ok": false },
    "state_presence": { "CA": 1200, "NY": 980 },
    "products": [ { "name": "Chase Total Checking", "type": "checking", "monthly_fee": 12, "requires_ssn": false, "accepts_itin": true } ]
  }
}
```

- Include a short field glossary in the system prompt so the model interprets fields exactly as defined (e.g. clarify that `no_us_credit_history_ok` means at least one product doesn't require it, and the agent should still check the specific product before stating details).
- Two versions of this view: a **compact** one (all 15 institutions, key fields only) for open questions with no prior context, and a **full** one (only the 1-4 institutions/products already in scope) for bank-context, compare-context, and filtered-search calls — this keeps token usage proportional to how narrow the question already is.
- Use prompt caching for the system prompt + compact dataset view, since it's identical across most calls and changes only when the underlying data is manually refreshed.

### Costs and rate limiting
- Model: Claude Haiku 4.5.
- Global spend cap: $20/month, set directly in the Anthropic Console as a hard safety net.
- **Per-session limit**: 10 questions total per browser session (not per entry point — navigating between bank pages, Compare, and the agent multiple times still draws from the same 10-question pool via `localStorage`). When the session limit is reached, the chat visibly disables further input with a clear message — never fails silently or throws a raw error.
- **Worker-level rate limit** (second, independent layer): a basic per-IP rate limit enforced inside the Cloudflare Worker itself, since the client-side `localStorage` cap alone is trivially bypassed by hitting the Worker endpoint directly (e.g. from DevTools, bypassing the UI entirely).
- When the monthly spend cap is hit, the chat disables itself globally with a clear, calm message (not a broken UI) until the cap is manually raised.

## Legal, privacy, and trust

- Footer, visible on every page: "This is not financial advice — informational only," plus "MyFirstBank is an independent, unaffiliated resource. All bank names, logos, and trademarks are the property of their respective owners."
- A short Privacy Policy page: what's collected (anonymous, aggregate visits via GoatCounter — no cookies, no personal identifiers), what's explicitly not collected or stored (names, SSNs, account numbers, chat contents beyond the live session), and a note that chat questions are processed via the Anthropic API (through the Worker proxy) under Anthropic's own terms.
- `og:image`, `og:title`, `og:description` meta tags configured so social share previews look intentional — a simple 1200x630px preview image using the same design system (logo mark + a one-line value prop), not a default/broken preview.

## Analytics

GoatCounter (free indefinitely, no cookies, no consent banner required). Tracks: page views, which filters get used most, how many users reach Ask the Agent. Purely aggregate — no user-level tracking. Shipped with a placeholder site code until a GoatCounter account exists; see the comment in the snippet for where to swap it in.

## Stack

- Alpine.js (via CDN) for all interactivity — flip card state, Compare selection, filter state, chat state, localStorage-backed session data. No build step.
- Tailwind CSS (via CDN) for styling, following the design tokens above exactly.
- Static JSON files for all data, versioned in the repo.
- Hosted on GitHub Pages, deployed straight from the repo.
- **Claude API (Haiku 4.5), called only from the Ask the Agent section, through a Cloudflare Worker proxy** — the one deliberate, scoped exception to "no backend" in this project. Calling the Anthropic API directly from the browser would expose the API key in public JS, where it could be scraped and used outside this site entirely, burning through the spend cap without any real user involved. The Worker:
  - Holds the Anthropic API key as a `wrangler secret` — the key is never present in any repo file and never ships to the browser.
  - Restricts `Access-Control-Allow-Origin` explicitly to the live GitHub Pages origin (not `*`), so the endpoint doesn't silently accept requests from other sites.
  - Enforces the Worker-level per-IP rate limit described above.
  - Applies prompt caching to the system prompt + compact dataset view.
  - Everything else in the project remains 100% static; the Worker is the only server-side code in the repo, deployed separately via `wrangler deploy`, not served by GitHub Pages.

## Repo structure

```
/my-first-bank
  README.md                  (this file — canonical project doc)
  index.html                 (Browse Banks / home)
  /banks/{bank_id}.html       (or client-side routed detail views)
  compare.html
  agent.html
  privacy.html
  /data
    banks.json
    locations.json
    checking_accounts.json
    savings_accounts.json
    credit_cards.json
  /assets
    /logos
      chase.svg
      ...
      _fallback.svg
    og-image.png
  /js
    app.js
    agent.js
    data-loader.js
  /css
    styles.css (if anything beyond Tailwind utility classes is needed)
  /worker
    (Cloudflare Worker source for the agent proxy — not served by GitHub Pages)
```

## Build order

1. Scaffold the repo structure and empty data files. *(done)*
2. Research and populate the full dataset (all 15 institutions, all 3 levels) — flag any field where no reliable source was found rather than guessing. *(done, then backfilled to full personal-product catalogs and exhaustive 51-state coverage after a completeness audit — see [`data/RESEARCH_NOTES.md`](data/RESEARCH_NOTES.md) for sources, method, and known gaps)*
3. Download/source the 15 official logos, normalize them into the neutral card-token treatment. *(done — 12 sourced from Wikimedia Commons, 3 fintechs with no public logo asset got a neutral text wordmark fallback; see [`data/RESEARCH_NOTES.md`](data/RESEARCH_NOTES.md) for exact sources)*
4. Build Browse Banks (hero + filters + grid) first, since every other page depends on this data being correctly loaded and rendered.
5. Build Bank Detail pages with the flip-card product sections. *(done — all 15 pages generated from `banks/_template.html` via `scripts/generate-bank-pages.py`, re-run it after editing the template or the institution list)*
6. Build Compare. *(done)*
7. Build Ask the Agent (system prompt, semantic layer generation, the three context entry points, the two question modes, rate limiting) and the Cloudflare Worker proxy (CORS, secret key, worker-level rate limit). *(code done and verified client-side with a mocked Worker; live deploy needs the user to create an Anthropic key + Cloudflare account — see `worker/README.md` — `WORKER_URL` in `js/agent.js` ships empty until then, with a graceful "not connected" state instead of a broken fetch)*
8. Add the footer, Privacy Policy page, and og:image.
9. Wire up GoatCounter.
10. **Run the full audit** — product, UX, visual design, data completeness, technical robustness, accessibility (WCAG AA contrast on the green accent, `prefers-reduced-motion`, full keyboard navigation), and copy — on an actual mobile viewport, before considering this done. Fix whatever falls short rather than shipping it as a known gap.

## Audit bar

Before writing any code, and again after the MVP is functionally complete: **a newcomer to the US banking system, with no prior knowledge of it, must be able to open this link on their phone and actually use it to make a real decision.**

This would be a failure if a real user said any of the following:
- "This looks ugly or unpolished."
- "I can't read this" (contrast, font size, spacing).
- "I don't understand what this does or how to use it."
- "This is hard to use" (confusing navigation, broken filters, unclear chat).
- "This is missing information I actually needed" (incomplete or inaccurate bank/product data).

Audit from every angle before declaring done: product, UX, visual design, data completeness and accuracy, technical robustness (mobile, graceful failure), and copy. If any of these is weak, fix it before presenting the MVP as done.
