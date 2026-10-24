# The whole UBOCE backend in one container, for a free Hugging Face Docker Space.
# scripts/hf-push.mjs puts this file at the root of the Space's repository.
#
# One process tree: Redis, the 21 services and the gateway, started by start.mjs.
# The gateway listens on 7860 (the Space's port) and also serves the web app.
# Postgres is Supabase; uploaded files go to Supabase Storage (S3 API).
FROM node:24-alpine

RUN apk add --no-cache redis
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build && chown -R node:node /app

ENV NODE_ENV=production
# Spaces run the container as uid 1000, which is the image's `node` user.
USER node
EXPOSE 7860
CMD ["node", "deploy/huggingface/start.mjs"]
