#!/usr/bin/env python3
"""Recomputes every bank-level rollup field in data/banks.json from the actual
product records in data/checking_accounts.json, data/savings_accounts.json,
and data/credit_cards.json — these fields must never be hand-typed, since
they'd silently drift from the real product catalog the moment a product is
added, removed, or corrected.

Rollups recomputed:
- has_product_without_ssn / has_product_with_itin / has_product_no_us_credit_history_required
  (true if ANY product of ANY type for that bank matches)
- num_checking_products / num_savings_products / num_credit_card_products
  (straight counts, no research needed — just how many records exist per bank_id)

Run this after any edit to the three product JSON files, or after adding a new
institution. Safe to re-run any time; it only rewrites the rollup fields
listed above, leaving every other field in banks.json untouched.
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

banks = json.loads((DATA / "banks.json").read_text())
checking = json.loads((DATA / "checking_accounts.json").read_text())
savings = json.loads((DATA / "savings_accounts.json").read_text())
credit_cards = json.loads((DATA / "credit_cards.json").read_text())

ALL_PRODUCT_LISTS = [checking, savings, credit_cards]


def products_for(bank_id):
    return [p for lst in ALL_PRODUCT_LISTS for p in lst if p.get("bank_id") == bank_id]


mismatches = []

for bank in banks:
    bid = bank["bank_id"]
    products = products_for(bid)

    new_values = {
        # Checking/savings signal "no SSN needed" via accepts_no_ssn=true;
        # credit cards use requires_ssn=false instead (see banks/_template.html
        # front-face badge logic, which checks both) — must match both here
        # or bank_id.has_product_without_ssn silently under-counts any bank
        # whose only no-SSN-friendly product is a credit card.
        "has_product_without_ssn": any(p.get("accepts_no_ssn") or p.get("requires_ssn") is False for p in products),
        "has_product_with_itin": any(p.get("accepts_itin") for p in products),
        "has_product_no_us_credit_history_required": any(p.get("accepts_no_us_credit_history") for p in products),
        "num_checking_products": sum(1 for p in checking if p.get("bank_id") == bid),
        "num_savings_products": sum(1 for p in savings if p.get("bank_id") == bid),
        "num_credit_card_products": sum(1 for p in credit_cards if p.get("bank_id") == bid),
    }

    for key, new_val in new_values.items():
        old_val = bank.get(key)
        if old_val != new_val:
            mismatches.append((bid, key, old_val, new_val))
        bank[key] = new_val

# Insert the new num_*_products keys right after the existing has_product_*
# rollups (if this is the first run adding them) instead of leaving them
# appended at the end, so banks.json stays readable.
ordered_keys = [
    "bank_id", "name", "type", "headquarters", "founded", "official_url",
    "total_assets_billion_usd", "num_branches_total", "num_atms_total",
    "coverage", "num_states_present", "online_banking", "mobile_app",
    "mobile_app_rating_ios", "mobile_app_rating_android", "mobile_app_rating_last_updated",
    "live_chat", "phone_support_24_7", "spanish_language_support", "can_open_account_online",
    "has_product_without_ssn", "has_product_with_itin", "has_product_no_us_credit_history_required",
    "num_checking_products", "num_savings_products", "num_credit_card_products",
    "logo_path", "logo_source", "logo_last_verified", "state_coverage_completeness",
]

reordered = []
for bank in banks:
    new_bank = {}
    for key in ordered_keys:
        if key in bank:
            new_bank[key] = bank[key]
    # Preserve any field not in the canonical order list (forward-compatible
    # with fields added by a later phase, e.g. loyalty_program).
    for key, val in bank.items():
        if key not in new_bank:
            new_bank[key] = val
    reordered.append(new_bank)

(DATA / "banks.json").write_text(json.dumps(reordered, indent=2) + "\n")

print(f"Recomputed rollups for {len(banks)} institutions.")
if mismatches:
    print(f"\n{len(mismatches)} field(s) changed:")
    for bid, key, old, new in mismatches:
        print(f"  {bid}.{key}: {old!r} -> {new!r}")
else:
    print("No changes — all rollups already matched the product records.")
