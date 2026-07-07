# Caddy edge proxy for the dev harness, with the Caddyfile baked in.
#
# A single-file bind-mount (./docker/Caddyfile -> /etc/caddy/Caddyfile) fails on
# some storage drivers ("mount a directory onto a file"), so COPY the config in
# instead. It's static proxy routing; `docker compose up --build caddy` picks up
# any edits.
FROM caddy:2

# Self-signed TLS so the app is served over HTTPS -> a *secure context*, which
# browsers require for AudioWorklet (audio playback). Over a plain-HTTP LAN IP
# it isn't secure and playback breaks; localhost/127.0.0.1 are exempt but a
# remote LAN client can't use those. The cert's SANs cover localhost/127.0.0.1;
# for a LAN IP the browser shows a self-signed warning to click through once,
# which still yields a secure context. Regenerate with a LAN-IP SAN if you want
# to skip the warning.
RUN apk add --no-cache openssl \
    && openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
        -subj "/CN=utai-dev" \
        -addext "subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1" \
        -keyout /etc/caddy/selfsigned-key.pem \
        -out /etc/caddy/selfsigned-cert.pem

COPY docker/Caddyfile /etc/caddy/Caddyfile
