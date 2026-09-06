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

`/etc/nginx/sites-available/meadow`, then `certbot --nginx -d your-domain.com` to add
the 443 block and the redirect.

The three locations are not decoration. The container has its own nginx with the same
split, and a single catch-all `location /` here breaks two features in ways that look
like application bugs: the sessions feed is server-sent events, which a buffering proxy
holds until the buffer fills, and `Connection: upgrade` on ordinary API calls breaks
keepalive. Mirror the split.

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 8m;

    # Server-sent events. Never finishes, so it needs buffering off and a timeout that
    # is not the 60s default, or the feed silently becomes a once-a-minute poll.
    location = /api/v1/auth/sessions/stream {
        proxy_pass http://127.0.0.1:8014;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header Connection        "";
        proxy_set_header X-Forwarded-For   $http_cf_connecting_ip;
        proxy_set_header X-Real-IP         $http_cf_connecting_ip;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # The CRDT websocket. Every edit rides this, and it is the only location that may
    # send an upgrade header.
    location /ws/ {
        proxy_pass http://127.0.0.1:8014;
        proxy_http_version 1.1;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $connection_upgrade;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $http_cf_connecting_ip;
        proxy_set_header X-Real-IP         $http_cf_connecting_ip;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:8014;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header Connection        "";
        proxy_set_header X-Forwarded-For   $http_cf_connecting_ip;
        proxy_set_header X-Real-IP         $http_cf_connecting_ip;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/meadow /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d your-domain.com
ufw allow 'Nginx Full' && ufw delete allow 8014/tcp
```

### Behind Cloudflare

`$http_cf_connecting_ip` above assumes Cloudflare is proxying. It is deliberate rather
than the usual `$proxy_add_x_forwarded_for`.

Cloudflare sets `X-Forwarded-For` to the client, and appending here would make it
`<client>, <cloudflare edge>`. The container reads the **last** entry, by design, so it
would record a Cloudflare datacenter as the client: rate limits would bucket per edge
rather than per user, and session logs would name Marseille. `CF-Connecting-IP` is a
single value and survives the last-entry rule intact.

That header is only trustworthy while Cloudflare is the only thing that can reach the
origin. Close the gap:

```bash
for ip in $(curl -s https://www.cloudflare.com/ips-v4); do
    ufw allow from $ip to any port 443 proto tcp
done
ufw delete allow 'Nginx Full'
ufw allow 80/tcp      # certbot renewals
```

If you are **not** using Cloudflare, replace both `$http_cf_connecting_ip` with
`$proxy_add_x_forwarded_for` in the `X-Forwarded-For` lines and `$remote_addr` in the
`X-Real-IP` lines.

## 8. Tighten back up

```bash
sed -i 's|^WEB_BIND=.*|WEB_BIND=127.0.0.1|' .env.prod
sed -i 's|^MEADOW_REFRESH_COOKIE_SECURE=.*|MEADOW_REFRESH_COOKIE_SECURE=true|' .env.prod
sed -i 's|^MEADOW_TRUSTED_PROXY_CIDR=.*|MEADOW_TRUSTED_PROXY_CIDR=172.28.0.1|' .env.prod
sed -i 's|^MEADOW_WEB_BASE_URL=.*|MEADOW_WEB_BASE_URL=https://your-domain.com|' .env.prod

docker compose --env-file .env.prod up -d --wait
curl -fsS https://your-domain.com/healthz
```

All four matter, and three of them fail quietly:

- `MEADOW_TRUSTED_PROXY_CIDR` must change at the same time the proxy goes in. Left at
  `127.0.0.1`, nothing arriving over the docker bridge matches, so every visitor shares
  one rate-limit bucket. `rate_limit_login` is `5/60`, so a handful of sign-ins from
  anyone starts refusing everyone.
- `MEADOW_WEB_BASE_URL` blank produces malformed share links, invitations and
  activation mail. Nothing errors; the URLs are just wrong.
- `MEADOW_REFRESH_COOKIE_SECURE` false over HTTPS is a live credential on the wire.

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

Secrets go on **this** repository, not another one. An empty `VPS_SSH_KEY` fails in
about three seconds with "can't connect without a private SSH key or password", which
reads like a network problem and is not. `VPS_SSH_KEY` is the whole private key file,
`-----BEGIN-----` and `-----END-----` lines included, from a key with no passphrase.

Deploying afterwards is: run **ci** from Actions and read it, then run **release**.
Main only. Each release takes a verified dump, resets the checkout to `origin/main`,
rebuilds, and curls the public health endpoint.

### Deploying by hand

The same thing without Actions, for when the workflow is not set up yet. Take the dump
first; that is the whole point of it.

```bash
cd /root/Projects/Python/Meadow
docker compose --env-file .env.prod run --rm --entrypoint sh backup -c '
  set -eu
  target="/backups/meadow-predeploy-$(date -u +%Y%m%dT%H%M%SZ).dump"
  pg_dump --format=custom --compress=6 --file="$target.partial"
  pg_restore --list "$target.partial" > /dev/null
  mv "$target.partial" "$target"
  echo "verified: $target"
'
git pull
docker compose --env-file .env.prod up -d --build --wait
docker compose --env-file .env.prod ps
```

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

---

## Troubleshooting

Everything here was hit on the first real deploy.

**API container restarts, `ModuleNotFoundError` in its logs.** `uv.lock` has drifted
from `pyproject.toml`, so a runtime dependency was never installed. The Dockerfile now
uses `uv sync --locked`, which fails the build instead, but if you see it: run
`uv lock` in `services/api`, commit the lockfile, rebuild. `--frozen` would install the
stale lock silently and only fail at import time, in production.

**502 from the edge, containers all healthy.** The host nginx and `WEB_PUBLIC_PORT`
disagree. `docker compose --env-file .env.prod ps` shows what the web container is
actually published on; it must match `proxy_pass`. Changing the port needs `up -d`, not
a reload, because the container is recreated.

**Live session updates never arrive.** The host nginx is buffering the SSE stream. It
needs its own `location = /api/v1/auth/sessions/stream` with `proxy_buffering off`, per
step 7. A single catch-all `location /` cannot do this.

**Boards load but never sync.** The websocket is not upgrading. `location /ws/` needs
`Upgrade` and `Connection $connection_upgrade`, and that `map` block must be outside
the `server` block.

**Signed out on every page reload.** Fixed in `42955c5`. Two page contexts are briefly
alive during a reload and both refresh, so the loser presented an already-rotated token
and the server read it as theft. `MEADOW_REFRESH_ROTATION_GRACE_SECONDS` (default 10)
is the window in which a replay is treated as the same browser asking twice. Confirm it
is live:

```bash
docker compose --env-file .env.prod exec api \
  python -c "from app.config import settings; print(settings.refresh_rotation_grace_seconds)"
```

**"This session was terminated from another device" after signing in elsewhere.** A
login publishes to every open sessions stream, and each one re-checks its own family.
A browser whose family had already been revoked only discovers it at that moment, so
this is usually the symptom above surfacing late rather than a new fault. Families
already revoked stay revoked: clear site data and sign in again in each browser.

**Rate limits rejecting everyone.** `MEADOW_TRUSTED_PROXY_CIDR` is still `127.0.0.1`
while a proxy sits in front, so every visitor shares one bucket. Set it to `172.28.0.1`.
