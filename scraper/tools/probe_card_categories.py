"""Inspect listing-page card markup for a per-card category label.

Usage:  python tools/probe_card_categories.py <listing-url> [count]
"""
from __future__ import annotations

import re
import sys

import httpx

UA = "LeadForgeAI/1.0 (+https://example.com/leadforge-bot; respectful crawler)"


def extract_cards(html: str, limit: int) -> list[str]:
    """Slice out balanced .city-business-row blocks."""
    marker = 'class="city-business-row'
    cards: list[str] = []
    idx = 0
    while len(cards) < limit:
        start = html.find(marker, idx)
        if start == -1:
            break
        # Walk forward counting <div ...> / </div> to find the block end.
        pos = html.rfind("<div", 0, start)
        depth, i = 0, pos
        while i < len(html):
            nxt_open = html.find("<div", i)
            nxt_close = html.find("</div>", i)
            if nxt_close == -1:
                break
            if nxt_open != -1 and nxt_open < nxt_close:
                depth += 1
                i = nxt_open + 4
                continue
            depth -= 1
            i = nxt_close + 6
            if depth == 0:
                break
        cards.append(html[pos:i])
        idx = i
    return cards


def strip_tags(fragment: str) -> str:
    text = re.sub(r"<[^>]+>", " ", fragment)
    return re.sub(r"\s+", " ", text).strip()


def main(argv: list[str]) -> int:
    url = argv[0]
    count = int(argv[1]) if len(argv) > 1 else 3

    with httpx.Client(
        headers={"User-Agent": UA}, timeout=30, follow_redirects=True
    ) as client:
        html = client.get(url).text

    print(f"url={url} bytes={len(html)}\n")

    cards = extract_cards(html, count)
    print(f"extracted {len(cards)} card(s)\n")

    for n, card in enumerate(cards, 1):
        print(f"=== CARD {n} visible text ===")
        print(strip_tags(card)[:600])
        print(f"--- href/title/alt ---")
        for attr in re.findall(r'(?:href|title|alt)="([^"]*)"', card):
            print(f"   {attr}")
        print()

    print("=== per-card class names ===")
    seen: set[str] = set()
    for card in cards:
        for cls in re.findall(r'class="([^"]+)"', card):
            seen.add(cls)
    for cls in sorted(seen):
        print(f"   {cls}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

