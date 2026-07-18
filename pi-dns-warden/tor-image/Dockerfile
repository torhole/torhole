FROM debian:bookworm-slim

ARG TOR_DISTRO=bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg netcat-openbsd \
 && mkdir -p /usr/share/keyrings /etc/apt/sources.list.d \
 && curl -fsSL https://deb.torproject.org/torproject.org/A3C4F0F979CAA22CDBA8F512EE8CBC9E886DDD89.asc \
    | gpg --dearmor -o /usr/share/keyrings/deb.torproject.org-keyring.gpg \
 && printf '%s\n' \
    "deb [signed-by=/usr/share/keyrings/deb.torproject.org-keyring.gpg] https://deb.torproject.org/torproject.org ${TOR_DISTRO} main" \
    "deb-src [signed-by=/usr/share/keyrings/deb.torproject.org-keyring.gpg] https://deb.torproject.org/torproject.org ${TOR_DISTRO} main" \
    > /etc/apt/sources.list.d/tor.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends tor tor-geoipdb deb.torproject.org-keyring \
 && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /var/lib/tor /run/tor /etc/tor \
 && chown -R debian-tor:debian-tor /var/lib/tor /run/tor /etc/tor

USER debian-tor

STOPSIGNAL SIGINT

CMD ["tor", "-f", "/etc/tor/torrc"]
