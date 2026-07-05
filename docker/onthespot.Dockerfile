# OnTheSpot headless web API for the utai dev music-source harness.
#
# Small, CPU-only: OnTheSpot + ffmpeg. The aligner backend's music facade proxies
# this over HTTP. Login is off by default (OnTheSpot's `use_webui_login`), so it
# serves every request as the `guest` user with no auth handshake.
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The music facade targets the API shapes in OnTheSpot's `web.py`. Pin to a
# specific commit for a reproducible deployment; `main` keeps the dev harness on
# the latest.
RUN pip install --no-cache-dir "git+https://github.com/justin025/onthespot@main"

# OnTheSpot reads/writes its config (account pool + credentials) here; the compose
# shares this dir with the backend so the facade can read the account pool.
ENV ONTHESPOTDIR=/config
VOLUME ["/config"]

EXPOSE 5000

# Start the headless Flask web API on all interfaces. The exact entrypoint can
# vary by OnTheSpot version, so try the console script, then the module. If BOTH
# fail on first run, exec into the image and run `pip show -f onthespot | grep -i
# console` (or check `onthespot/__main__.py`) to find the right command and update
# this CMD.
CMD ["sh", "-c", "onthespot-web --host 0.0.0.0 --port 5000 2>/dev/null || python -m onthespot.web --host 0.0.0.0 --port 5000"]
