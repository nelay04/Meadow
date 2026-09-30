#!/bin/sh
# Write this deployment's public address into the static pages, at container start.
#
# The landing pages, sitemap, robots.txt and llms.txt need absolute URLs: a canonical
# link, og:url, structured data and a sitemap <loc> are all specified that way. Baking
# one address into the image would give every self-hosted copy someone else's canonical
# links, and one image built in CI has to serve any host. So the build leaves the
# placeholder `https://meadow.invalid` in them (`.invalid` is reserved and never
# resolves, so a page that somehow missed this points nowhere rather than at a real
# site), and this fills in MEADOW_WEB_BASE_URL, the same origin the API builds its
# links from.
#
# Run by the nginx image's entrypoint from /docker-entrypoint.d before nginx starts.
# The address is also written bare, without its scheme, where a page shows it as text.
#
# Unset: the placeholder is replaced with nothing, so every address becomes a path on
# whatever host served it. Canonical links and in-page links stay right; share
# previews and the sitemap need an origin and lose it. Degraded rather than wrong, and
# said in the log. A value that is not a plain origin stops the container instead,
# since it would be written into HTML and JSON verbatim.
#
# Idempotent: a restart of the same container finds no placeholder left and does
# nothing. A changed value recreates the container, which starts from the image again.

set -eu

html=/usr/share/nginx/html
placeholder='https://meadow.invalid'
url=${MEADOW_WEB_BASE_URL:-}
url=${url%/}

if [ -z "$url" ]; then
    echo "$0: MEADOW_WEB_BASE_URL is not set; pages get relative addresses, and share" \
        "previews and the sitemap will not work until it is" >&2
elif ! printf '%s' "$url" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$'; then
    echo "$0: MEADOW_WEB_BASE_URL must be a plain origin like https://meadow.example.com," \
        "got: $url" >&2
    exit 1
fi

host=${url#*://}

# Only files that carry the placeholder are rewritten, so the rest keep their mtime and
# with it their ETag. None of the built paths has a space in it.
find "$html" -type f \( -name '*.html' -o -name '*.txt' -o -name '*.xml' \) \
    -exec grep -lF "$placeholder" {} + |
    xargs -r sed -i -e "s|$placeholder|$url|g" -e "s|meadow\.invalid|$host|g"

echo "$0: pages address ${url:-(relative)}"
