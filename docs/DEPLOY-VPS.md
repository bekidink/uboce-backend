# Deploying to a VPS

One Linux server runs the whole backend with Docker Compose. Supabase stays the database.

```
            internet
               │  80/443
            ┌──┴───┐  HTTPS (Let's Encrypt, automatic)
            │ Caddy│── app.<domain>   → web app (static files)
            └──┬───┘── api.<domain>   → gateway
               │   └── files.<domain> → storage (signed upload/download URLs)
   private Docker network
   ├─ gateway ── 21 services ── Redis (AOF, noeviction)
   ├─ storage (SeaweedFS, volume)
   └─ migrate (runs pending migrations before the services start)
               │
            Supabase Postgres (pooler, one schema per service)
```

Everything is generated from the repo, so nothing is configured by hand on the server:

| Command | Writes |
| --- | --- |
| `pnpm vps:generate` | `deploy/vps/docker-compose.yml`, `deploy/vps/Caddyfile` (committed, no secrets) |
| `pnpm deploy:secrets` | `secrets/render.json`: production keys and credentials (git-ignored) |
| `pnpm vps:env` | `deploy/vps/env/*.env`: each service's settings and secrets (git-ignored) |
| `deploy/vps/deploy.sh user@server` | copies all of the above to `/opt/uboce` and (re)starts the stack |

## The server

- **Size:** 4 GB RAM minimum (22 Node processes ≈ 3 GB), 8 GB comfortable; 2+ vCPUs; 40 GB disk
  plus whatever files you expect. E.g. Hetzner CX32, DigitalOcean 8 GB, Contabo VPS S.
- **Location:** close to the database. Supabase is in eu-west-1 (Ireland), so an EU data centre
  keeps every query fast; each request makes several database round trips.
- **OS:** Ubuntu 24.04 or Debian 12.

## First deploy

1. **DNS.** Point `api.`, `files.` and `app.` (your domains) at the server's IP.
2. **Domains and images.** Edit `deploy/vps/site.env`: the three domains, your email for
   Let's Encrypt, and `IMAGE_PREFIX` (default `ghcr.io/bekidink/uboce`).
3. **Secrets.** From the repo root:

   ```bash
   DEPLOY_ADMIN_EMAILS=you@company.et \
   DEPLOY_SMTP_URL='smtps://user:pass@smtp.provider.com:465' \
   pnpm deploy:secrets
   ```

   This creates new signing keys, MFA key, service credentials and S3 keys; database URLs come
   from `.env.supabase`. Re-running keeps existing values (`--rotate` replaces them and signs
   everyone out). Back up `secrets/render.json` somewhere safe.
   Optional: put the Firebase key at `deploy/vps/secrets/firebase-service-account.json` for push
   notifications.
4. **Images.** Push to `main`: CI builds and publishes all images to GitHub Container Registry
   (`uboce-<service>:latest` and `:<commit sha>`). The packages are private by default; either make
   them public in GitHub → Packages, or log in on the server (step 5).
5. **Prepare the server** (once):

   ```bash
   ssh root@SERVER 'sh -s' < deploy/vps/bootstrap.sh
   # if the images are private:
   ssh root@SERVER 'echo <token with read:packages> | docker login ghcr.io -u <github user> --password-stdin'
   ```

   This installs Docker, allows only SSH/HTTP/HTTPS through the firewall and adds 2 GB swap.
6. **The web app.** In `uboce-web`: `VITE_API_URL=https://api.<domain> pnpm build`, then copy
   `dist/*` into `deploy/vps/web/`.
7. **Deploy:**

   ```bash
   deploy/vps/deploy.sh root@SERVER
   ```

   Migrations run first, then the services start in dependency order; Caddy gets certificates on
   the first request. `https://api.<domain>/health/ready` returns `{"status":"ok"}` when all 21
   services are up.
8. **Admin.** Register the email from `DEPLOY_ADMIN_EMAILS`, confirm it, turn on two-step
   verification: that account is the platform admin.

## Updates

```bash
git push                                   # CI publishes new images
deploy/vps/deploy.sh root@SERVER           # pulls :latest, migrates, restarts what changed
deploy/vps/deploy.sh root@SERVER <sha>     # or pin/roll back to a specific build
BUILD=1 deploy/vps/deploy.sh root@SERVER   # without CI: build the images on the server (slow)
```

## Operating it

- `ssh root@SERVER 'cd /opt/uboce && docker compose --env-file site.env ps'` — status;
  `… logs -f gateway` — logs (JSON, rotated at 5 × 10 MB per container).
- Backups: Supabase backs up the database. Back up the `uboce_storage_data` volume (uploaded files)
  and keep `secrets/render.json`; Redis holds only in-flight events and caches.
- API docs are off (`DOCS_ENABLED=false` in the gateway's env); turn them on there if wanted.
- TLS to Supabase isn't verified yet: put Supabase's CA in `.env.supabase` (`SUPABASE_CA_FILE`) and
  re-run `pnpm deploy:secrets` and the deploy.
