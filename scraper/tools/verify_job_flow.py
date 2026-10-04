"""Drive one live scrape through the real backend job flow and verify storage.

Registers a throwaway user, creates a job, waits for it to finish and then reads
the leads back out of the API - proving the full pipeline persists records.

Usage:  python tools/verify_job_flow.py
Requires: backend on :4000, scraper on :8000 (both in SCRAPER_MODE=live).
"""
import json
import os
import time
import urllib.error
import urllib.request
import uuid

API = os.environ.get("API_BASE", "http://127.0.0.1:4000")
TIMEOUT = 30


def call(method: str, path: str, body=None, token: str | None = None):
    """Small JSON HTTP helper (no third-party deps)."""
    url = f"{API}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode()
        try:
            return exc.code, json.loads(body)
        except ValueError:
            return exc.code, body


def _pick_id(payload) -> str | None:
    """Dig the id out of the API's envelope ({job:{id}} / {data:{id}} / {id})."""
    if not isinstance(payload, dict):
        return None
    for key in ("job", "data", "lead", "result"):
        inner = payload.get(key)
        if isinstance(inner, dict) and inner.get("id"):
            return inner["id"]
    return payload.get("id")


def main() -> int:
    max_leads = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    category = sys.argv[2] if len(sys.argv) > 2 else "Roofing"
    location = sys.argv[3] if len(sys.argv) > 3 else "Hillsboro, Oregon"
    print(f"requesting {max_leads} leads: {category} / {location}\n")

    email = f"probe-{uuid.uuid4().hex[:10]}@example.com"
    password = "Probe!Passw0rd"

    status, reg = call(
        "POST",
        "/api/auth/register",
        {"email": email, "password": password, "name": "Probe User"},
    )
    print(f"register -> {status}")
    if status not in (200, 201):
        print(json.dumps(reg, indent=2))
        return 1

    token = (reg or {}).get("token") or ((reg or {}).get("data") or {}).get("token")
    if not token:
        print("no token in register response:")
        print(json.dumps(reg, indent=2))
        return 1
    print(f"token acquired for {email}")

    status, job = call(
        "POST",
        "/api/jobs",
        {
            "category": category,
            "location": location,
            "maxLeads": max_leads,
            "source": "usdirectory",
            "enrichment": False,
        },
        token,
    )
    print(f"create job -> {status}")
    print(json.dumps(job, indent=2)[:1200])
    if status not in (200, 201):
        return 1

    job_id = _pick_id(job)
    if not job_id:
        print("no job id returned")
        return 1

    # Poll until the job reaches a terminal state. The budget scales with the
    # request size because a live crawl is rate limited to ~3s per lead.
    terminal = {"completed", "failed", "cancelled"}
    polls = max(60, (max_leads * 4) // 3)
    final = None
    started = time.monotonic()
    for _ in range(polls):
        time.sleep(3)
        status, snap = call("GET", f"/api/jobs/{job_id}", None, token)
        state = ((snap or {}).get("job") or snap or {}).get("status")
        pct = (((snap or {}).get("job") or snap or {}).get("progress") or {}).get("percent")
        print(
            f"  poll -> {status} status={state} {pct}% "
            f"({time.monotonic() - started:.0f}s)"
        )
        if state in terminal:
            final = snap
            break
    if final is None:
        print("job did not finish within the poll window")
        return 1

    final_job = (final or {}).get("job") or final
    print("\n=== FINAL JOB ===")
    print(json.dumps(final_job, indent=2)[:1500])

    status, leads = call("GET", f"/api/leads?job={job_id}&limit=50", None, token)
    items = (leads or {}).get("leads") or (leads or {}).get("items") or []
    if isinstance(leads, list):
        items = leads
    print(f"\n=== STORED LEADS ({len(items)}) -> HTTP {status} ===")
    for lead in items:
        print(
            f"- {lead.get('businessName')}  {lead.get('phone') or '-'}  "
            f"{lead.get('city')}, {lead.get('state')}  {lead.get('sourceUrl')}"
        )

    # Also confirm they show up in the global list and the dashboard counters.
    status, all_leads = call("GET", "/api/leads?limit=5", None, token)
    print(f"\nGET /api/leads -> HTTP {status}, "
          f"total={(all_leads or {}).get('total')}")

    status, stats = call("GET", "/api/dashboard/stats", None, token)
    print(f"GET /api/dashboard/stats -> HTTP {status} "
          f"totalLeads={(stats or {}).get('totalLeads')}")
    return 0 if items else 1


if __name__ == "__main__":
    raise SystemExit(main())
