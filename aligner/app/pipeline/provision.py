"""Capability-scoped provisioning of model assets.

Every model the packaged app runs on is downloaded into `settings.models_dir`
here, and downloads are **capability-scoped**: `provision("separation")` fetches
only the separation assets, `provision("lyrics")` only what /lyrics needs, and so
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

import logging
import os
import sys
from dataclasses import dataclass
from pathlib import Path

import httpx

from app.config import settings

log = logging.getLogger(__name__)

_HTTP_TIMEOUT = httpx.Timeout(30.0, read=None)  # read=None: large weights

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


def _download(url: str, dest: Path) -> None:
    """Stream `url` to `dest`, atomically. No-op if `dest` already exists.

    HF `resolve/` URLs 302 to a CDN, so redirects are followed. Writes to a
    `.part` sidecar and renames on success so an interrupted download is never
    mistaken for a completed one on the next startup."""
    if dest.exists() and dest.stat().st_size > 0:
        log.info("provision: %s already present, skipping download", dest.name)
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    # pid-unique .part so concurrent provisioners don't clobber one temp file.
    tmp = dest.with_name(f"{dest.name}.{os.getpid()}.part")
    log.info("provision: downloading %s -> %s", url, dest.name)
    try:
        with httpx.stream("GET", url, follow_redirects=True, timeout=_HTTP_TIMEOUT) as resp:
            resp.raise_for_status()
            with open(tmp, "wb") as fh:
                for chunk in resp.iter_bytes(chunk_size=1 << 20):
                    fh.write(chunk)
            # Catch a silently-truncated transfer (proxy/CDN cutting the stream at EOF
            # without a protocol error). MUST use num_bytes_downloaded (raw/encoded)
            # vs Content-Length, NOT a sum of the chunks: iter_bytes yields DECODED
            # bytes, so a manual count false-positives on every gzip-encoded body.
            # Skip when Content-Length is absent/non-integer (chunked responses).
            declared = resp.headers.get("content-length")
            if declared is not None and declared.isdigit():
                expected = int(declared)
                got = resp.num_bytes_downloaded
                if got != expected:
                    raise OSError(
                        f"truncated download of {dest.name}: got {got} bytes, "
                        f"expected {expected}"
                    )
        tmp.replace(dest)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    log.info("provision: fetched %s (%d bytes)", dest.name, dest.stat().st_size)


def provision(*capabilities: str) -> None:
    """Download only the assets the given capabilities need (deduped by filename)
    into `settings.models_dir`. Idempotent.

    This is the capability-scoped entry point: NEVER fetch every model regardless
    of capability -- that defeats the dependency-group split (a separation-only
    install would pull the >1 GB lyrics models). Add a model to `_capability_assets`
    under the one capability that uses it."""
    models_dir = Path(settings.models_dir)
    models_dir.mkdir(parents=True, exist_ok=True)
    assets: dict[str, _Asset] = {}
    for capability in capabilities:
        for asset in _capability_assets(capability):
            assets[asset.filename] = asset
    for asset in assets.values():
        _download(asset.url, models_dir / asset.filename)
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
    """Provision the separation capability's assets (yaml + fp16 onnx). Called
    eagerly by `separate.py` so the separation stage's model is present."""
    provision("separation")


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


def main(argv: list[str]) -> int:
    """`python -m app.pipeline.provision <capability>...` -- pre-fetch the assets a
    freshly-installed capability needs, so they download at install time rather
    than on first use. The desktop installer runs this after `uv sync` with the
    capabilities it installed. Best-effort; lazy fallbacks still cover a failure.

    `python -m app.pipeline.provision --prune <keep-capability>...` -- the
    uninstall counterpart: delete model files not needed by the capabilities that
    remain installed (the desktop uninstaller runs this before syncing the venv
    down)."""
    logging.basicConfig(level=logging.INFO)
    if argv and argv[0] == "--prune":
        deprovision([g for g in argv[1:] if g in _KNOWN_CAPABILITIES])
        return 0
    provision(*[g for g in argv if g in _KNOWN_CAPABILITIES])
    return 0


if __name__ == "__main__":
    import sys

    raise SystemExit(main(sys.argv[1:]))
