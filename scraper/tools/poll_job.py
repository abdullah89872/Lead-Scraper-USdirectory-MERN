"""Poll a job created by create_job.py and print its final state.

Usage:  python tools/poll_job.py
Reads:  job_request.json
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

API = os.environ.get("API_BASE", "http://127.0.0.1:4000")


def call(method: str, path: str, token: str):
    req = urllib.request.Request(f"{API}{path}", method=method)
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        return exc.code, None


def main() -> int:
    with open("job_request.json", encoding="utf-8") as handle:
        info = json.load(handle)
    job_id, token = info["jobId"], info["token"]

    terminal = {"completed", "failed", "cancelled"}
    started = time.monotonic()
    last = None
    for _ in range(400):
        status, snap = call("GET", f"/api/jobs/{job_id}", token)
        job = (snap or {}).get("job") or {}
        progress = job.get("progress") or {}
        line = (
            f"[{time.monotonic() - started:6.0f}s] http={status} "
            f"status={job.get('status')} stage={progress.get('stage')} "
            f"{progress.get('percent')}% found={progress.get('leadsFound')}"
        )
        if line != last:
            print(line, flush=True)
            last = line
        if job.get("status") in terminal:
            print("\n=== FINAL ===")
            print(json.dumps(
                {k: job.get(k) for k in
                 ("status", "leadsCount", "error", "warnings", "stats")},
                indent=2,
            ))
            return 0 if job.get("status") == "completed" else 1
        time.sleep(3)
    print("timed out waiting")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
