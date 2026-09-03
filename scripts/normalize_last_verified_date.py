#!/usr/bin/env python3
"""Normalizes every `last_verified_date` field across the dataset to the
confirmed date the dataset research/corrections were actually done:
2026-08-29 (YYYY-MM-DD). Product records previously stored this as "YYYY-MM"
(month only); this also standardizes those to full YYYY-MM-DD.

Touches: last_verified_date on every record in checking_accounts.json,
savings_accounts.json, credit_cards.json, and on every entry inside
banks.json's relationship_programs[] and referral_program (which is a single
object for most banks, an array for Chase specifically — handled either way).

Does NOT touch banks.json's logo_last_verified or
mobile_app_rating_last_updated — those are separate, differently-named
fields, out of scope for this normalization.

Safe to re-run any time; it only ever sets last_verified_date to the target
value, leaving every other field untouched.
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
TARGET_DATE = "2026-08-29"

PRODUCT_FILES = ["checking_accounts.json", "savings_accounts.json", "credit_cards.json"]

changed = 0
unchanged = 0

for filename in PRODUCT_FILES:
    path = DATA / filename
    records = json.loads(path.read_text())
    file_changed = 0
    for record in records:
        old = record.get("last_verified_date")
        if old != TARGET_DATE:
            record["last_verified_date"] = TARGET_DATE
            file_changed += 1
            changed += 1
        else:
            unchanged += 1
    path.write_text(json.dumps(records, indent=2) + "\n")
    print(f"{filename}: {file_changed} changed, {len(records) - file_changed} already correct")

banks_path = DATA / "banks.json"
banks = json.loads(banks_path.read_text())
banks_changed = 0

for bank in banks:
    for rp in bank.get("relationship_programs") or []:
        old = rp.get("last_verified_date")
        if old != TARGET_DATE:
            rp["last_verified_date"] = TARGET_DATE
            banks_changed += 1
            changed += 1
        else:
            unchanged += 1

    referral = bank.get("referral_program")
    referral_entries = referral if isinstance(referral, list) else ([referral] if referral else [])
    for entry in referral_entries:
        old = entry.get("last_verified_date")
        if old != TARGET_DATE:
            entry["last_verified_date"] = TARGET_DATE
            banks_changed += 1
            changed += 1
        else:
            unchanged += 1

banks_path.write_text(json.dumps(banks, indent=2) + "\n")
print(f"banks.json (relationship_programs/referral_program entries): {banks_changed} changed")

print(f"\nTotal: {changed} field(s) set to {TARGET_DATE}, {unchanged} already correct.")
