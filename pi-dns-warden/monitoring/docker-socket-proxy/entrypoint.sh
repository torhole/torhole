#!/bin/sh
set -eu

# Alloy follows Docker container logs for the lifetime of each container.
# The upstream socket-proxy defaults both sides of every connection to ten
# minutes, which turns healthy long-lived log streams into recurring EOF
# warnings. Preserve the upstream endpoint allowlist, but give Docker log
# streams a one-week timeout. That avoids the ten-minute reconnect storm while
# still allowing abandoned streams to be reclaimed eventually.
template=/usr/local/etc/haproxy/haproxy.cfg.template

sed -i '/^frontend dockerfrontend$/a\
    timeout client 168h' "$template"

sed -i '/^backend docker-events$/i\
backend docker-log-streams\
    server dockersocket $SOCKET_PATH\
    timeout server 168h\
' "$template"

# Docker event streams are long-lived for the same reason. Replace the
# upstream infinite timeout with the same bounded week-long lifetime so
# HAProxy starts cleanly without a missing-timeout warning.
sed -i '/^backend docker-events$/,/^frontend dockerfrontend$/s/timeout server 0/timeout server 168h/' "$template"

sed -i '/^    use_backend docker-events/i\
    use_backend docker-log-streams if { path,url_dec -m reg -i ^(/v[\\d\\.]+)?/containers/[a-zA-Z0-9_.-]+/logs }' "$template"

exec /usr/local/bin/docker-entrypoint.sh "$@"
