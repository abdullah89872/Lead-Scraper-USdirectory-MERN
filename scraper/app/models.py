"""Pydantic models shared by the scraper API.

Field names are camelCase on the wire so the Node API can forward them to
MongoDB without a translation layer. Every field that could not be observed in
publicly available data stays ``None`` - the scraper never invents values.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

EmailStatus = Literal["valid", "invalid", "unknown"]
EnrichmentStatus = Literal["not_attempted", "completed", "no_website", "failed", "skipped"]
JobStatus = Literal["queued", "running", "completed", "failed", "cancelled"]


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Lead(BaseModel):
    businessName: str
    category: str | None = None
    description: str | None = None
    address: str | None = None
    city: str | None = None
    state: str | None = None
    zip: str | None = None
    phone: str | None = None
    email: str | None = None
    website: str | None = None
    source: str = "usdirectory"
    sourceUrl: str
    sourceId: str | None = None
    contactPageUrl: str | None = None
    publicEmails: list[str] = Field(default_factory=list)
    publicPhones: list[str] = Field(default_factory=list)
    services: list[str] = Field(default_factory=list)
    emailStatus: EmailStatus = "unknown"
    enrichmentStatus: EnrichmentStatus = "not_attempted"
    scrapedAt: datetime = Field(default_factory=utcnow)

    # Provenance flags (never used to fake data, only to label it)
    demoData: bool = False
    possibleDuplicate: bool = False
    duplicateReason: str | None = None
    enrichmentSources: list[str] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)

    @field_validator("businessName")
    @classmethod
    def _name_not_blank(cls, value: str) -> str:
        value = (value or "").strip()
        if not value:
            raise ValueError("businessName must not be blank")
        return value


class ScrapeRequest(BaseModel):
    category: str = Field(min_length=2, max_length=120)
    location: str = Field(min_length=2, max_length=160)
    max_leads: int = Field(default=100, ge=1, le=1000)
    source: str = "usdirectory"
    enrichment: bool = True
    # AI processing is executed by the Node backend; accepted here for API parity.
    ai: bool = False
    job_id: str | None = None
    progress_url: str | None = None
    progress_token: str | None = None

    @field_validator("category", "location", "source")
    @classmethod
    def _strip(cls, value: str) -> str:
        return (value or "").strip()


class ScrapeStats(BaseModel):
    pagesFetched: int = 0
    profilesFetched: int = 0
    profilesParsed: int = 0
    duplicatesRemoved: int = 0
    possibleDuplicates: int = 0
    enriched: int = 0
    enrichmentFailed: int = 0
    blocked: bool = False
    blockReason: str | None = None
    errors: list[str] = Field(default_factory=list)
    durationMs: int = 0


class ScrapeResponse(BaseModel):
    source: str
    mode: str
    category: str
    location: str
    requested: int
    returned: int
    leads: list[Lead] = Field(default_factory=list)
    stats: ScrapeStats = Field(default_factory=ScrapeStats)
    warnings: list[str] = Field(default_factory=list)


class EnrichRequest(BaseModel):
    lead: Lead
    max_pages: int | None = None


class EnrichResponse(BaseModel):
    lead: Lead
    status: EnrichmentStatus
    pagesVisited: list[str] = Field(default_factory=list)
    message: str | None = None


class ProgressEvent(BaseModel):
    jobId: str | None = None
    status: JobStatus | None = None
    stage: str
    percent: int = Field(ge=0, le=100)
    message: str | None = None
    leadsFound: int | None = None
    meta: dict[str, Any] | None = None
