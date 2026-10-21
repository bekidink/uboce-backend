# UBOCE Backend

Backend microservices for the Unified Business Operating & Commerce Ecosystem, built to the
*Backend Microservices PRD v1.0*. All 21 services in the PRD's inventory (§4.1) are implemented,
covering roadmap Stages 1–6 (§14), behind one API gateway.

**Stack:** NestJS 12 (ESM) · TypeScript 6 · PostgreSQL 17 · Prisma 7 · Redis 7 (streams) ·
S3-compatible storage (SeaweedFS locally) · Firebase Cloud Messaging · SMTP (Mailpit locally) ·
pnpm workspaces · Vitest · Docker.

## Quick start

Requires Node 24+, pnpm 11 and Docker.

```bash
pnpm install
pnpm setup          # .env files, signing keys, MFA key, service secrets, local test webhooks
pnpm infra:up       # Postgres :5433, Redis :6380, Mailpit :1025/:8025, SeaweedFS S3 :8333
pnpm infra:db       # creates any missing service databases (safe to re-run)
pnpm build          # prisma generate + compile everything
pnpm migrate        # each service's migrations, to its own database
pnpm dev            # all services + gateway in watch mode
pnpm smoke          # 172 end-to-end checks through the gateway
```

Or everything in containers: `docker compose --profile apps up -d --build` (after `pnpm setup`).

Clients talk only to the **gateway**: `http://localhost:4100/api/v1`. Each service also serves
OpenAPI at `http://localhost:<port>/docs` and `GET /health/live|ready`. Ports are listed in
[`infrastructure/services.json`](infrastructure/services.json), the single source for setup and Compose.

## Services

| PRD | Service | Port | What it owns |
| --- | --- | --- | --- |
| — | gateway | 4100 | Public entry: routing, CORS, Redis-backed rate limits; internal routes never exposed |
| S01 | identity | 4101 | Users, sessions, refresh rotation, MFA (TOTP), email verification, password reset, service tokens |
| S02 | organization | 4102 | Organizations, memberships & roles, branches, email/SMS invitations; KYB status |
| S16 | notification | 4103 | In-app, push (FCM), email (SMTP), SMS (adapter); retries; English + Amharic |
| S05 | catalog | 4104 | Categories with required attributes, products, variants, publication |
| S06 | discovery | 4105 | Public product/supplier search (full-text, filters, freshness) |
| S07 | procurement | 4106 | RFQs (invited/open), quotations with revision history, comparison, single award |
| S08 | commerce | 4107 | Purchase/sales orders, state machine, idempotent creation, fulfilment status |
| S09 | inventory | 4108 | Append-only stock ledger, balances, all-or-nothing reservations, reversals |
| S10 | warehouse | 4109 | Warehouses, locations, partial receiving, inspection holds, transfers |
| S13 | logistics | 4110 | Shipments, dispatch (stock issue), carrier tracking, delivery evidence, exceptions |
| S14 | quality | 4111 | Inspections, accept/reject/conditional decisions, nonconformance |
| S11 | agriculture | 4112 | Farms, plots, seasons, harvests, grading, produce lots, split/merge lineage |
| S12 | manufacturing | 4113 | BOMs, production orders, material reservation, runs, yield/waste, batch lineage |
| S03 | kyc | 4114 | Individual verification cases, evidence, checks, decisions, expiry |
| S04 | kyb | 4115 | Business verification cases, evidence, checks, decisions, expiry |
| S15 | finance | 4116 | Invoices, payment references, reconciliation, credit notes |
| S17 | document | 4117 | Private files: signed upload/download links, content checks, grants, retention, audit |
| S18 | dispute | 4118 | Disputes, statements, evidence, resolutions, appeals; supplier performance |
| S19 | integration | 4119 | Signed provider webhooks (payments, carriers), replay protection, health |
| S20 | analytics | 4120 | Organization-scoped daily metrics, conversion rates, freshness |
| S21 | administration | 4121 | Platform staff roles, settings, feature flags, audited admin workflows |

## End-to-end workflows (PRD §6)

