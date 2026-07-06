# Caddy edge proxy for the dev harness, with the Caddyfile baked in.
#
# A single-file bind-mount (./docker/Caddyfile -> /etc/caddy/Caddyfile) fails on
# some storage drivers ("mount a directory onto a file"), so COPY the config in
# instead. It's static proxy routing; `docker compose up --build caddy` picks up
# any edits.
FROM caddy:2
COPY docker/Caddyfile /etc/caddy/Caddyfile
