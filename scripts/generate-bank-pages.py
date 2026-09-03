#!/usr/bin/env python3
"""Regenerates banks/{bank_id}.html for every institution in data/banks.json
from banks/_template.html. The pages are near-identical copies — the bank_id
is inferred client-side from the filename (see js/bank-detail.js), so there
is nothing per-bank to inject for the visible body content. The one
exception is the <head>'s title/description/OG/Twitter meta tags: those must
be correct in the raw static HTML (search engines and social-share crawlers
generally don't execute JavaScript), so {{BANK_NAME}}/{{BANK_ID}} placeholder
tokens in _template.html get substituted per bank below.

Run this after editing banks/_template.html, or after adding/removing an
institution in data/banks.json. No build step is needed to serve the site —
this only needs to run when the template or the institution list changes.
"""
import html
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "banks" / "_template.html"
BANKS_JSON = ROOT / "data" / "banks.json"

template_html = TEMPLATE.read_text()
banks = json.loads(BANKS_JSON.read_text())

for bank in banks:
    out_path = ROOT / "banks" / f"{bank['bank_id']}.html"
    # HTML-escape the name (e.g. "M&T Bank" -> "M&amp;T Bank") since it's
    # substituted into <title> text and meta content="..." attributes.
    safe_name = html.escape(bank["name"])
    page_html = template_html.replace("{{BANK_NAME}}", safe_name).replace("{{BANK_ID}}", bank["bank_id"])
    out_path.write_text(page_html)
    print(f"wrote {out_path.relative_to(ROOT)}")

print(f"\n{len(banks)} bank detail pages generated from {TEMPLATE.relative_to(ROOT)}.")
