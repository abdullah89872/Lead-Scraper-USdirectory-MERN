"""Create a live job through the backend and record its id + token to a file.

Separated from polling so the job can be created in one short shell call and
then watched with short calls (a 100-lead job runs for several minutes).

Usage:  python tools/create_job.py <maxLeads> [category] [location]
Writes: job_request.json
"""
import json
import os
import sys
import urllib.error
import urllib.request
import uuid

API = os.environ.get("API_BASE", "http://127.0.0.1:4000")


def call(method: str, path: str, body=None, token: str | None = None):
    req = urllib.request.Request(
        f"{API}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
    )
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode()
        try:
            return exc.code, json.loads(body)
        except ValueError:
            return exc.code, body


def main() -> int:
    max_leads = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    category = sys.argv[2] if len(sys.argv) > 2 else "Roofing"
    location = sys.argv[3] if len(sys.argv) > 3 else "Hillsboro, Oregon"

    email = f"probe-{uuid.uuid4().hex[:10]}@example.com"
    status, reg = call(
        "POST", "/api/auth/register",
        {"email": email, "password": "Probe!Passw0rd", "name": "Probe User"},
    )
    print(f"register -> {status}")
    if status not in (200, 201):
        print(json.dumps(reg, indent=2))
        return 1

    token = (reg or {}).get("token") or ((reg or {}).get("data") or {}).get("token")
    status, job = call(
        "POST", "/api/jobs",
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
    job_id = ((job or {}).get("job") or {}).get("id") or (job or {}).get("id")
    if not job_id:
        print(json.dumps(job, indent=2))
        return 1

    with open("job_request.json", "w", encoding="utf-8") as handle:
        json.dump({"jobId": job_id, "token": token, "maxLeads": max_leads}, handle)
    print(f"jobId={job_id}  maxLeads={max_leads}  -> job_request.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
