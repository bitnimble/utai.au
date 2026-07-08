"""Capability-scoped provisioning of model assets.

Every model the packaged app runs on is downloaded into `settings.models_dir`
here, and downloads are **capability-scoped**: `provision("separation")` fetches
only the separation assets, `provision("lyrics")` only what /music needs, and so
on. This is the whole point of the dependency-group split -- a user who installs
one capability must never pull another capability's weights (the lyrics models
alone are >1 GB). The capability -> asset map mirrors the pyproject
dependency-groups, where `lyrics` composes `separation`.

Shipped runtime assets = the fp16 `.onnx` bodies plus the small sidecars they
need: the separation architecture yamls (STFT params the numpy path reads) and
the CTC aligner bodies. All come from the one
`settings.onnx_repo`. The heavy torch `.ckpt`s are NOT fetched -- the
shipped runtime is torch-free and loads the onnx; a dev checkout exports locally
from ckpts already in its `models_dir`.

Every URL / HF id is a `settings.*` field (see config.py "Model asset sources"),
so a build can repoint them without code changes.
"""
from __future__ import annotations

import json
import logging
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import httpx

from app.config import settings

log = logging.getLogger(__name__)

_HTTP_TIMEOUT = httpx.Timeout(30.0, read=None)  # read=None: large weights
# Emit a download-progress event roughly every this many decoded bytes.
_PROGRESS_TICK_BYTES = 4 * 1024 * 1024


@dataclass(frozen=True)
class ProvisionEvent:
    """One progress tick for a single asset during provisioning. `checking` =
    verifying the local copy against the remote ETag; `downloading` carries
    `bytes_done`/`bytes_total`; `done` = freshly downloaded; `skipped` = already
    up to date (or present but unverifiable, e.g. offline)."""

    asset: str
    phase: str  # "checking" | "downloading" | "done" | "skipped"
    bytes_done: int | None = None
    bytes_total: int | None = None


ProgressFn = Callable[[ProvisionEvent], None]

# ckpt -> paired architecture yaml (a bare state_dict can't load without it).
_CKPT_YAML: dict[str, str] = {
    "model_mel_band_roformer.ckpt": "config_mel_band_roformer.yaml",
}


def yaml_for_ckpt(ckpt_filename: str) -> str:
    """Local yaml filename paired with a separation ckpt filename."""
    try:
        return _CKPT_YAML[ckpt_filename]
    except KeyError:
        raise KeyError(f"no yaml registered for ckpt {ckpt_filename!r}") from None


@dataclass(frozen=True)
class _Asset:
    """One downloadable file: local name under models_dir + its source URL."""

    filename: str
    url: str


def _onnx(name: str) -> _Asset:
    return _Asset(name, f"{settings.onnx_repo}/{name}")


def _sep_onnx_asset(stem: str) -> _Asset:
    """The onnx body for the Mel-Band Roformer separator stem, saved under the canonical
    local name `{stem}.fp16.onnx` (what the loader looks up; both variants execute fp16).
    Ships two platform-specific variants -- `.coreml.fp16.` (macOS ANE, plain fp16) and
    `.cuda.int8.` (weight-only int8 on disk for the CUDA/TensorRT/DirectML EPs: ~half the
    download, fp16 execution, fp32 RMSNorm) -- that must never be cross-used, so the remote
    file is chosen by platform while the local name stays canonical."""
    variant = "coreml" if sys.platform == "darwin" else "cuda"
    fmt = "fp16" if variant == "coreml" else "int8"
    return _Asset(f"{stem}.fp16.onnx", f"{settings.onnx_repo}/{stem}.{variant}.{fmt}.onnx")


def _separation_assets() -> list[_Asset]:
    """The vocals separator body (fp16 onnx) + its yaml. No ckpt (the shipped
    runtime uses the onnx). Name derives from `settings.demucs_model`."""
    ckpt = settings.demucs_model
    return [_onnx(yaml_for_ckpt(ckpt)), _sep_onnx_asset(Path(ckpt).stem)]


def _lyrics_assets() -> list[_Asset]:
    return [
        _onnx(f"ctc_align__{m.replace('/', '__')}.fp16.onnx")
        for m in (settings.lyrics_align_model_english, settings.lyrics_align_model_default)
    ]


