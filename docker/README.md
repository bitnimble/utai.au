# Dev harness (music-source / OnTheSpot)

A throwaway docker-compose stack for developing the music-source feature: search
your streaming services and pull a track's audio into utai.au, via OnTheSpot.
**Dev only** (self-hosting a web build later is possible, but we don't host it).

## Run

The `web` + `backend` services bind-mount the repo (for hot reload). Set `REPO_PATH`
to the repo path **as the Docker daemon sees it**, normally the repo root, but it
must be explicit when the daemon has a different filesystem view (rootless / remote
/ sandboxed daemon), where a plain `.` mounts empty. Put it in a `.env` beside this
compose file (Compose auto-reads it) or export it; it defaults to `.`.

```sh
echo "REPO_PATH=$(pwd)" >> .env   # or the daemon-visible path
docker compose -f docker-compose.dev.yml up --build
```

Then open <https://localhost:5175> and refresh to pick up code changes (HTTPS
with a self-signed cert; click through the warning; it's required so audio
playback / AudioWorklet works when you reach the app over a LAN IP rather than
localhost). Backend Python edits hot-reload (uvicorn `--reload`); frontend edits
are picked up on a browser refresh (Vite over a repo bind-mount).

## Services

| Service | What | Notes |
|---|---|---|
| `caddy` | Edge proxy: app on `:5175` (the origin you use), OnTheSpot's own UI on `:5176` | `:5175` `/api`→backend, `/`→Vite (streams the fetch NDJSON Vite can't); `:5176`→OnTheSpot UI (its own origin, for interactive logins). |
| `web` | Vite dev server | Bind-mounts the repo; hot reload. |
| `backend` | Aligner (music facade) | Reuses the CUDA `utai-sandbox` image; runs in `WORKER_ROLE=api` (no GPU/model load for music). |
| `onthespot` | OnTheSpot headless web API | The thing the facade wraps. Config + credentials live in the `otsconfig` volume. |

## First-run checks

- **OnTheSpot web entrypoint.** The compose CMD tries `onthespot-web` then
  `python -m onthespot.web`. If OnTheSpot fails to start, exec in and find the
  right launch command (`docker compose -f docker-compose.dev.yml exec onthespot
  sh`, then `pip show -f onthespot`) and update `docker/onthespot.Dockerfile`.
- **Add an account.** In the app, open the music settings (gear). **YouTube
  Music** needs no sign-in (always available; searched automatically).
  Deezer/Qobuz/Apple Music/SoundCloud take a token or email+password.
  **Spotify** uses a paste-a-code OAuth: click *Sign in with Spotify*, approve
  in the tab, then paste the code (or the `127.0.0.1:5588` redirect URL it lands
  on) back into the dialog. **Tidal** opens OnTheSpot's own UI (its own origin on
  `:5176`); sign in there, then reopen the dialog.
- **Search + fetch.** Open "Add from streaming", search, pick a track, Fetch.
  The audio loads as a track in the timeline.

## Later: stem separation in this backend

The backend image is CUDA-capable (the sandbox stack). To run separation here,
set `WORKER_ROLE=pipeline` and give the `backend` service GPU access (`gpus: all`)
in `docker-compose.dev.yml`.
