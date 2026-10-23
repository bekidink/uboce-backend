# syntax=docker/dockerfile:1.7
# One Dockerfile for every deployable. Build a service image with:
#   docker build --target runtime --build-arg TARGET=services/identity -t uboce/identity .
# and the migration runner (all services' migrations) with:
#   docker build --target migrate -t uboce/migrate .

FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate
ENV PNPM_HOME=/pnpm
# Slow or flaky networks: long timeouts, gentle concurrency, generous retries.
RUN pnpm config set fetch-timeout 600000 && pnpm config set fetch-retries 6 && pnpm config set network-concurrency 8
WORKDIR /repo

# ---- Dependencies: fetched from the lockfile alone, so this layer is reused until it changes ----
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --store-dir /pnpm/store

# ---- Build: one deployable (TARGET) and the workspace packages it uses, or everything --------
FROM deps AS build
ARG TARGET
COPY package.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY apps ./apps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --offline --frozen-lockfile --store-dir /pnpm/store
RUN if [ -n "$TARGET" ]; then \
      if [ -f "$TARGET/prisma/schema.prisma" ]; then pnpm --filter "./${TARGET}" prisma:generate; fi && \
      pnpm --filter "{./${TARGET}}..." build; \
    else pnpm build; fi

# ---- Migration runner: applies each service's migrations to its own database --------
FROM build AS migrate
COPY infrastructure/docker/migrate.sh /usr/local/bin/migrate.sh
CMD ["sh", "/usr/local/bin/migrate.sh"]

# ---- Production bundle for one deployable ----------------------------------------
FROM build AS bundle
ARG TARGET
RUN test -n "$TARGET" || (echo "Pass --build-arg TARGET=services/<name> or apps/gateway" && exit 1)
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm --filter "./${TARGET}" deploy --prod --legacy --store-dir /pnpm/store /out

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=bundle --chown=node:node /out ./
USER node
# Services also run `npx prisma migrate deploy` from this image before each release.
CMD ["node", "dist/main.js"]
