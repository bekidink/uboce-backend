# UBOCE Backend

Backend microservices for the Unified Business Operating & Commerce Ecosystem, built to the
*Backend Microservices PRD v1.0*. This repository currently implements **Stage 1 — Foundation**
(PRD §14): identity, organizations and notifications, plus the shared platform pieces every
later service builds on.

**Stack:** NestJS 12 (ESM) · TypeScript 6 · PostgreSQL 17 · Prisma 7 · Redis 7 (streams) ·
Firebase Cloud Messaging · pnpm workspaces · Vitest.

## Quick start

Requires Node 24+, pnpm 11 and Docker.

```bash
pnpm install
pnpm setup          # creates services/*/.env and a JWT signing key pair
pnpm infra:up       # Postgres (localhost:5433) + Redis (localhost:6380)
pnpm build          # prisma generate + compile everything
pnpm migrate        # apply each service's migrations to its own database
pnpm dev            # run all services in watch mode
pnpm smoke          # end-to-end checks against the running services
```

| Service      | Port | OpenAPI                      | Owns (PRD §7.1)                                    |
| ------------ | ---- | ---------------------------- | -------------------------------------------------- |
| identity     | 4101 | http://localhost:4101/docs   | users, credentials, sessions, security events      |
| organization | 4102 | http://localhost:4102/docs   | organizations, memberships, roles, branches        |
| notification | 4103 | http://localhost:4103/docs   | device tokens, notifications, attempts, preferences |

Every service also exposes `GET /health/live` and `GET /health/ready` (database + Redis).

## Layout

```
packages/
  contracts/     versioned event types and the event envelope (PRD §8.4)
  common/        shared NestJS building blocks (see below)
services/
  identity/      S01
  organization/  S02
  notification/  S16
infrastructure/docker/   Postgres init: one database + login role per service
scripts/         setup-env, smoke-test
```

Each service has its own `prisma/schema.prisma`, migrations, `.env` and database. No service can
connect to another's database (PRD §4.2, §7.2).

## How the pieces fit

**Authentication.** Identity signs short-lived (15 min) RS256 access tokens. Other services
only hold the public key, so they can verify tokens but never mint them. Refresh tokens are
opaque, single-use and rotated on every refresh; presenting an already-used refresh token
revokes the whole session family. Logout and revocation are also written to Redis so every
service rejects that session's access tokens immediately, not when they expire.

**Authorization and tenancy.** Every route requires a token unless marked `@Public()`.
Organization-scoped actions re-check the caller's active membership and role permission on
the server, every time (PRD §3.2). Non-members get `404`, not `403`, so organization IDs can't
be probed. Role → permission mapping lives in
[`services/organization/src/organizations/permissions.ts`](services/organization/src/organizations/permissions.ts).

**Events.** A state change and its event are written in the same database transaction to the
service's `outbox_events` table. A relay publishes committed rows to the Redis stream
`uboce.events`. Consumers read with their own consumer group, record each handled `eventId`
in an inbox table in the same transaction as their own changes (so redeliveries are harmless),
retry failures, and park events that keep failing on `uboce.events.dlq`. Delivery is
at-least-once by design (PRD §8.3).

**Errors.** Every service returns `{ "error": { "code", "message", "details?" }, "correlationId" }`.
Clients branch on `code`, never on `message`.

**Observability.** JSON logs (pino) with service name and correlation ID. Send
`x-correlation-id` to follow one request across services; it is echoed back and carried into
the events it causes. Authorization headers, cookies, passwords and tokens are redacted.

## Firebase (push notifications)

Without configuration, the notification service logs pushes instead of sending them. To send
real pushes:

1. Firebase console → Project settings → Service accounts → **Generate new private key**.
2. Save it outside git, e.g. `secrets/firebase-service-account.json` (`secrets/` is ignored).
3. Set `FIREBASE_SERVICE_ACCOUNT_PATH` in `services/notification/.env`.
4. Mobile apps call `POST /api/v1/notifications/devices` with their FCM token after login and
   `DELETE /api/v1/notifications/devices` on logout. A push opens the screen in `data.route`.

iOS delivery also needs an APNs key uploaded in Firebase → Cloud Messaging.

## Not built yet

Deliberately deferred, roughly in the order they'll be needed:

- **API gateway / edge**: one public entry point, CORS and rate limiting; services currently
  listen directly.
- **Service-to-service authentication** (PRD §5.1) for internal calls; today services only
  talk through events.
- **Member invitations by email or phone.** Adding a member currently needs their user ID.
- **MFA** for privileged accounts, password reset, email/phone verification.
- **Rate limiting shared across instances.** The login throttle is per instance and in memory.
- **Retrying failed pushes**, plus email/SMS channels with Ethiopian providers.
- **Dockerfiles and CI pipeline** (PRD §13).
- **Integration tests against a real database** in CI. Today: unit tests (`pnpm test`) plus
  `pnpm smoke` against running services.
- **Native-speaker review of the Amharic notification copy** in
  `services/notification/src/notifications/templates.ts`.

Next per the roadmap: **Stage 2 — Core commerce** (Catalog, Procurement, Commerce, Discovery).
