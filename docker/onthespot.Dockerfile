# OnTheSpot headless web API for the utai dev music-source harness.
#
# Small, CPU-only: OnTheSpot + ffmpeg. The aligner backend's music facade proxies
# this over HTTP. Login is off by default (OnTheSpot's `use_webui_login`), so it
# serves every request as the `guest` user with no auth handshake.
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Same commit as the aligner's `onthespot` dependency group: the launcher below
# patches this version's downloader source.
RUN pip install --no-cache-dir "git+https://github.com/justin025/onthespot.git@7f7e04d883dc2d12499e6a0f9a80a09116cf69f7"

# The launcher the desktop app runs too. `--check` fails the build if an
# upstream change stops its patches applying.
COPY aligner/app/music/onthespot_server.py /opt/onthespot_server.py
RUN python /opt/onthespot_server.py --check

# OnTheSpot reads/writes its config (account pool + credentials) here; the compose
# shares this dir with the backend so the facade can read the account pool.
ENV ONTHESPOTDIR=/config
VOLUME ["/config"]

EXPOSE 5000

CMD ["python", "/opt/onthespot_server.py", "--host", "0.0.0.0", "--port", "5000"]
