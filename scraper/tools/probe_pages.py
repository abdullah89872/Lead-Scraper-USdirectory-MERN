"""Read-only diagnostic: walk the real listing pages through the real source.

Usage:
    probe_pages.py <listing-url> [max-pages]

Uses the production USDirectorySource.parse_search_page so what this prints is
exactly what the service would collect. Nothing is bypassed.
"""
from __future__ import annotations

import os
import re
import sys
import time

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.sources.usdirectory import USDirectorySource  # noqa: E402

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def emit(line: str) -> None:
    """Print immediately and unbuffered so slow probes stay observable."""
    print(line, flush=True)


def debug_no_refs(html: str, url: str) -> None:
    """Explain why a 200 listing page produced zero profile references."""
    from app.extractors.html import make_soup

    soup = make_soup(html)
    source = USDirectorySource()
    hrefs = [str(a["href"]) for a in soup.find_all("a", href=True)]
    single = sorted({
        h for h in hrefs
        if re.match(r"^/[^/?#]+$", h) and not h.lower().startswith(
            ("/about", "/contact", "/faq", "/login", "/how", "/find",
             "/for-", "/get-", "/content", "/articles", "/frontdesk")
        )
    })
    print("   DEBUG raw single-segment hrefs:", len(single))
    for candidate in single[:12]:
        absolute = "https://usdirectory.com" + candidate
        print(f"      {candidate!r:60} profile={source.is_profile_url(absolute)}")
        print(f"         segments={candidate.strip('/').split('/')}")


def check_status(urls: list[str]) -> None:
    """Report HTTP status + listing count for candidate category URLs."""
    from app.extractors.html import json_ld_blocks, make_soup

    with httpx.Client(
        headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"},
        timeout=30,
        follow_redirects=True,
    ) as client:
        for url in urls:
            try:
                response = client.get(url)
            except Exception as exc:  # noqa: BLE001
                print(f"{response.status_code if False else 'ERR':>5} {url} ({exc})")
                continue
            count = 0
            if response.status_code == 200:
                soup = make_soup(response.text)
                count = len(soup.select(".listing-card")) or len(
                    {str(a["href"]) for a in soup.find_all("a", href=True)
                     if USDirectorySource().is_profile_url("https://usdirectory.com" + str(a["href"]))}
                )
            print(f"{response.status_code:>5} {url}  bytes={len(response.text):>7} profiles={count}")


def check_restriction() -> None:
    """Show what a suspiciously small HTTP 200 listing page actually contains."""
    from app.services.restrictions import classify_restriction

    url = "https://usdirectory.com/Florida/Miami/Home-Services"
    with httpx.Client(
        headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"},
        timeout=30, follow_redirects=True,
    ) as client:
        response = client.get(url)
    emit(f"status={response.status_code} bytes={len(response.text)} final={response.url}")
    emit(f"classify={classify_restriction(response.text)!r}")
    emit("---- body ----")
    emit(response.text[:2500])