def _pitch_assets() -> list[_Asset]:
    """The f0 models off `onnx_repo`, shipped as-is (fp32): RMVPE (offline stem
    pass) + SwiftF0 (live-mic path)."""
    return [_onnx(settings.pitch_model_offline), _onnx(settings.pitch_model_live)]


_KNOWN_CAPABILITIES = ("separation", "lyrics", "pitch")


def _capability_assets(capability: str) -> list[_Asset]:
    """Assets one capability needs. `lyrics` and `pitch` each compose
    `separation` (both run over the vocals stem), mirroring the pyproject
    dependency-groups."""
    if capability == "separation":
        return _separation_assets()
    if capability == "lyrics":
        return _separation_assets() + _lyrics_assets()
    if capability == "pitch":
        return _separation_assets() + _pitch_assets()
    return []


def _emit(on_progress: ProgressFn | None, event: ProvisionEvent) -> None:
    if on_progress is None:
        return
    try:
        on_progress(event)
    except Exception:
        log.debug("provision: progress callback raised", exc_info=True)


def _norm_etag(raw: str) -> str:
    """Strip the weak-validator prefix + surrounding quotes off an ETag header."""
    v = raw.strip()
    if v.startswith("W/"):
        v = v[2:]
    return v.strip('"')


def _etag_path(dest: Path) -> Path:
    return dest.with_name(f"{dest.name}.etag")


def _read_etag(dest: Path) -> str | None:
    try:
        return _etag_path(dest).read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def _write_etag(dest: Path, etag: str) -> None:
    try:
        _etag_path(dest).write_text(etag, encoding="utf-8")
    except OSError:
        log.debug("provision: could not write etag for %s", dest.name, exc_info=True)


def _pick_etag(resp: httpx.Response) -> str | None:
    """HuggingFace's `X-Linked-Etag` (the LFS content hash, on the pre-redirect
    `resolve/` response) if present, else the final response's `ETag`."""
    for r in (*getattr(resp, "history", ()), resp):
        raw = r.headers.get("x-linked-etag") or r.headers.get("etag")
        if raw:
            return _norm_etag(raw)
    return None


def _remote_meta(url: str) -> tuple[str, int | None] | None:
    """`(etag, size)` for a remote asset via HEAD (following redirects), or None
    if the remote can't be reached / doesn't exist (offline, 404)."""
    try:
        resp = httpx.head(url, follow_redirects=True, timeout=_HTTP_TIMEOUT)
        resp.raise_for_status()
    except Exception:
        return None
    etag = _pick_etag(resp)
    if etag is None:
        return None
    size = resp.headers.get("content-length")
    return etag, (int(size) if size is not None and size.isdigit() else None)


