# One Dockerfile for every deployable. Build a service image with:
#   docker build --target runtime --build-arg TARGET=services/identity -t uboce/identity .
# and the migration runner (all services' migrations) with:
#   docker build --target migrate -t uboce/migrate .

FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate
WORKDIR /repo

# ---- Build everything once --------------------------------------------------------
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm build

# ---- Migration runner: applies each service's migrations to its own database --------
FROM build AS migrate
COPY infrastructure/docker/migrate.sh /usr/local/bin/migrate.sh
CMD ["sh", "/usr/local/bin/migrate.sh"]

# ---- Production bundle for one deployable ----------------------------------------
FROM build AS bundle
ARG TARGET
RUN test -n "$TARGET" || (echo "Pass --build-arg TARGET=services/<name> or apps/gateway" && exit 1)
RUN pnpm --filter "./${TARGET}" deploy --prod --legacy /out

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=bundle --chown=node:node /out ./
USER node
CMD ["node", "dist/main.js"]
