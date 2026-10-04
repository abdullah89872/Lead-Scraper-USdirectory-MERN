# LeadForge AI

An AI-assisted business lead scraper SaaS. Enter a **business category**, a
**location** and a **maximum lead count**, and LeadForge AI discovers publicly
available business listings from a directory source, extracts the contact
information those businesses actually publish, optionally enriches from their
own websites, deduplicates the results and exports them to CSV or XLSX.

```text
Category:  Roofing
Location:  Hillsboro, Oregon
Max Leads: 100
```

---

## Contents

- [What was built](#what-was-built)
- [Architecture](#architecture)
- [Responsible scraping](#responsible-scraping)
- [Installation](#installation)
- [Environment variables](#environment-variables)
- [Running the app](#running-the-app)
- [Mock mode](#mock-mode)
- [Running the tests](#running-the-tests)
- [API reference](#api-reference)
- [Adding another directory source](#adding-another-directory-source)
- [Known limitations](#known-limitations)

---

## What was built

| Layer | Stack | Location |
| --- | --- | --- |
| Dashboard | React 18 + Vite + Tailwind + Recharts | `frontend/` |
| API | Node.js + Express + Mongoose + JWT + BullMQ | `backend/` |
| Scraper | Python 3.11 + FastAPI + Playwright + httpx + BeautifulSoup | `scraper/` |

**Dashboard pages**

```text
Dashboard   Stat cards, leads-over-time chart, coverage bars, recent jobs
Scrape      Source, category, location, max leads, enrichment + AI toggles
Jobs        Status table with live SSE progress; detail page with cancel
Leads       Search / filter / paginate / select, detail pages with provenance
Lists       Named saved lead collections
Exports     CSV + XLSX download history
Settings    Runtime configuration (no secrets)
```

**Lead fields stored** - `businessName`, `category`, `description`, `address`,
`city`, `state`, `zip`, `phone`, `email`, `website`, `source`, `sourceUrl`,
`sourceId`, `contactPageUrl`, `publicEmails`, `publicPhones`, `services`,
`aiCategory`, `aiTags`, `aiDescription`, `emailStatus`, `enrichmentStatus`,
`scrapedAt`, `createdAt`, `updatedAt`.

Anything the source did not publish stays `null`. **No value is ever
fabricated, guessed or completed from a pattern.** Every lead keeps the
`sourceUrl` it came from.

---

## Architecture

```text
React Dashboard
      |
      v
Node / Express API  ---- JWT auth, validation, rate limits, SSE progress
      |
      v
BullMQ + Redis  ---- (falls back to an inline in-process queue if Redis is absent)
      |
      v
Python FastAPI Scraper
      |
      v
USdirectory.com
      |
      v
Extract -> Normalize -> Deduplicate -> Website Enrichment -> (optional AI)
      |
      v
MongoDB -> Dashboard / CSV / XLSX export
```

The Python scraper is a **separate service** and shares no code with the Node
backend. They communicate over a single HTTP call.

### Repository layout

```text
leadforge-ai/
├── frontend/               # React dashboard
│   └── src/
│       ├── components/      # Layout + shared UI primitives
│       ├── context/         # AuthContext
│       ├── hooks/           # useJobProgress (SSE)
│       ├── lib/             # axios client, formatters
│       └── pages/           # one file per route
├── backend/
│   └── src/
│       ├── config/          # env + structured logger
│       ├── controllers/     # request handlers
│       ├── db/              # Mongo connection
│       ├── middleware/      # auth, validation, rate limiters
│       ├── models/          # Mongoose schemas
│       ├── routes/          # Express routers
│       ├── scripts/         # seed
│       ├── services/        # queue, runner, dedupe, export, AI, scraper client
│       ├── app.js           # Express app factory
│       └── index.js         # server entrypoint
├── scraper/
│   └── app/
│       ├── enrichment/      # website contact extraction
│       ├── extractors/      # HTML + JSON-LD parsing
│       ├── services/        # http, robots, rate limit, dedupe, pipeline
│       ├── sources/         # DirectorySource interface + USDirectorySource
│       ├── validators/      # email + phone validation
│       ├── config.py
│       ├── main.py
│       └── models.py
├── docs/
├── docker-compose.yml
└── .env.example
```
---

## Responsible scraping

LeadForge AI is built to be a good citizen. It will **not** bypass a CAPTCHA,
authentication, paywall, robots.txt rule or any other access control.

- **robots.txt is honoured** before every request (`RESPECT_ROBOTS_TXT=true`).
- **Conservative rate limiting**: a minimum delay between requests
  (`SCRAPE_REQUEST_DELAY_MS=1200`) and low concurrency (`SCRAPE_CONCURRENCY=2`).
- **Identifying User-Agent** so site owners can see and contact the crawler.
- **A block is final.** A `401`, `403`, `429` or CAPTCHA page sets
  `stats.blocked`, the run returns zero leads with a clear warning, and the
  scraper enters a cooldown (`SCRAPE_BLOCK_COOLDOWN_S=60`). It never tries to
  work around the restriction.
- **Only public pages.** Website enrichment reads at most five public pages
  (`/`, `/contact`, `/contact-us`, `/about`, `/about-us`) and only records what
  the business itself displays.
- **Every lead keeps its `sourceUrl`**, so any record can be traced back to the
  page it came from.

> **Note on terms of service.** Directory sites often prohibit automated
> scraping. Default to `SCRAPER_MODE=mock`. Before running in `live` mode, read
> the target site's Terms of Service and confirm that automated collection of
> publicly listed business contact details is permitted, and honour any request
> to stop.

---

## Installation

### With Docker (easiest)

```bash
cd leadforge-ai
cp .env.example .env
cp backend/.env.example backend/.env
cp scraper/.env.example scraper/.env

# Generate real secrets before starting:
#   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# Put the output in JWT_SECRET and INTERNAL_API_TOKEN.
docker compose up --build
```

| Service | URL |
| --- | --- |
| Dashboard | http://localhost:8080 |
| API | http://localhost:4000 |
| Scraper | http://localhost:8000 |
| MongoDB | mongodb://localhost:27017 |
| Redis | redis://localhost:6379 |

Load demo data:

```bash
docker compose exec backend npm run seed
```

### Without Docker (Windows)

**Prerequisites:** Node.js 18+, Python 3.11+. MongoDB and Redis are optional
(see *Running without MongoDB / Redis* below).

```powershell
# 1. Scraper
cd leadforge-ai\scraper
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env

# 2. Backend
cd ..\backend
npm install
copy .env.example .env

# 3. Frontend
cd ..\frontend
npm install
```

Generate a secret and paste it into `JWT_SECRET` in `backend/.env`:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```
---

## Environment variables

### Backend (`backend/.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | API port |
| `CLIENT_ORIGIN` | `http://localhost:5173` | CORS origin(s), comma separated |
| `JWT_SECRET` | insecure dev value | **Change this.** Signing key |
| `JWT_EXPIRES_IN` | `7d` | Token lifetime |
| `BCRYPT_ROUNDS` | `10` | Password hashing cost |
| `DB_DRIVER` | `mongo` | `mongo` or `memory` |
| `MONGO_URI` | `mongodb://127.0.0.1:27017/leadforge` | Database connection |
| `ALLOW_MEMORY_DB` | `true` | Fall back to in-memory DB when Mongo is down |
| `QUEUE_DRIVER` | `auto` | `auto`, `redis` or `inline` |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection |
| `QUEUE_CONCURRENCY` | `2` | Jobs processed at once |
| `WORKER_ENABLED` | `true` | `false` = enqueue only |
| `SCRAPER_MODE` | `mock` | `mock` or `live` |
| `SCRAPER_URL` | `http://127.0.0.1:8000` | Python service URL |
| `SCRAPER_TIMEOUT_MS` | `900000` | Scrape request timeout (15 min — see note below) |
| `INTERNAL_API_TOKEN` | insecure dev value | **Change this.** Progress webhook secret |
| `SCRAPE_MAX_LEADS` | `100` | Default per-job cap |
| `ENRICHMENT_ENABLED` | `true` | Master switch for website enrichment |
| `AI_ENABLED` | `false` | Enable OpenAI processing |
| `OPENAI_API_KEY` | *(empty)* | Optional API key |
| `OPENAI_MODEL` | `gpt-4o-mini` | Model used for tagging |
| `AI_CACHE_TTL_DAYS` | `30` | AI result cache lifetime |
| `LOG_LEVEL` | `info` | Pino log level |

### Scraper (`scraper/.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `SCRAPER_MODE` | `mock` | `mock` or `live` |
| `SCRAPER_PORT` | `8000` | Service port |
| `SCRAPER_FETCHER` | `httpx` | `httpx` or `playwright` |
| `SCRAPER_USER_AGENT` | `LeadForgeAI/1.0 ...` | Identifying UA string |
| `RESPECT_ROBOTS_TXT` | `true` | Obey robots.txt |
| `SCRAPE_REQUEST_DELAY_MS` | `1200` | Minimum delay between requests |
| `SCRAPE_CONCURRENCY` | `2` | Parallel fetches |
| `SCRAPE_MAX_PAGES` | `20` | Pagination cap per search |
| `SCRAPE_REQUEST_TIMEOUT_MS` | `20000` | Per-request timeout |
| `SCRAPE_MAX_RETRIES` | `2` | Retries on transient failures |
| `SCRAPE_BLOCK_COOLDOWN_S` | `60` | Pause after a block |
| `ENRICHMENT_MAX_PAGES` | `5` | Pages checked per website |
| `ENRICHMENT_CONCURRENCY` | `2` | Parallel enrichment |

### Frontend

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_API_URL` | `/api` | API base URL (relative = same origin) |
| `VITE_PROXY_TARGET` | `http://127.0.0.1:4000` | Dev-server proxy target |

---

## Running the app

Open **three terminals**.

```powershell
# Terminal 1 - scraper
cd leadforge-ai\scraper
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload --port 8000
```

```powershell
# Terminal 2 - backend
cd leadforge-ai\backend
npm run dev
```

```powershell
# Terminal 3 - frontend
cd leadforge-ai\frontend
npm run dev
```

Open <http://localhost:5173>, register an account and start scraping.

### Running without MongoDB / Redis

The stack is designed to start on a clean machine:

- **No MongoDB?** Set `DB_DRIVER=memory`. The API spins up an ephemeral
  in-process MongoDB and logs a loud warning. Data is lost on exit.
- **No Redis?** Leave `QUEUE_DRIVER=auto`. The API logs
  `Redis unavailable - running jobs inline` and processes jobs in-process.
- **No Python?** Keep `SCRAPER_MODE=mock`. The Node mock scraper produces
  equivalent leads without the Python service.

### Optional: dedicated worker

```powershell
cd backend
$env:WORKER_ENABLED = "false"
npm start          # API only - enqueues
npm run worker     # separate process - consumes the queue
---

## Mock mode

`SCRAPER_MODE=mock` makes the entire product testable without touching
USdirectory. The scraper swaps only the *transport*: instead of real HTTP it
renders synthetic listing pages into an in-memory fetcher. Discovery, parsing,
normalization, deduplication, enrichment and AI all run through the **same
production code path**.

Every mock lead is unmistakably fake:

- phone numbers use the NANP-reserved `555-01xx` fiction range
- emails are `@example.com`
- websites are non-resolvable `*.example.com` hosts
- each record carries `demoData: true`, and the UI shows a "demo data" banner

### Demo data

```powershell
cd backend
npm run seed            # add demo data
npm run seed -- --reset # wipe leads/jobs/users first
```

Creates `demo@leadforge.test` / `Demo12345!` with three completed jobs
(Roofing in Hillsboro, Plumbing in Portland, Electrician in Beaverton).

---

## Running the tests

```powershell
# Scraper - 105 tests, fully offline
cd scraper
.\.venv\Scripts\python.exe -m pytest
```

```powershell
# Backend - auth, jobs, leads, dedupe, exports, validation
cd backend
npm test
```

> **First backend run downloads MongoDB.** The database-backed suites use
> `mongodb-memory-server`, which fetches a ~600 MB `mongod` binary on first use
> and caches it under `node_modules/.cache`. It needs a one-off download; every
> later run is offline. To skip the download entirely, point the tests at a
> running MongoDB instead by setting `MONGO_URI` in your shell:
>
> ```powershell
> $env:DB_DRIVER = "mongo"
> $env:MONGO_URI = "mongodb://127.0.0.1:27017/leadforge_test"
> npm test
> ```

### Test coverage

| Suite | Covers |
| --- | --- |
| `scraper/tests/test_emails.py` | Email extraction, deobfuscation, junk filtering |
| `scraper/tests/test_phones.py` | Phone normalization and rejection rules |
| `scraper/tests/test_extractors.py` | JSON-LD, addresses, services, pagination |
| `scraper/tests/test_usdirectory_source.py` | URL parsing, profile extraction |
| `scraper/tests/test_dedupe.py` | Keys, merging, uncertain-match flagging |
| `scraper/tests/test_enrichment.py` | Website enrichment, robots.txt, blocking |
| `scraper/tests/test_pipeline.py` | End-to-end mock scrape |
| `scraper/tests/test_api.py` | FastAPI endpoints |
| `backend/tests/auth.test.js` | Register, login, JWT, bcrypt, roles |
| `backend/tests/jobs.test.js` | Job validation, listing, cancellation |
| `backend/tests/jobRun.test.js` | Full mock pipeline through the API |
| `backend/tests/leads.test.js` | Search, filters, pagination, isolation |
| `backend/tests/exports.test.js` | CSV / XLSX export and filtering |
| `backend/tests/dashboard.test.js` | Stats, lists, settings |
| `backend/tests/normalize.test.js` | Email / phone / name normalization |
| `backend/tests/dedupeExport.test.js` | Deduplication and export rows |
---

## API reference

All routes except `/api/auth/*` and `/api/health` require
`Authorization: Bearer <token>`.

```text
POST   /api/auth/register
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/me
PATCH  /api/auth/me

POST   /api/jobs
GET    /api/jobs
GET    /api/jobs/:id
GET    /api/jobs/:id/progress      (Server-Sent Events)
POST   /api/jobs/:id/cancel
DELETE /api/jobs/:id
GET    /api/jobs/meta/statuses

GET    /api/leads
GET    /api/leads/:id
DELETE /api/leads/:id
POST   /api/leads/bulk-delete
GET    /api/leads/meta/filters

GET    /api/leads/export/csv
GET    /api/leads/export/xlsx

GET    /api/lists
POST   /api/lists
GET    /api/lists/:id
PATCH  /api/lists/:id
DELETE /api/lists/:id

GET    /api/exports
DELETE /api/exports/:id

GET    /api/dashboard/stats
GET    /api/settings
GET    /api/health

POST   /api/internal/jobs/:id/progress   (internal token, scraper only)
```

### Example

```powershell
# Register
curl.exe -X POST http://localhost:4000/api/auth/register `
  -H "Content-Type: application/json" `
  -d '{"name":"Ada","email":"ada@example.test","password":"Password123!"}'

# Start a scrape
curl.exe -X POST http://localhost:4000/api/jobs `
  -H "Content-Type: application/json" `
  -H "Authorization: Bearer <token>" `
  -d '{"category":"Roofing","location":"Hillsboro, Oregon","maxLeads":100}'

# Watch live progress
curl.exe -N http://localhost:4000/api/jobs/<jobId>/progress `
  -H "Authorization: Bearer <token>"
```

---

## Deduplication

Two leads are merged only on an **exact** match of any of these keys:

```text
source URL
source id
email
phone
business name + city + state
business name + address
```

Anything less than exact (a very similar name in the same city, sharing no
contact point) is **flagged** with `possibleDuplicate` and a `duplicateReason`,
and both records are kept. Uncertain matches are never merged automatically.

Merging fills gaps in the surviving record (a missing phone, email or website)
and unions the public contact lists, so nothing is lost.

---

## AI processing

AI is **entirely optional** and only produces classification:

```text
aiCategory      normalized category
aiServices      inferred service list
aiTags          short labels
aiDescription   one-line summary
```

Rules the implementation follows:

- AI output is stored in **separate fields** from source data and is never
  merged into `category`, `services` or `description`.
- AI **never produces contact information**. There is no code path that lets a
  model write to `email`, `phone`, `address` or `website`.
- If the API key is missing, the request fails, or the model returns something
  unusable, **scraping continues** and the AI fields stay empty.
- Results are cached (hashed on the lead's identifying fields) for
  `AI_CACHE_TTL_DAYS` days to avoid paying twice for the same business.

---

## Adding another directory source

`DirectorySource` (`scraper/app/sources/base.py`) is the extension point.
Implement its methods, then register it:

```python
# scraper/app/sources/mydirectory.py
from .base import DirectorySource, ProfileRef, SearchPage
from ..models import Lead


class MyDirectorySource(DirectorySource):
    name = "mydirectory"
    display_name = "MyDirectory.com"
    base_url = "https://example.com"

    def search_urls(self, category, location): ...
    def parse_search_page(self, html, url): ...
    def parse_profile(self, html, url, *, category=None, location=None): ...
    def is_profile_url(self, url): ...
    def extract_source_id(self, path): ...
```

```python
# scraper/app/sources/registry.py
REGISTRY = {
    "usdirectory": USDirectorySource,
    "mydirectory": MyDirectorySource,   # add here
}
```

Registering it makes `source=mydirectory` selectable in the Scrape form and
valid on `POST /api/jobs`. robots.txt handling, rate limiting, deduplication and
website enrichment are inherited for free.

---

## Known limitations

- **Scraping is inherently fragile.** Directory HTML changes without notice.
  The parsers are written defensively (JSON-LD first, then multiple markup
  fallbacks), but a redesign will require selector updates.
- **Live mode is unverified against the live site.** All testing was done in
  mock mode against fixtures, as the mock-first workflow requires. Run a small
  `live` job with `maxLeads=5` and review the output before scaling up.
- **Rate limits are conservative by design.** A 100-lead job at a 1.2 s delay
  with two workers takes several minutes. This is intentional.
- **Emails are not verified for deliverability.** They are validated
  syntactically only. `emailStatus` reflects syntax, not deliverability.
- **AI is optional and may be unavailable.** Without `AI_ENABLED=true` and a key,
  the AI fields stay empty.
- **XLSX export builds the workbook in memory** while streaming rows. Fine for
  tens of thousands of leads; prefer CSV for very large exports.
- **No email-sending or outreach features** - this is a collection tool only.
- **JWT sessions are stateless.** Signing out clears the token client-side;
  there is no server-side revocation list.
- **The scraper runs single-process** (`uvicorn` without workers) so rate
  limiting and politeness delays behave predictably. Scale with replicas.
- **The first `npm test` downloads a ~600 MB MongoDB binary** for the in-memory
  test database. Subsequent runs are offline. See *Running the tests*.

---

## License

Provided as-is for evaluation. You are responsible for complying with the
Terms of Service of any site you point this at, and with applicable law
regarding data collection.
```