def _download(
    url: str,
    dest: Path,
    *,
    update_check: bool = True,
    on_progress: ProgressFn | None = None,
) -> None:
    """Stream `url` to `dest`, atomically, if it's absent or out of date.

    When `update_check`, a present file is verified against the remote ETag
    (stored in a `<name>.etag` sidecar; HF sets it to the LFS content hash) and
    re-downloaded only on change; so a pushed model update lands on next launch.
    An unreachable remote (offline, or a 404) leaves a present file untouched. A
    present-but-untracked file whose size matches the remote adopts the etag
    without re-downloading. HF `resolve/` URLs 302 to a CDN, so redirects are
    followed; writes to a `.part` sidecar and renames on success so an
    interrupted download is never mistaken for a completed one."""
    name = dest.name
    if dest.exists() and dest.stat().st_size > 0:
        if not update_check:
            _emit(on_progress, ProvisionEvent(name, "skipped"))
            return
        _emit(on_progress, ProvisionEvent(name, "checking"))
        meta = _remote_meta(url)
        if meta is None:
            log.info("provision: %s present, remote unreachable to verify; keeping", name)
            _emit(on_progress, ProvisionEvent(name, "skipped"))
            return
        remote_etag, remote_size = meta
        local_etag = _read_etag(dest)
        if local_etag is not None and local_etag == remote_etag:
            _emit(on_progress, ProvisionEvent(name, "skipped"))
            return
        if local_etag is None and remote_size is not None and dest.stat().st_size == remote_size:
            # Present but never tracked (pre-mounted volume, pre-etag download):
            # adopt the remote etag by size match rather than re-fetch a good file.
            _write_etag(dest, remote_etag)
            _emit(on_progress, ProvisionEvent(name, "skipped"))
            return
        log.info("provision: %s changed upstream, re-downloading", name)

    dest.parent.mkdir(parents=True, exist_ok=True)
    # pid-unique .part so concurrent provisioners don't clobber one temp file.
    tmp = dest.with_name(f"{name}.{os.getpid()}.part")
    log.info("provision: downloading %s -> %s", url, name)
    try:
        with httpx.stream("GET", url, follow_redirects=True, timeout=_HTTP_TIMEOUT) as resp:
            resp.raise_for_status()
            declared = resp.headers.get("content-length")
            total = int(declared) if declared is not None and declared.isdigit() else None
            _emit(on_progress, ProvisionEvent(name, "downloading", 0, total))
            done = 0
            next_tick = _PROGRESS_TICK_BYTES
            with open(tmp, "wb") as fh:
                for chunk in resp.iter_bytes(chunk_size=1 << 20):
                    fh.write(chunk)
                    done += len(chunk)
                    if done >= next_tick:
                        _emit(on_progress, ProvisionEvent(name, "downloading", done, total))
                        next_tick = done + _PROGRESS_TICK_BYTES
            # Catch a silently-truncated transfer (proxy/CDN cutting the stream at EOF
            # without a protocol error). MUST use num_bytes_downloaded (raw/encoded)
            # vs Content-Length, NOT a sum of the chunks: iter_bytes yields DECODED
            # bytes, so a manual count false-positives on every gzip-encoded body.
            # Skip when Content-Length is absent/non-integer (chunked responses).
            if total is not None:
                got = resp.num_bytes_downloaded
                if got != total:
                    raise OSError(
                        f"truncated download of {name}: got {got} bytes, expected {total}"
                    )
            etag = _pick_etag(resp)
        tmp.replace(dest)
        if etag is not None:
            _write_etag(dest, etag)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    size = dest.stat().st_size
    log.info("provision: fetched %s (%d bytes)", name, size)
    _emit(on_progress, ProvisionEvent(name, "done", size, size))


def planned_assets(*capabilities: str) -> list[str]:
    """Deduped local filenames the given capabilities will provision, in a stable
    order. Lets a caller (the startup status) seed its per-asset progress before
    the download loop runs."""
    seen: dict[str, None] = {}
    for capability in capabilities:
        for asset in _capability_assets(capability):
            seen[asset.filename] = None
    return list(seen)


def provision(
    *capabilities: str,
    update_check: bool | None = None,
    on_progress: ProgressFn | None = None,
) -> None:
    """Download only the assets the given capabilities need (deduped by filename)
    into `settings.models_dir`, re-fetching any that changed upstream. Idempotent.

    `update_check` defaults to `settings.provision_update_check`; pass False to
    skip the per-asset remote verification (presence-only). `on_progress` receives
    a {@link ProvisionEvent} per asset transition.

    This is the capability-scoped entry point: NEVER fetch every model regardless
    of capability -- that defeats the dependency-group split (a separation-only
    install would pull the >1 GB lyrics models). Add a model to `_capability_assets`
    under the one capability that uses it."""
    if update_check is None:
        update_check = settings.provision_update_check
    models_dir = Path(settings.models_dir)
    models_dir.mkdir(parents=True, exist_ok=True)
    assets: dict[str, _Asset] = {}
    for capability in capabilities:
        for asset in _capability_assets(capability):
            assets[asset.filename] = asset
    for asset in assets.values():
        _download(
            asset.url,
            models_dir / asset.filename,
            update_check=update_check,
            on_progress=on_progress,
        )
    log.info("provision: %d assets ready in %s for %s", len(assets), models_dir, list(capabilities))


