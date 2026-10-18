# Windows setup (without Docker)

Docker is the fastest path, but the whole stack runs natively on Windows. Only **Node.js 18+**, **Python 3.11+**, and a configured MongoDB Atlas
database are required. Redis is optional.

## 0. Check your tooling

```powershell
node --version      # v18 or newer
npm --version
python --version    # 3.11 or newer
```

If `python` is not found, try `py -3 --version` and use `py -3` in place of
`python` below.

## 1. Scraper (Python)

```powershell
cd leadforge-ai\scraper

python -m venv .venv
.\.venv\Scripts\Activate.ps1

pip install --upgrade pip
pip install -r requirements.txt

copy .env.example .env
```

**If PowerShell blocks the activation script**, either run this once in an
Administrator PowerShell:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

…or skip activation entirely and call the interpreter directly:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000
```

### Optional: Playwright

Only needed for JavaScript-rendered pages:

```powershell
.\.venv\Scripts\python.exe -m playwright install chromium
```

Then set `SCRAPER_FETCHER=playwright` in `scraper/.env`. The default
(`httpx`) needs no browser download.

## 2. Backend (Node)

```powershell
cd ..\backend
npm install
copy .env.example .env
```

Generate a real secret:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Paste the output into `JWT_SECRET` in `backend/.env`, and set a different
value for `INTERNAL_API_TOKEN`.

Configure Atlas in `backend/.env`:

```env
MONGODB_URI=mongodb+srv://<db_user>:<encoded_password>@<cluster-host>/?retryWrites=true&w=majority
MONGODB_DB_NAME=leadforge
```

Create a least-privilege database user (read/write access to `leadforge` only)
and allowlist the backend machine's IP in Atlas Network Access. Rotate any
database password that has been shared in chat or another public location.
Then test the connection:

```powershell
npm run db:check
```

## 3. Frontend (Node)

```powershell
cd ..\frontend
npm install
```

The dev server proxies `/api` to `http://127.0.0.1:4000`, so no configuration
is required.

## 4. Optional services

Neither is required - the app degrades gracefully without them.

### MongoDB Atlas

Atlas is required for the backend to start. Missing or unreachable database
configuration is reported explicitly; the app does not silently use an
ephemeral development database. The test suite uses its own isolated
in-memory MongoDB.

### Redis

Without it, leave `QUEUE_DRIVER=auto`. The API logs
`Redis unavailable - running jobs inline` and processes jobs in the same
process.

## 5. Run it (three terminals)

```powershell
# Terminal 1
cd leadforge-ai\scraper
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload --port 8000
```

```powershell
# Terminal 2
cd leadforge-ai\backend
npm run dev
```

```powershell
# Terminal 3
cd leadforge-ai\frontend
npm run dev
```

Open <http://localhost:5173>, create an account, and run a scrape.

## 6. Seed demo data

```powershell
cd leadforge-ai\backend
npm run seed
```

Sign in with `demo@leadforge.test` / `Demo12345!`.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `EADDRINUSE :4000` | Another process owns the port | Change `PORT` or stop the other process |
| `EADDRINUSE :5173` | Vite already running | Stop it, or Vite will offer the next port |
| Dashboard loads but all requests fail | Backend not running | Check terminal 2 |
| Jobs stay `queued` | No worker running | Confirm terminal 2; check `QUEUE_DRIVER` |
| `MONGODB_URI is required` | Atlas URI missing from `backend/.env` | Configure the Atlas connection string and run `npm run db:check` |
| `Could not connect to MongoDB` | IP not allowlisted, wrong credentials, or Atlas is unavailable | Check Atlas Network Access and database-user permissions; never log or share the URI |
| `SCRAPE_FAILED: fetch failed` | Python service down | Check terminal 1 |
| All leads show "demo data" | `SCRAPER_MODE=mock` | Expected - see the mock mode docs |
| `npm test` takes time on first run | Downloading the test-only MongoDB binary | Let it finish once; later test runs use the cached binary |

## Verifying the install

```powershell
# Scraper: 105 tests, no network needed
cd leadforge-ai\scraper
.\.venv\Scripts\python.exe -m pytest

# Backend: route wiring, no database needed
cd ..\backend
npm run smoke

# Backend: unit tests (normalization, dedupe, exports)
npm run test:unit
```