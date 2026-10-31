# ConsentGrid

ConsentGrid is a local-first consent platform for capturing and verifying consent records in a simple, tamper-evident way. It supports multilingual consent notices, signed consent artifacts, and local webhook workflows for testing.

## Local setup

Requirements:

- Node.js 22.5.0 or newer
- SQLite works out of the box for local development

Run this in the project folder:

```bash
git clone <repo-url>
cd consentgrid
npm run migrate
npm run seed
npm start
```

This creates the local database in `./data/consentgrid.db`, seeds demo data, and starts the app.

Open these URLs in the browser:

- `http://localhost:8080/`
- `http://localhost:8080/dashboard`
- `http://localhost:8080/verify`
- `http://localhost:8080/widget-demo.html`
- `http://localhost:8080/health`

After `npm run seed`, the app prints the demo login details and API credentials. Save them from the terminal.

```bash
Dashboard URL    http://localhost:8080/
Login email      demo@consentgrid.local
Login password   demo-password-123
API key          cg_live_...
Org id           ...
Webhook secret   whsec_...
Sample artifacts <id>, <id>, <id>
```

## Run the webhook worker

Open a second terminal and run:

```bash
npm run worker
```

This helps test the webhook retry and failure flow.

## Useful commands

```bash
npm test
npm run test:coverage
npm run build:widget
npm run cost-model
```

## Project structure

```text
src/         app logic, routes, crypto, DB, and webhook workers
public/      dashboard, landing pages, verifier, and demo UI
widget/      embeddable consent widget
migrations/  SQL schema
tests/       automated tests
docs/        API and schema docs
scripts/     helper scripts
```

## Notes

The default local configuration uses SQLite. Please read `SECURITY.md` and `LEGAL-OPEN-QUESTIONS.md` before using this with real user data.

- Node.js ≥ 22.5.0 (uses the built-in `node:sqlite` and `node:test`)
- Docker + Docker Compose, **only** if you want to run against real Postgres instead of the built-in SQLite adapter

No `npm install` is required for the fastest path below — the core app has zero external dependencies (stdlib only: `node:http`, `node:crypto`, `node:sqlite`, `node:test`). The Postgres adapter needs the `pg` package, installed separately (see Option B).

---

## Option A — Fastest path: SQLite, zero setup (recommended for a first run)

```bash
git clone <this-repo>
cd consentgrid
npm run migrate
# 2. Seed a demo org, API key, an approved notice (EN + HI), sample consents, a webhook
npm run seed
# 3. Start the app
npm start
```
`npm run seed` prints demo credentials once — copy them, they are not shown again:

```
Dashboard URL    http://localhost:8080/
Login email      demo@consentgrid.local
Login password   demo-password-123
API key          cg_live_...
Org id           ...
Webhook secret   whsec_...
Sample artifacts <id>, <id>, <id>
```

Then open:
- **`http://localhost:8080/`** — landing/login
- **`http://localhost:8080/dashboard`** — org dashboard (consent log, templates, integrity check, API keys, webhooks)
- **`http://localhost:8080/verify`** — public artifact verifier; paste one of the sample artifact IDs to see signature/chain verification with no PII exposed
- **`http://localhost:8080/widget-demo.html`** — the embeddable widget running against the live API
- **`http://localhost:8080/health`** — liveness check

