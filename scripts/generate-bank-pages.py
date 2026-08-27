#!/usr/bin/env python3
"""Regenerates banks/{bank_id}.html for every institution in data/banks.json
from banks/_template.html. All 15 pages are identical, literal copies — the
bank_id is inferred client-side from the filename (see js/bank-detail.js), so
there is nothing per-bank to inject into the HTML itself.

Run this after editing banks/_template.html, or after adding/removing an
institution in data/banks.json. No build step is needed to serve the site —
this only needs to run when the template or the institution list changes.
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "banks" / "_template.html"
BANKS_JSON = ROOT / "data" / "banks.json"

template_html = TEMPLATE.read_text()
banks = json.loads(BANKS_JSON.read_text())

for bank in banks:
    out_path = ROOT / "banks" / f"{bank['bank_id']}.html"
    out_path.write_text(template_html)
    print(f"wrote {out_path.relative_to(ROOT)}")

print(f"\n{len(banks)} bank detail pages generated from {TEMPLATE.relative_to(ROOT)}.")
