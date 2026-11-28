#!/usr/bin/env python3
"""Truthful postcard wording (2026-11-28).

The plan cards and FAQ said postcards are "included" every month, but every mailed postcard is
charged $1.50 (wallet, or Shopify usage for Shopify-billed stores). Included postcards are built
(migration 20261128040000) but not switched on until the Shopify review is done. Until then the
site says what actually happens. Revert this wording when included postcards go live.

Usage: postcard_wording_patch.py <site dir>   (patches index.html and free-pos-audit.html in place)
Idempotent: a file that already has no "included" postcard claims is left alone.
"""
import sys, pathlib

EMAIL_LINE = "Email included · postcards $1.50 each"

REPLACEMENTS = {
    "index.html": [
        ('"Email + 10 mailed postcards/mo included"', f'"{EMAIL_LINE}"', 1),
        ('"Email + 10 postcards/mo included"', f'"{EMAIL_LINE}"', 1),
        ('"Email + postcards included"', f'"{EMAIL_LINE}"', 1),
        ('"1,500 texts/mo + 30 postcards/mo included"', '"1,500 texts/mo included"', 2),
        ('"5,000 texts/mo + 75 postcards/mo included"', '"5,000 texts/mo included"', 2),
        # FAQ (JSON-LD + visible details) and the pricing paragraph
        ("Email, promo codes, and mailed postcards are included on every plan; texting is included on Growth and Scale. Physical things come from a pay-per-send wallet you control: about $1.50 a postcard,",
         "Email and promo codes are included on every plan; texting is included on Growth and Scale. Physical things are paid per send: $1.50 a mailed postcard,", 2),
        ("Email, promo codes, and a monthly batch of mailed postcards are included on every plan; <strong>text messaging is included on Growth and Scale</strong>. Extra postcards and physical gifts come from a pay-per-send wallet you control,",
         "Email and promo codes are included on every plan; <strong>text messaging is included on Growth and Scale</strong>. Mailed postcards ($1.50 each) and physical gifts are paid per send,", 1),
    ],
    "free-pos-audit.html": [
        ('"Email + 10 mailed postcards/mo included"', f'"{EMAIL_LINE}"', 1),
        ('"1,500 texts/mo + 30 postcards/mo included"', '"1,500 texts/mo included"', 1),
        ('"5,000 texts/mo + 75 postcards/mo included"', '"5,000 texts/mo included"', 1),
    ],
}


def main(site: str) -> None:
    for name, reps in REPLACEMENTS.items():
        p = pathlib.Path(site) / name
        s = p.read_text(encoding="utf-8")
        if all(s.count(old) == 0 for old, _, _ in reps):
            print(f"{name}: already patched")
            continue
        for old, new, n in reps:
            got = s.count(old)
            if got != n:
                sys.exit(f"{name}: expected {n} of {old[:60]!r}, found {got} - nothing written")
            s = s.replace(old, new)
        p.write_text(s, encoding="utf-8")
        print(f"{name}: patched")


if __name__ == "__main__":
    main(sys.argv[1])