def main(argv: list[str]) -> int:
    source = USDirectorySource()
    print("=== search_urls() output for the requested query ===")
    for category, location in [
        ("Roofing", "Hillsboro, Oregon"),
        ("Plumbing", "Atlanta, GA, USA"),
    ]:
        try:
            print(f"  {category!r} / {location!r}")
            print(f"     city_categories={source.city_categories}")
            for url in source.search_urls(category, location):
                print("     ->", url)
        except Exception as exc:  # noqa: BLE001
            print("     ERROR:", exc)

    if argv and argv[0] == "--restrict":
        check_restriction()
        return 0

    if argv and argv[0] == "--aspx":
        from app.extractors.html import make_soup

        seed = "https://usdirectory.com/Florida/Miami/Home-Services"
        with httpx.Client(
            headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"},
            timeout=30, follow_redirects=True,
        ) as client:
            # 1) Does a legacy .aspx profile URL actually resolve?
            legacy = "/b/352529/Professional-cleaning-Miami-Florida.aspx"
            response = client.get("https://usdirectory.com" + legacy)
            soup = make_soup(response.text)
            emit(f"legacy {legacy}")
            emit(f"   status={response.status_code} final={response.url}")
            emit(f"   h1={soup.find('h1').get_text(' ', strip=True) if soup.find('h1') else None!r}")
            emit(f"   canonical={soup.find('link', rel='canonical').get('href') if soup.find('link', rel='canonical') else None}")

            # 2) How many pages does the pager advertise?
            response = client.get(seed)
            soup = make_soup(response.text)
            pager = soup.select_one(".pagination")
            emit("\npager hrefs:")
            if pager:
                for a in pager.find_all("a", href=True):
                    emit(f"   {a.get_text(' ', strip=True)!r:>6} {a['href']}")

            # 3) Walk to the end and record URL shape per page.
            for page_no in range(1, 10):
                url = seed if page_no == 1 else f"{seed}?page={page_no}"
                page = client.get(url)
                psoup = make_soup(page.text)
                hrefs = [str(a["href"]) for a in psoup.select(".city-business-row a[href]")]
                aspx = [h for h in hrefs if ".aspx" in h]
                pretty = [h for h in hrefs if ".aspx" not in h and h.startswith("/")]
                pager_now = psoup.select_one(".pagination")
                max_page = 0
                if pager_now:
                    for a in pager_now.find_all("a", href=True):
                        import re as _re
                        m = _re.search(r"page=(\d+)", str(a["href"]))
                        if m:
                            max_page = max(max_page, int(m.group(1)))
                emit(
                    f"page {page_no}: status={page.status_code} cards={len(psoup.select('.city-business-row'))} "
                    f"pretty={len(pretty)} aspx={len(aspx)} max_page_in_pager={max_page}"
                )
                if len(hrefs) == 0:
                    break
                time.sleep(1.0)
        return 0

    if argv and argv[0] == "--slugs":
        from app.extractors.html import make_soup
        from app.sources.usdirectory import profile_state_token

        source = USDirectorySource()
        seed = "https://usdirectory.com/Florida/Miami/Home-Services"
        with httpx.Client(
            headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"},
            timeout=30, follow_redirects=True,
        ) as client:
            for page_no in (1, 3):
                url = seed if page_no == 1 else f"{seed}?page={page_no}"
                response = client.get(url)
                soup = make_soup(response.text)
                emit(f"\n--- page {page_no} ---")
                cards = soup.select(".city-business-row")
                emit(f"  cards={len(cards)}")
                rejected: list[str] = []
                accepted = 0
                for card in cards:
                    anchors = [
                        str(a["href"]) for a in card.find_all("a", href=True)
                        if str(a["href"]).startswith("/")
                    ]
                    if not anchors:
                        rejected.append("<no anchor>")
                        continue
                    slug = anchors[0].strip("/")
                    token = profile_state_token(slug)
                    if token:
                        accepted += 1
                    else:
                        rejected.append(slug)
                emit(f"  accepted={accepted} rejected={len(rejected)}")
                emit("  REJECTED SAMPLES:")
                for slug in rejected[:15]:
                    emit(f"    - {slug}")
                time.sleep(1.0)
        return 0

    if argv and argv[0] == "--jsonld":
        from app.extractors.html import json_ld_blocks, make_soup

        seed = "https://usdirectory.com/Florida/Miami/Home-Services"
        with httpx.Client(
            headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"},
            timeout=30, follow_redirects=True,
        ) as client:
            for page_no in (1, 2, 3):
                url = seed if page_no == 1 else f"{seed}?page={page_no}"
                response = client.get(url)
                soup = make_soup(response.text)
                blocks = json_ld_blocks(soup)
                emit(f"\n--- page {page_no} status={response.status_code} ---")
                for node in blocks:
                    types = node.get("@type")
                    emit(f"  @type={types} keys={sorted(node)[:8]}")
                    if types == "ItemList":
                        emit(f"    numberOfItems={node.get('numberOfItems')}")
                        items = node.get("itemListElement") or []
                        emit(f"    itemListElement={len(items)}")
                        for item in items[:3]:
                            inner = item.get("item", {})
                            emit(f"      pos={item.get('position')} "
                                 f"name={inner.get('name')!r} "
                                 f"tel={inner.get('telephone')!r}")
                emit("  h3 title links: " + str(len(soup.select("h3 a"))))
                emit("  city-business-row: " + str(len(soup.select(".city-business-row"))))
                time.sleep(1.0)
        return 0

    if argv and argv[0] == "--deep":
        seed = "https://usdirectory.com/Florida/Miami/Home-Services"
        source = USDirectorySource()
        seen: set[str] = set()
        names: dict[str, str] = {}
        with httpx.Client(
            headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"},
            timeout=30, follow_redirects=True,
        ) as client:
            for page_no in range(1, 9):
                url = f"{seed}?page={page_no}"
                response = client.get(url)
                parsed = source.parse_search_page(response.text, url)
                fresh = [r for r in parsed.refs if r.url not in seen]
                seen.update(r.url for r in fresh)
                named = sum(1 for r in fresh if r.business_name)
                emit(
                    f"page {page_no}: status={response.status_code} "
                    f"refs={len(parsed.refs):>3} new={len(fresh):>3} "
                    f"with_name={named:>3} total={len(seen):>3}"
                )
                if page_no == 1:
                    emit("   sample: " + str([
                        (r.business_name, r.url.rsplit("/", 1)[-1])
                        for r in parsed.refs[:4]
                    ]))
                time.sleep(1.0)
        return 0

    if argv and argv[0] == "--search":
        base = "https://usdirectory.com/"
        common = "searchLocation=Miami%2c+FL&search%5BsortBy%5D=search%2Fsort%2Forder%3Aasc%2Clocation(25.7617%2C-80.1918)%3Aasc"
        check_status([
            f"{base}?search%5Bquery%5D=Roofing&{common}",
            f"{base}?search%5Bquery%5D=roofing&searchLocation=Miami%2c+FL",
            f"{base}?search%5Bcategory%5D=Roofing+Services&{common}",
            f"{base}?search%5Bcategories%5D=Roofing+Services&{common}",
            f"{base}?search%5BcategoryIds%5D=Roofing+Services&{common}",
        ])
        return 0

    if argv and argv[0] == "--status":
        check_status([
            "https://usdirectory.com/Florida/Miami/Roofing-Services",
            "https://usdirectory.com/Florida/Miami/Contractors",
            "https://usdirectory.com/Florida/Miami/Home-Services",
            "https://usdirectory.com/Florida/Miami/Remodeling-and-Repair",
            "https://usdirectory.com/Oregon/Hillsboro/Contractors",
            "https://usdirectory.com/Oregon/Hillsboro/Home-Services",
            "https://usdirectory.com/Oregon/Hillsboro/Roofing-Services",
            "https://usdirectory.com/Oregon/Hillsboro/Roofing",
        ])
        return 0

    if not argv:
        return 0

    seed = argv[0]
    limit = int(argv[1]) if len(argv) > 1 else 5

    url: str | None = seed
    seen: set[str] = set()
    page_no = 0

    with httpx.Client(
        headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"},
        timeout=30,
        follow_redirects=True,
    ) as client:
        while url and page_no < limit:
            page_no += 1
            response = client.get(url)
            print(f"\n===== page {page_no} =====")
            print("url    :", url)
            print("status :", response.status_code, "bytes:", len(response.text))

            page = source.parse_search_page(response.text, url)
            fresh = [ref for ref in page.refs if ref.url not in seen]
            seen.update(item.url for item in fresh)

            print("refs on page :", len(page.refs))
            print("new this page:", len(fresh))
            print("total unique :", len(seen))
            for item in fresh[:5]:
                print("   +", item.business_name, "->", item.url)
            if not fresh:
                print("   (no NEW listings; pagination would stop here)")
            if not page.refs:
                debug_no_refs(response.text, url)

            url = page.next_url
            print("next  :", url)
            if url:
                time.sleep(1.5)

    print(f"\nTOTAL unique profiles across {page_no} page(s): {len(seen)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))