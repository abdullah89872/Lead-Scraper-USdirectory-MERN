# Architecture

See the top-level [README](../README.md) for the full architecture diagram.
This page records the decisions and their reasoning.

## Why the scraper is a separate service

The Python scraper shares **no code** with the Node backend. The only coupling
is one HTTP contract (`POST /scrape`). Benefits:

- Politeness logic (robots.txt, rate limiting, cooldowns) lives in one place and
  cannot be accidentally bypassed by a code path in another language.
- The browser never talks to the scraper directly, so scraping internals are
  not exposed to clients.
- Either side can be replaced without touching the other.

## Mock mode design

`SCRAPER_MODE=mock` swaps the **transport**, not the logic.

```text
                  live                        mock
             ┌──────────────┐          ┌──────────────┐
  fetch  →   │ HttpxFetcher │          │ StaticFetcher│  ← only difference
             │   (network)  │          │ (in-memory)  │
             └──────────────┘          └──────────────┘
                     ↓                          ↓
             discover → extract → normalize → dedupe → enrich → AI → persist
                              (identical code path)
```

`StaticFetcher` is populated with rendered HTML for every URL the production
code would request, so discovery, pagination, JSON-LD parsing, contact
extraction, deduplication and enrichment all run unmodified.

Mock data is unmistakable and safe:

| Field | Value | Why |
| --- | --- | --- |
| Phone | `(503) 555-0101` | NANP reserves `555-0100`–`555-0199` for fiction |
| Email | `info@acme.example.com` | `example.com` is reserved by RFC 2606 |
| Website | `https://www.acme.example.com` | `.example` is reserved and never resolves |
| `demoData` | `true` | Surfaced in the UI and in every export |

## Politeness safeguards

| Guard | Implementation |
| --- | --- |
| robots.txt | `services/robots.py`, cached per host, checked before every fetch |
| Rate limit | `services/rate_limiter.py`, minimum delay + concurrency semaphore |
| Back-off | `RateLimiter` raises `SourceBlockedError` and cools down |
| Blocking | `401/403/429` or a CAPTCHA marker sets `blocked` and ends the run |
| Retries | Bounded, with exponential back-off, never on a block |
| Identification | `SCRAPER_USER_AGENT` names the tool and a contact URL |
| Scope | Enrichment visits at most 5 public paths on the business's own site |

A block is **terminal** for the run. The pipeline returns zero leads and an
explicit warning rather than attempting any workaround.

## Data provenance

Every lead carries `sourceUrl` and `sourceId`. This is enforced at
normalization time: `normalizeLead()` (Node) and `Lead` validation (Python)
both reject a record that has no business name **or** no source URL. You can
therefore always answer "where did this come from?".

## Deduplication strategy

```text
EXACT  → merge (union contacts, fill gaps, keep the earliest record)
FUZZY  → flag only (possibleDuplicate + duplicateReason), never merge
```

The fuzzy threshold (0.82) is identical in both implementations so the same
pair is labelled the same way regardless of which side ran the dedupe. The
threshold only controls *flagging* - it can never merge two records.

## AI boundary

```text
allowed:  category, services, tags, short description
forbidden: email, phone, address, website, city, state, zip
```

AI output is written to dedicated `ai*` fields so it can always be told apart
from source data. There is no code path from an AI response to a contact field.
If the AI call fails, the job still completes.