# Data research notes

Knowledge management for the dataset in this folder — what was used to build it, what's known to be missing, and what to check first the next time the data gets refreshed. Start here before re-researching from scratch.

**Last full research pass:** 2026-08 (all `last_verified_date` / `logo_last_verified` fields reflect this).

## Method used

Research was split into 4 parallel passes, each covering a subset of the 15 institutions, using live web search/fetch against official sources rather than relying on model training knowledge (rates and fees change too often to trust from memory). Grouping used:

- Group A: Chase, Bank of America, Wells Fargo, Citibank
- Group B: Capital One, US Bank, PNC Bank, Truist
- Group C: M&T Bank, TD Bank, HSBC, Ally Bank
- Group D: Zolve, Firstcard, Nova Credit (the fintechs — handled separately since they don't have branch networks and Nova Credit isn't a bank at all)

This grouping is a reasonable split for next time too (each group stayed under ~600 tool calls / ~130K tokens), but it's not required — regroup however makes sense for what's being refreshed.

## Sources used, by data type

- **Branch counts per state** (`data/locations.json`): FDIC BankFind Suite API. Query `banks.data.fdic.gov/api/locations` (or `api.fdic.gov` directly — `banks.data.fdic.gov` 301-redirects there, so if a fetch tool doesn't follow redirects, hit `api.fdic.gov` directly). Filter by institution CERT number or name, aggregate the returned branch list by state. This worked cleanly for all FDIC-insured banks with physical branches. Ally, Zolve, Firstcard, and Nova Credit have no `locations.json` entry by design (no branches / not a depository institution).
- **ATM counts** (`num_atms_total`, and per-state `atms`): essentially never publicly available at the state level, and often unreliable even at the total level (banks either don't publish it or the number that circulates online blends owned + partner-network ATMs, e.g. Allpoint/MoneyPass). Expect most `atms` fields to stay `null` indefinitely unless a bank starts publishing this directly — don't spend much time re-searching these.
- **Total assets, branch/state footprint at the whole-bank level**: most recent 10-Q/10-K or earnings release, or the FDIC institution record.
- **Product fees/rates/eligibility**: each bank's own product pages, fetched directly. Some banks render current APY/rate figures via client-side JS, so a plain fetch returns `NaN`/blank where a number should be (hit Capital One, US Bank, and PNC's savings APY pages specifically) — third-party rate-aggregator sites often disagree with each other on these, so when the official page can't be scraped cleanly, the field was left `null` rather than trusting an aggregator.
- **Logos**: official newsroom/brand-asset/press pages first (most banks have one, e.g. `media.chase.com`, `newsroom.bankofamerica.com`, `pnc.mediaroom.com`, `brandcorner.td.com`). Wikimedia Commons as fallback where no clean official asset page was found (Wells Fargo, Citibank). Actual SVG download/normalization is a separate step (Phase 3), not done during this data pass — `logo_source` only records where to get it.
- **Mobile app ratings**: Apple App Store pages fetched directly worked most of the time; Google Play pages were unreliable to fetch programmatically (blocked, 404s, or JS-rendered) — expect `mobile_app_rating_android` to be `null` more often than `_ios` for that reason, not because the rating doesn't exist.

## Known nulls and why (don't re-guess these — re-research them properly or leave null)

- All per-state `atms` values, and most `num_atms_total` — see above.
- Several savings APYs (Capital One 360 Performance Savings, US Bank Smartly Savings, PNC Standard Savings) — JS-rendered pages, conflicting third-party numbers.
- Several `foreign_transaction_fee_pct` / `apr_regular_min`/`max` on secured/no-frills cards (Citi Secured Mastercard, PNC Core/Secured, Truist Enjoy Cash, US Bank Altitude Go, TD Cash) — not disclosed as clean numbers on the official page at research time.
- `mobile_app_rating_android` for US Bank, TD Bank, Zolve, Firstcard — see Google Play note above.
- `mobile_app_rating_ios`/`android` both null for Firstcard — App Store page 404'd, third-party sources had too few reviews (<20) to trust.
- `total_assets_billion_usd`, `num_atms_total`, `num_states_present` null for Zolve/Firstcard — not applicable/not disclosed for these fintechs.

## Business changes worth re-checking on every refresh (these shift over time)

- **Capital One / Discover**: acquisition closed 2025-05-18. As of 2026-08, Discover-branded cards are still marketed separately; account migration to Capital One systems started 2026-07-27 and is expected to run through 2027. Re-check whether Discover products have merged into Capital One's own lineup yet — if so, `data/credit_cards.json` needs new Discover-origin entries under `capital_one`.
- **Ally Bank exited the credit card business** (sold to CardWorks/Merrick Bank, rebranded "Ollo," Jan 2025) — Ally has no `credit_cards.json` entry as a result. Re-check in case Ally re-enters this market.
- **Wells Fargo discontinued its personal secured credit card** in Dec 2019 and still has none as of 2026-08 — Active Cash (an unsecured, credit-history-requiring card) was used instead, meaning Wells Fargo is one of the few banks here with `has_product_no_us_credit_history_required: false`. Re-check if this changes.
- **Nova Credit / American Express partnership ended in 2025** — Nova Credit's `known_us_partners_accepting_report` list should be re-verified each refresh since lender partnerships change.
- **HSBC US retail footprint has shrunk sharply** (down to ~22 domestic branches after selling most retail branches to Citizens/Cathay Bank) — HSBC US is now effectively a Premier-relationship-only presence. Re-verify branch count before assuming this is stable.

## Other things worth knowing before the next pass

- Truist's `founded: 2019` reflects the BB&T/SunTrust merger date, not either predecessor bank's founding — intentional, per the "founded" field's plain meaning for the current legal entity.
- HSBC's `accepts_no_ssn: true` on checking/savings reflects the Premier program specifically (open a US account remotely with a passport, before arriving) — this is the reason HSBC is in scope at all per the project brief; don't lose this nuance in a future refresh that treats HSBC like a generic traditional bank.
- Citi Secured Mastercard's official page states a valid SSN is required (`accepts_itin: false`), while some third-party sites claim ITIN works via in-branch application — the official page was treated as authoritative. Worth re-checking directly with Citi if this matters for a specific user question.
- Zolve's headquarters is genuinely reported inconsistently across sources (San Francisco vs. Bengaluru vs. Roseland NJ) — recorded as San Francisco with Bengaluru noted, not a data-entry error.
- `has_product_without_ssn` / `has_product_with_itin` / `has_product_no_us_credit_history_required` in `banks.json` are **rollups recomputed from the actual product records**, not independently researched — see the reconciliation logic below. If products change, these three flags must be recomputed, not hand-edited.

## Rollup recomputation logic (banks.json `has_product_*` flags)

```
has_product_without_ssn      = any checking/savings product has accepts_no_ssn == true
                                OR any credit card has requires_ssn == false
has_product_with_itin        = any checking/savings/credit_card product has accepts_itin == true
has_product_no_us_credit_history_required = any credit card has accepts_no_us_credit_history == true
```

During the 2026-08 reconciliation, this logic caught two real contradictions the per-group research had missed: Bank of America's and Wells Fargo's secured/flagship cards both have `requires_ssn: false`, but their bank-level `has_product_without_ssn` had been left `false`. Both were corrected. **Re-run this recomputation (or the equivalent check) after any product-level edit** — never hand-edit these three flags directly.

## Recommended refresh process

1. Re-read this file first.
2. Re-run the same 4 research groups (or regroup as needed), reusing the source list above — prioritize re-checking the "business changes worth re-checking" section, since those are the fields most likely to have actually changed.
3. For fields currently `null`: don't assume they're still unfindable — official pages sometimes start publishing figures they didn't before. Worth a real re-check, not a copy-paste of `null`.
4. After merging new data, re-run the rollup recomputation logic above before writing the final `banks.json` — do this programmatically (see the Python snippet used in the 2026-08 pass, not reproduced here, but any script that loads all 5 JSON files and applies the three formulas above works).
5. Update every touched product's `last_verified_date` and, if a logo changed, `logo_last_verified`.