In a second terminal, run the webhook worker to see delivery + the dead-letter queue in action (the seeded webhook endpoint intentionally points at `example.com`, so you'll see it retry with backoff and land in the DLQ — this is expected and demonstrates the failure path):

```bash
npm run worker
```

## Option B — Real Postgres (production-shaped path)

```bash
docker compose up -d db

export DATABASE_URL=postgres://consentgrid:consentgrid@localhost:5432/consentgrid
or for window
$env:DATABASE_URL="postgres://consentgrid:consentgrid@localhost:5432/consentgrid"

npm i pg          # the Postgres adapter's only external dependency
npm run migrate
npm run seed
npm start
```

Same URLs and flow as Option A — the application code and every guard (crypto, language, minor-consent, pre-ticked rejection) is identical across both backends; only `DATABASE_URL` changes which adapter loads (`src/db/adapters/sqlite.js` vs. `src/db/adapters/postgres.js`).

Optional extras:
```bash
docker compose --profile tools up -d adminer   # Postgres UI at http://localhost:8081
docker compose --profile app   up -d app       # run the whole app inside a container
```

## Running the test suite

```bash
npm test                # run all tests (uses in-memory/temp SQLite; no setup needed)
npm run test:coverage   # with coverage instrumentation
npm run coverage:gate   # fails the build if coverage on the crypto/hash-chain paths drops below threshold
```

At last verification: **43/43 tests passing**, covering crypto (signing, hash-chain, canonicalization, Merkle helpers), language resolution guards, all consent guards (pre-ticked rejection, language confirmation, honest fallback, minor/guardian flow, crypto-shredding), the full HTTP surface, and webhook delivery + DLQ behavior.

## Other useful commands

```bash
npm run build:widget   # rebuilds widget/dist/consentgrid.js and checks the gzip size budget (<15KB)
npm run cost-model     # prints the infra cost projection (see COST-MODEL.md)
node scripts/cost-model.js --markdown   # regenerate the table in COST-MODEL.md
```

## Key environment variables

See `.env.example` for the full list with comments. The ones worth understanding before touching production:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | `sqlite://./data/consentgrid.db` for local dev, `postgres://...` for production |
| `KMS_PROVIDER` | `local` (dev-only software keys, refuses to run if `NODE_ENV=production`) or `aws` (real KMS, production path) |
| `KMS_SIGNING_KEY_ARN` | Required when `KMS_PROVIDER=aws` |
| `SERVER_HMAC_PEPPER` | Global secret used in the keyed identifier hash — must be a real secret (from a secrets manager) in production, not the example default |
| `SESSION_SECRET` | Signs dashboard session cookies — set a distinct real value in production |
| `WEBHOOK_SIGNING_SECRET` | Default webhook HMAC secret (per-endpoint secrets can override) |

## Project layout

```
src/
  api/        HTTP routes, auth, consent + guardian business logic
  crypto/     KMS interface, artifact signing/hashing, canonicalization, Merkle helpers
  db/         migrations, repo (query layer), sqlite/postgres adapters, seed script
  lib/        env loading, id generation, language resolution, logging, rate limiting, passwords
  webhook/    dispatcher (retry + DLQ), signing, standalone worker process
widget/       embeddable JS SDK (src + built dist)
public/       dashboard, landing page, public verifier, widget demo page
tests/        node:test suite (crypto, language, consent guards, API, webhooks)
docs/         OpenAPI spec, artifact JSON Schema
scripts/      coverage gate, cost model
migrations/   SQL schema (SQLite + Postgres variants)
```

## What's deliberately out of scope for this slice

- Downstream deletion execution in a Fiduciary's own CRM/email/analytics systems — the platform fires a standardized webhook on withdrawal; the receiving system's own middleware acts on it. See the build spec's Tier-3 "Privacy Sidecar" concept for the eventual stronger alternative.
- DigiLocker/Aadhaar KUA integration for minor consent (Tier-2) — the current OTP-based flow and its documented liability boundary are the MVP answer; see `LEGAL-OPEN-QUESTIONS.md` item 2.
- Merkle tree external anchoring (Tier-2) — the schema field (`merkle_root_id`) and the Merkle helper functions (`merkleRoot`, `merkleProof`, `verifyMerkleProof` in `src/crypto/artifact.js`) exist and are tested, but the hourly batching worker that publishes a root to an external ledger is not yet built.
- Confidential computing enclaves, AA/RBI schema parity (Tier-3) — not built; see the build spec for why these are deliberately deferred.

## Before this touches real user data

Read `LEGAL-OPEN-QUESTIONS.md` and get actual counsel sign-off on the three open questions there. Engineering has implemented defensible technical answers to each, but none of them are legal conclusions.
