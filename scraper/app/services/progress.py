"""Progress reporting back to the Node API.

The scraper stays independent: it only POSTs small JSON progress events to a
URL the API provided with the job. Failures are swallowed - progress reporting
must never break a scrape.
"""

from __future__ import annotations

import logging
import time

import httpx

logger = logging.getLogger(__name__)


class ProgressReporter:
    def __init__(
        self,
        url: str | None,
        token: str | None = None,
        job_id: str | None = None,
        *,
        timeout_s: float = 5.0,
    ) -> None:
        self.url = url
        self.token = token
        self.job_id = job_id
        self.timeout_s = timeout_s
        self._last_emit = 0.0
        self._client: httpx.AsyncClient | None = None

    @property
    def enabled(self) -> bool:
        return bool(self.url)

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(self.timeout_s))
        return self._client

    async def emit(
        self,
        stage: str,
        percent: int,
        message: str | None = None,
        leads_found: int | None = None,
        *,
        status: str | None = None,
        force: bool = False,
    ) -> None:
        if not self.enabled:
            return
        now = time.monotonic()
        # throttle: at most one event every 400ms unless forced
        if not force and now - self._last_emit < 0.4:
            return
        self._last_emit = now
        payload = {
            "jobId": self.job_id,
            "status": status,
            "stage": stage,
            "percent": max(0, min(100, int(percent))),
            "message": message,
            "leadsFound": leads_found,
        }
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["X-Internal-Token"] = self.token
        try:
            await self._http().post(self.url, json=payload, headers=headers)
        except Exception as exc:  # noqa: BLE001 - never break a scrape over progress
            logger.debug("progress emit failed: %s", exc)

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
