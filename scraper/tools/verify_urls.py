"""Ad-hoc check: re-fetch profile URLs to prove the scraper points at real pages.

Usage:  python tools/verify_urls.py <url> [<url> ...]
        python tools/verify_urls.py --json live_result.json
"""
import json
import sys

import httpx

USER_AGENT = "Mozilla/5.0 (compatible; LeadForgeAI/1.0)"


def check(urls: list[str]) -> int:
    ok = 0
    with httpx.Client(
        headers={"User-Agent": USER_AGENT},
        timeout=25,
        follow_redirects=True,
    ) as client:
        for url in urls:
            try:
                response = client.get(url)
                good = response.status_code == 200
                ok += good
                print(f"{'OK' if good else '!!'} {response.status_code}  {url}")
            except Exception as exc:  # noqa: BLE001 - diagnostics only
                print(f"!! ERR {type(exc).__name__}: {exc}  {url}")
    return ok


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2

    if argv[0] == "--json":
        data = json.load(open(argv[1], encoding="utf-8"))
        leads = data.get("leads", [])
        print(f"{argv[1]}: returned={data.get('returned')} leads={len(leads)}")
        print(f"blocked={data.get('stats', {}).get('blocked')}\n")
        for lead in leads:
            print(f"- {lead.get('businessName')}  {lead.get('phone') or '-'}")
        print()
        ok = check([lead["sourceUrl"] for lead in leads if lead.get("sourceUrl")])
        print(f"\n{ok}/{len(leads)} sourceUrls returned HTTP 200")
        return 0 if ok == len(leads) else 1

    ok = check(argv)
    print(f"\n{ok}/{len(argv)} URLs returned HTTP 200")
    return 0 if ok == len(argv) else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