| Workflow | How it runs |
| --- | --- |
| **6.1 Onboarding & verification** | Register → verify email → create organization → upload evidence (Document) → KYC/KYB case → reviewer decides → Organization's `verificationStatus` follows via event → Discovery's "verified" filter and Procurement's `REQUIRE_VERIFIED_SUPPLIERS` use it |
| **6.2 RFQ → order** | Publish product → RFQ → quotations (revisable) → accept one (conditional update) → `QuotationAccepted` → exactly one order (unique `sourceQuotationId`) → supplier confirms → Inventory reserves stock (or the order goes to `exception`) |
| **6.3 Receiving → delivery** | Receipt (partial, dock rejections) → optional Quality inspection hold → accepted quantities posted to Inventory · Shipment → dispatch issues stock *from the reservation* → carrier webhooks → buyer confirms delivery with evidence → order `partially_fulfilled`/`fulfilled` → buyer closes · Invoice → payments reconciled from verified provider callbacks, never inferred from delivery |
| **6.4 Agriculture traceability** | Harvests → lot (cannot over-assign a harvest) → split/merge conserve quantity and move stock → `/lots/:id/trace` walks parent lots back to harvests, seasons and farms |
| **6.5 Manufacturing** | BOM → production order → release reserves scaled materials (all-or-nothing) → completion issues materials, stocks output, releases leftovers → batch lineage |
| **6.6 Disputes** | Either party opens with evidence (shared with the other party and reviewers) → statements → reviewer resolves with reasons and follow-ups (no direct edits to other services' records) → one appeal within 14 days · Disputed invoices freeze |

## Design rules enforced in code

- **Data ownership.** Each service has its own database and login role (PRD §4.2, §7.2). Other
  services' data is reached only through events or internal APIs.
- **Events.** A state change and its event commit together (transactional outbox) → Redis stream →
  consumers record handled event IDs in their own transaction (inbox), so redelivery is harmless;
  failures are retried, then dead-lettered (PRD §8.3).
- **Cross-service steps that can't share a transaction** (dispatch, lot split, production) post
  with fixed idempotency keys; Agriculture and Manufacturing queue postings and retry until
  Inventory accepts them (PRD §8.5).
- **Inventory integrity.** Append-only ledger; balance rows locked in a fixed order; free stock can
  never cover another order's reservation; corrections are reversal entries. Verified by a
  concurrency check: 8 parallel withdrawals against stock for 3 → exactly 3 succeed.
- **Money.** Decimal strings in APIs, `Prisma.Decimal` in code, explicit currency everywhere, per-line
  half-up rounding; no country's tax rate is assumed.
- **Tenancy.** `x-organization-id` is untrusted until Organization confirms membership; each service
  checks the role against its own rules; other organizations' records return 404.
- **Authentication.** RS256 access tokens (15 min) only Identity can sign; rotating single-use
  refresh tokens with reuse detection; instant revocation via Redis; separate audiences for user,
  service and MFA-challenge tokens. Platform staff roles require MFA.
- **Provider callbacks.** HMAC-SHA256 over timestamp + raw body, 5-minute window, deduplicated by
  event ID, payloads stored only as hashes. A provider reference belongs to one invoice.
- **Privacy.** One-time links (verification, reset, invitations) are stored only as hashes and never
  persisted in notification bodies; recipients are masked; tokens, cookies and signed URLs are
  redacted from logs; documents are private with short-lived signed links and an access log.

## Layout

```
apps/gateway/              public API gateway
packages/contracts/        versioned events + internal API shapes (PRD §8)
packages/common/           shared NestJS building blocks (auth, events, internal clients, …)
services/<name>/           one NestJS app + Prisma schema + migrations + database each
infrastructure/            services.json (ports), Postgres init, SeaweedFS S3 config, migration runner
scripts/                   setup-env, new-service, generate-compose, smoke tests
Dockerfile                 one multi-stage build for every deployable
.github/workflows/ci.yml   lint → typecheck → unit tests → build → end-to-end → images
```

New service: `node scripts/new-service.mjs <name> <port> "<title>"`, add it to
`infrastructure/services.json`, the gateway route table and `init.sql`, then `pnpm compose:generate`.

## Configuration notes

- **Push:** set `FIREBASE_SERVICE_ACCOUNT_PATH` in `services/notification/.env`; iOS also needs an
  APNs key uploaded in Firebase. Without it, pushes are logged.
- **Email:** any SMTP server via `SMTP_URL`. Locally Mailpit catches everything.
- **Storage:** any S3-compatible store via `S3_*` in `services/document/.env`.
- **Webhooks:** `PROVIDERS=name:kind:secret,…` in `services/integration/.env` (`kind` is `payment` or
  `carrier`); providers sign with their secret. `pnpm setup` adds two local test providers.
- **First administrator:** list the email in `ADMIN_BOOTSTRAP_EMAILS` (Administration). The account
  becomes `platform_admin` once its email is verified and MFA is on.
- **Rate limits:** local `.env` values are raised so `pnpm smoke` can run; production should keep the
  code defaults (10/min per auth endpoint at Identity, 30/min auth and 300/min overall at the gateway).

## Decisions still open (PRD §17)

These are business, legal or vendor choices the code is ready for but cannot make:

- **Providers.** No real Ethiopian payment, SMS, carrier, ID-registry or ERP provider is wired.
  Integration accepts a documented signed format, and `SmsProvider` is an interface with a log
  implementation. Each real provider needs a small adapter.
- **Compliance policy.** KYC/KYB tiers, required evidence, validity periods and document retention
  periods are placeholders (`services/kyc|kyb/src/cases/policy.ts`, `services/document/src/documents/content-rules.ts`)
  pending legal review. Every decision records its policy version.
- **Malware scanning** of uploads (PRD 5.17 "where feasible") isn't implemented; the hook is in
  `DocumentsService.completeUpload`. Uploads are already type-checked by content signature.
- **Amharic copy** in notification templates needs native-speaker review.
- **Production hardening.** A secrets manager instead of `.env` files, signing-key rotation (JWKS),
  OpenTelemetry tracing, backup and restore runbooks, and a CI gate for incompatible contract changes.
