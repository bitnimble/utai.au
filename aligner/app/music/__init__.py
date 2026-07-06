"""Music-source capability: search a user's streaming services and pull the
original audio, by wrapping OnTheSpot (its headless web API) behind the aligner.

`onthespot_client` speaks OnTheSpot's HTTP API; `facade` adds the cross-service
priority-merge, the fetch state machine, and account/config bookkeeping the raw
API doesn't; `routes` exposes it as the `/music/*` FastAPI surface. The facade is
transport-agnostic so the same logic can later back a stdio control-protocol op
for the desktop sidecar.
"""
