# LeadScout — E-commerce Lead Finder

A Phase 1, server-rendered-with-static-assets SaaS application for discovering **e-commerce businesses** with Gemini Google Search grounding. It is intentionally limited to lead discovery and management: no campaigns, outreach, messaging, or CRM pipeline are included.

## Lead quality rule

A lead is saved only when the candidate has an official business website **and** an exact, publicly listed business email with a public source URL. Phone is optional. The application never generates probable email addresses and does not claim deliverability or verification.

## Features

- Gemini discovery with Google Search grounding, URL Context, and structured JSON output.
- Bounded, asynchronous MongoDB-backed discovery jobs with live progress polling and cancellation.
- Deterministic validation of model output, URLs, domains, and public email syntax.
- Pending leads are persisted review items; saved and discarded decisions are permanent normalized-domain exclusions. Only one unresolved search can exist at a time.
- Find Leads, Saved Leads, Not Useful, and Search History views in a responsive vanilla HTML/CSS/JavaScript dashboard.
- Search, pagination, pending save/discard actions, accessible controls, secure headers, CORS, body limits, and discovery endpoint rate limiting.

## Architecture

`public/` contains the dependency-free responsive UI. `src/` intentionally uses a small set of consolidated modules: routes expose APIs, models persist leads/jobs/history, services handle Gemini discovery, and utilities centralize validation and normalization. Gemini is only called from the server.

Discovery is deliberately bounded by `DISCOVERY_MAX_ATTEMPTS` and `DISCOVERY_BATCH_SIZE` for serverless execution safety. The process discovers candidate domains first, checks MongoDB per candidate, reuses an existing pending document for the current job, and relies on the unique index for the final duplicate guard. It never serializes all previous leads into a Gemini prompt.

## Review lifecycle and recovery

Discovered leads start as `pending` and are associated with their persisted `SearchJob`. Pending leads survive refreshes, browser closes, and later visits until they are saved, marked Not Useful (`discarded`), or explicitly cleared. Saved and discarded domains permanently exclude future discovery; clearing pending leads deletes only those pending records, so that domain may be discovered later.

A MongoDB singleton discovery-state document atomically reserves the one unresolved search. A new job is rejected while a job is queued/running or its completed/cancelled job has pending leads. `GET /api/discovery/current` restores the current job, counters, and pending count after a refresh. Pending review supports page-scoped selection, `PATCH /api/leads/bulk-status`, and `DELETE /api/discovery/jobs/:id/pending-leads`; those operations are scoped server-side to the current unresolved job.

The job record survives refresh, but Vercel execution is still bounded by `waitUntil` and the 60-second `maxDuration`. Persistence lets the browser recover the state while execution remains alive; it is not an unlimited durable worker.

## Requirements

- Node.js 20+
- MongoDB (local or Atlas)
- Gemini API key with access to the configured model and Google Search grounding

## Setup

```bash
git clone <repository-url>
cd ecommerce-lead-finder
cp .env.example .env
npm install
npm run dev
```

Set these values in `.env`:

| Variable | Required | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | Yes | Server-only Gemini API credential. |
| `MONGODB_URI` | Yes | MongoDB Atlas connection URI; the application selects `ecommerce_lead_finder`. |
| `NODE_ENV` | Yes | `development` or `production`. |
| `APP_ORIGIN` | Yes | Comma-separated allowed browser origins. |
| `LOG_LEVEL` | Yes | Logging verbosity setting. |
| `DISCOVERY_RATE_LIMIT_WINDOW_MS` | No | Rate-limit window (default 900000). |
| `DISCOVERY_RATE_LIMIT_MAX` | No | Max jobs per window (default 10). |
| `DISCOVERY_MAX_ATTEMPTS` | No | Max discovery passes (default 4, capped at 8). |
| `DISCOVERY_BATCH_SIZE` | No | Candidate batch limit (default 30, capped at 50). |

Open `http://localhost:3000`. Production uses `npm start`; tests run with `npm test`, and linting with `npm run lint`.

## MongoDB Atlas configuration

This project uses your existing Atlas **Cluster0** and consistently connects Mongoose to the `ecommerce_lead_finder` database. The `Lead`, `SearchJob`, and `SearchHistory` models will create the `leads`, `searchjobs`, and `searchhistories` collections when the first records are written. The `Lead.domain` unique index remains the database-level duplicate-business safeguard.

