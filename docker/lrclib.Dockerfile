# Self-hosted LRCLIB mirror for the dev harness. Builds the LRCLIB server
# (github.com/tranxuanthang/lrclib) from source, there's no prebuilt image, # then the entrypoint downloads + caches the SQLite db-dump on the mounted
# /data volume and serves it. The frontend queries this first and falls back to
# public lrclib.net (see frontend/src/lyrics/lrclib.ts + VITE_LRCLIB_URL).
#
# Mirrors the upstream repo's own multi-stage Dockerfile (Alpine + cargo).
FROM docker.io/rust:1.91-alpine3.22 AS builder
ARG LRCLIB_REF=main
RUN apk add --no-cache alpine-sdk git
WORKDIR /usr/src/lrclib-rs
RUN git clone --depth 1 --branch "${LRCLIB_REF}" https://github.com/tranxuanthang/lrclib.git . \
    && cargo build --release --workspace

FROM alpine:3.22
RUN apk add --no-cache sqlite curl ca-certificates
COPY --from=builder /usr/src/lrclib-rs/target/release/lrclib /usr/local/bin/lrclib
COPY docker/lrclib-entrypoint.sh /usr/local/bin/lrclib-entrypoint.sh
RUN chmod +x /usr/local/bin/lrclib-entrypoint.sh && mkdir /data
EXPOSE 3300
ENTRYPOINT ["/usr/local/bin/lrclib-entrypoint.sh"]