def deprovision(keep_capabilities: list[str]) -> int:
    """Delete provisioned model files that no longer belong to any installed
    capability, freeing disk on uninstall. Returns the count removed.

    Only ever touches files in the known capability -> asset map: it removes
    `union(all capabilities' assets) - union(keep_capabilities' assets)`, so a
    weight shared with a still-installed capability (e.g. the separation body
    under a kept `lyrics`, which composes separation) is preserved, and no
    unrelated file under `models_dir` (caches, user data) is at risk. Idempotent."""
    keep = {a.filename for cap in keep_capabilities for a in _capability_assets(cap)}
    everything = {a.filename for cap in _KNOWN_CAPABILITIES for a in _capability_assets(cap)}
    models_dir = Path(settings.models_dir)
    removed = 0
    for filename in sorted(everything - keep):
        path = models_dir / filename
        if path.exists():
            log.info("deprovision: removing %s", filename)
            path.unlink()
            removed += 1
    log.info("deprovision: removed %d files, kept capabilities %s", removed, keep_capabilities)
    return removed


def provision_custom_models() -> None:
    """Ensure the separation capability's assets (yaml + fp16 onnx) are present.
    Called eagerly by `separate.py` on model load. Presence-only: the startup
    provisioning pass owns update-checks, so a separator load never blocks on a
    per-asset network round-trip."""
    provision("separation", update_check=False)


def provisioned_file(filename: str) -> Path | None:
    """Path to a provisioned asset `filename` under `settings.models_dir` if
    present + non-empty, else None."""
    path = Path(settings.models_dir) / filename
    return path if path.exists() and path.stat().st_size > 0 else None


def shipped_onnx(name: str) -> Path | None:
    """Path to the shipped fp16 onnx `{name}.fp16.onnx` if present, else None.
    Loaders use this to prefer the downloaded weights and skip the local
    (torch-dependent) export."""
    return provisioned_file(f"{name}.fp16.onnx")


def allow_local_export() -> bool:
    """Dev-only opt-in to export a missing fp16 onnx from a local ckpt (needs
    torch). OFF by default: the shipped app is torch-free at inference and must run
    only PROVISIONED onnx, so a missing model is a hard error (reinstall the
    capability), never a silent multi-minute runtime torch export on the user's
    machine. fp16 conversion is a build-time step we ship, not something the user
    does."""
    return os.environ.get("UTAI_ALLOW_LOCAL_EXPORT", "").strip().lower() in (
        "1", "true", "yes", "on",
    )


def missing_shipped_onnx(name: str) -> RuntimeError:
    """The error a loader raises when a provisioned model is absent and local
    export isn't permitted (the shipped path). Actionable, not a stack trace."""
    return RuntimeError(
        f"Model '{name}.fp16.onnx' is not provisioned. Reinstall the capability "
        "that provides it from Settings -> Capabilities to download it. "
        "(Dev: set UTAI_ALLOW_LOCAL_EXPORT=1 to export it locally from a ckpt.)"
    )


def _json_line_emitter() -> ProgressFn:
    """Progress callback that prints one JSON line per event, for a parent process
    (the desktop Rust broker) to parse into structured progress."""

    def emit(ev: ProvisionEvent) -> None:
        print(
            json.dumps(
                {
                    "asset": ev.asset,
                    "phase": ev.phase,
                    "bytesDone": ev.bytes_done,
                    "bytesTotal": ev.bytes_total,
                }
            ),
            flush=True,
        )

    return emit


def main(argv: list[str]) -> int:
    """`python -m app.pipeline.provision [--progress-json] <capability>...` --
    pre-fetch (and update-check) the assets the given capabilities need, so they
    download at install/launch time rather than on first use. The desktop shell
    runs this after `uv sync`. `--progress-json` streams one JSON progress event
    per line for the parent to parse. Best-effort; lazy fallbacks still cover a
    failure.

    `python -m app.pipeline.provision --prune <keep-capability>...` -- the
    uninstall counterpart: delete model files not needed by the capabilities that
    remain installed (the desktop uninstaller runs this before syncing the venv
    down)."""
    logging.basicConfig(level=logging.INFO)
    args = [a for a in argv if a != "--progress-json"]
    on_progress = _json_line_emitter() if "--progress-json" in argv else None
    if args and args[0] == "--prune":
        deprovision([g for g in args[1:] if g in _KNOWN_CAPABILITIES])
        return 0
    provision(*[g for g in args if g in _KNOWN_CAPABILITIES], on_progress=on_progress)
    return 0


if __name__ == "__main__":
    import sys

    raise SystemExit(main(sys.argv[1:]))