Create a local `.env` from `.env.example` and supply your own secret values (the file is ignored by Git):

```dotenv
MONGODB_URI=mongodb+srv://<username>:<URL-ENCODED-PASSWORD>@<cluster-host>/ecommerce_lead_finder?retryWrites=true&w=majority
GEMINI_API_KEY=<your-gemini-api-key>
NODE_ENV=development
APP_ORIGIN=http://localhost:3000
```

If your Atlas URI already specifies a database path, it should be `ecommerce_lead_finder`; the Mongoose connection also explicitly selects that database to prevent accidental writes to `test`, `admin`, or `local`. Replace only `MONGODB_URI` when rotating your Atlas password—no source change is required. Do not put the URI, password, or API key in GitHub.

The safe connection status endpoint is `GET /api/health`. It reports only `ok`/`degraded` and `connected`/`disconnected`; it never returns a connection string, password, or API key.

## Discovery and review API

- `POST /api/discovery/jobs` starts the single allowed queued discovery job and returns `409 SEARCH_LOCKED` while another search is running or a pending review queue exists.
- `GET /api/discovery/current` returns the persisted job, pending count, `searchLocked`, and lock reason for refresh recovery.
- `GET /api/discovery/jobs/:id` polls the stored job counters; `POST /api/discovery/jobs/:id/cancel` requests cancellation.
- `GET /api/leads?status=pending|saved|discarded` lists leads. Pending results are always scoped to the current unresolved job.
- `PATCH /api/leads/:id/status` and `PATCH /api/leads/bulk-status` only permit `pending → saved` or `pending → discarded` updates. Bulk input accepts 1–100 ObjectIds.
- `DELETE /api/discovery/jobs/:id/pending-leads` explicitly clears only that current job’s pending leads. It never removes saved/discarded leads or search history.

## Gemini implementation notes

The Gemini service uses the official `@google/genai` SDK and `models.generateContent`, configured with `googleSearch`, `urlContext`, `responseMimeType: "application/json"`, and a response JSON schema. The prompt requires official websites, public-email source evidence, e-commerce relevance, and no invented contact data. Direct website crawling is intentionally not used: grounding and URL Context keep the initial release bounded and avoid aggressive fetching.

Gemini is deliberately hardcoded to `gemini-3.1-flash-lite`. Availability of Google Search grounding and URL Context depends on that model, API key, quota, and Google’s current regional/product availability.

## Vercel deployment

1. Import the repository into Vercel.
2. In **Project → Settings → Environment Variables**, add `MONGODB_URI` and `GEMINI_API_KEY`; set `NODE_ENV=production` and `APP_ORIGIN` to the production Vercel URL.
3. Deploy. `api/index.js` exports the Express app and sets a 60-second maximum duration; `vercel.json` rewrites requests through the Express entry point.
4. Use MongoDB Atlas or another MongoDB endpoint reachable from Vercel.

A request starts a persisted job, schedules bounded work through Vercel `waitUntil`, and browser polling observes its actual counters. `maxDuration` remains 60 seconds, so keep the discovery limits bounded. Workloads needing guaranteed long-running execution beyond that limit should add a managed durable job runner before increasing discovery limits.

## Security and data handling

Secrets are excluded by `.gitignore` and are never sent to browser JavaScript. The API applies Helmet, CORS allowlisting, JSON body limits, validation, safe external URL checks, rate limiting, and generic user-safe errors. Public contact information is retained only when returned with evidence by grounded results.

## Project structure

```text
public/                 responsive vanilla frontend
src/config.js           environment and MongoDB connection
src/models.js           Lead, SearchJob, SearchHistory schemas
src/services.js         Gemini discovery, grounded search, and job workflow
src/routes.js           HTTP routes, validation, rate limit, and handlers
src/utils.js            normalization, validation, errors, and logging
src/app.js              Express security and static application setup
src/server.js           local startup and stale-job recovery
tests/app.test.js       deterministic unit tests
api/index.js            Vercel Express entry
```

## Future expansion

`Lead` is a standalone entity suitable for a future campaign reference (`leadId`). Campaigns, email/WhatsApp/SMS sending, sequences, analytics, and automated outreach are deliberately excluded from Phase 1.
