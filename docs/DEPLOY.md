# Deploying Meadow

Runbook for the Contabo VPS. Assumes the repo is at `/root/Projects/Python/Meadow`.

Already done if you are reading this at step 1: repo cloned, `/srv/meadow-backups`
created, `.env.prod` placed and `chmod 600`.

All commands run from `/root/Projects/Python/Meadow` unless stated.

---

## 1. Swap

The vite build runs on this box and there is no swap. Two gigabytes is cheap insurance.

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
free -h
```

## 2. Pull the latest main

```bash
cd /root/Projects/Python/Meadow
git pull
```

## 3. Check the environment resolves

```bash
docker compose --env-file .env.prod config -q && echo "env OK"
```

Any error here is a missing or malformed key in `.env.prod`. Fix it before continuing.

## 4. Loosen two flags for the first test

The stack binds loopback and marks the refresh cookie Secure, both correct behind TLS
and both wrong while testing over plain HTTP by IP. Set temporarily:

```bash
sed -i 's|^WEB_BIND=.*|WEB_BIND=0.0.0.0|' .env.prod
sed -i 's|^MEADOW_REFRESH_COOKIE_SECURE=.*|MEADOW_REFRESH_COOKIE_SECURE=false|' .env.prod
ufw allow 8014/tcp    # if ufw is active
```

Step 8 puts both back. Leaving them is not an option: over plain HTTP the refresh
token is readable by anything on the network path.

## 5. First build and start

Builds three images on the box. Expect a few minutes, mostly the web bundle.

```bash
docker compose --env-file .env.prod up -d --build --wait
```

`--wait` holds until every container is healthy. The one-shot `migrate` service runs
`alembic upgrade head` and must exit 0 before the API starts, so a failed migration
stops the deploy rather than leaving an API that 500s on its first query.

## 6. Verify

```bash
docker compose --env-file .env.prod ps           # all healthy, migrate exited 0
curl -fsS localhost:8014/healthz                 # {"status":"ok"}
ls -l /srv/meadow-backups                        # a meadow-*.dump already
docker compose --env-file .env.prod logs backup --tail 20
```

The backup sidecar dumps immediately on first start, precisely so this is checkable
now rather than tomorrow. An empty backup directory means stop and fix it: this is the
entire recovery story.

Then open `http://<vps-ip>:8014`, register an account, create a glade, draw something,
reload. With `MEADOW_SMTP_HOST` set the account needs the activation mail followed
first.

## 7. TLS on the host

The compose stack serves plain HTTP on one loopback port and expects the host to
terminate. Certificates are host state with a renewal timer, not something a compose
file should own.

```bash
apt install -y nginx certbot python3-certbot-nginx
```

`/etc/nginx/sites-available/meadow`:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:8014;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # The websocket carries every edit. Without these the board loads and never syncs.
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

`X-Forwarded-For` must be `$proxy_add_x_forwarded_for`, which appends. Overwriting it
lets a client choose its own rate-limit bucket and audit-log address.

```bash
ln -s /etc/nginx/sites-available/meadow /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d your-domain.com
ufw allow 'Nginx Full' && ufw delete allow 8014/tcp
```

## 8. Tighten back up

```bash
sed -i 's|^WEB_BIND=.*|WEB_BIND=127.0.0.1|' .env.prod
sed -i 's|^MEADOW_REFRESH_COOKIE_SECURE=.*|MEADOW_REFRESH_COOKIE_SECURE=true|' .env.prod
sed -i 's|^MEADOW_TRUSTED_PROXY_CIDR=.*|MEADOW_TRUSTED_PROXY_CIDR=172.28.0.1|' .env.prod
sed -i 's|^MEADOW_WEB_BASE_URL=.*|MEADOW_WEB_BASE_URL=https://your-domain.com|' .env.prod

docker compose --env-file .env.prod up -d --wait
curl -fsS https://your-domain.com/healthz
```

`MEADOW_TRUSTED_PROXY_CIDR` must change at the same time as the proxy goes in. Left at
`127.0.0.1`, nothing arriving over the docker bridge matches, so every visitor shares
one rate-limit bucket because the peer is always nginx.

## 9. Sign-in providers (optional)

Blank client ids are a supported configuration: the button is hidden and the routes
404. To enable, register the apps against the public URL and fill in `.env.prod`:

- GitHub: github.com/settings/developers. One callback URL per app, so production
  needs its own app, separate from the local one.
- Google: console.cloud.google.com, APIs and Services, Credentials. Several redirect
  URIs are allowed per client, so the local client id can be reused once the
  production URI is added to it.

Callbacks are `https://your-domain.com/api/v1/auth/{github,google}/callback` and must
match what was registered character for character. Then `up -d --wait` again.

## 10. Wire up the release workflow

Repo settings, Environments, create `production`, then add secrets:

| Secret | Value |
|---|---|
| `VPS_HOST` | the server address |
| `VPS_USER` | `root` |
| `VPS_SSH_KEY` | private key whose public half is in the server's `authorized_keys` |
| `PUBLIC_URL` | `https://your-domain.com` |

Deploying afterwards is: run **ci** from Actions and read it, then run **release**.
Main only. Each release takes a verified dump, resets the checkout to `origin/main`,
rebuilds, and curls the public health endpoint.

---

## Operations

**Daily check.** The sidecar dumps every 24h and prunes after 7 days. Its healthcheck
watches the newest file rather than the process, because a backup job's failure mode is
running happily and producing nothing.

```bash
ls -lt /srv/meadow-backups | head
docker compose --env-file .env.prod ps backup     # healthy
```

**Restore.** Every dump is verified with `pg_restore --list` before it counts, so any
file present is readable.

```bash
docker compose --env-file .env.prod stop api worker
docker compose --env-file .env.prod exec -T postgres \
  pg_restore -U meadow -d meadow --clean --if-exists \
  < /srv/meadow-backups/meadow-20260906T120000Z.dump
docker compose --env-file .env.prod start api worker
```

**Roll back code.** Images are built on the box, so a rollback is a checkout plus a
rebuild:

```bash
git log --oneline -10
git reset --hard <sha>
docker compose --env-file .env.prod up -d --build --wait
```

A rollback that crosses a migration is not automatic. Alembic downgrades exist, but a
downgrade that drops a column does not put the data back. Restore the pre-deploy dump
instead, which is what the release workflow takes on every run.

**Logs.**

```bash
docker compose --env-file .env.prod logs -f api
docker compose --env-file .env.prod logs --tail 100 worker migrate
```

**Never run on this box.** `docker compose down -v` deletes `meadow_prod_pgdata`,
which is the database. `git clean` deletes `.env.prod`. Neither has a use here.
