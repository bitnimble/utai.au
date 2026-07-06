"""Load a Mel-Band Roformer checkpoint from a (ckpt, yaml) pair.

The yaml `model:` section is handed (after alias mapping + tuple coercion) to
`MelBandRoformer(**kwargs)`, filtered to the constructor's parameters so extra
training-only keys (loss weights, etc.) are ignored. The yaml is read exactly as
audio-separator does (`yaml.FullLoader`).
"""

from __future__ import annotations

import inspect
from dataclasses import dataclass
from pathlib import Path

import torch
import yaml
from ml_collections import ConfigDict

from .architectures.mel_band_roformer import MelBandRoformer


@dataclass
class LoadedModel:
    """A loaded separation model plus the config metadata the runner needs.

    `kind` is always "mel_band_roformer". `config` is the parsed yaml as a
    `ConfigDict` (the runner reads `audio`/`inference`/`training` from it).
    `instruments` is the ordered output-stem list. `target_instrument` is set
    only for single-target models (the vocals model)."""

    model: torch.nn.Module
    kind: str
    config: ConfigDict
    instruments: list[str]
    target_instrument: str | None


def load_yaml(yaml_path: str | Path) -> dict:
    with open(yaml_path, encoding="utf-8") as fh:
        return yaml.load(fh, Loader=yaml.FullLoader)


# audio-separator-style parameter-name aliases mapped onto the MelBandRoformer kwargs.
_ALIASES = {
    "n_fft": "stft_n_fft",
    "hop_length": "stft_hop_length",
    "win_length": "stft_win_length",
    "n_heads": "heads",
    "num_heads": "heads",
    "head_dim": "dim_head",
}


def load_model(
    ckpt_path: str | Path,
    yaml_path: str | Path,
    *,
    device: str | torch.device = "cpu",
) -> LoadedModel:
    model_data = load_yaml(yaml_path)
    if not _is_mel_band_roformer(str(yaml_path), str(ckpt_path), model_data):
        raise ValueError(
            f"unsupported separation model {Path(ckpt_path).name!r}: only Mel-Band Roformer "
            "is supported (config must carry a roformer name or `num_bands`)"
        )
    return _load_mel_band_roformer(ckpt_path, model_data, device)


def _is_mel_band_roformer(yaml_path: str, ckpt_path: str, model_data: dict) -> bool:
    haystack = (yaml_path + " " + ckpt_path).lower()
    if "roformer" in haystack:
        return True
    return "num_bands" in model_data.get("model", {})


def _load_mel_band_roformer(
    ckpt_path: str | Path, model_data: dict, device: str | torch.device
) -> LoadedModel:
    cfg = {_ALIASES.get(k, k): v for k, v in model_data.get("model", {}).items()}
    for k, v in list(cfg.items()):  # yaml lists -> tuples where the constructor expects them
        if isinstance(v, list):
            cfg[k] = tuple(v)

    accepted = set(inspect.signature(MelBandRoformer.__init__).parameters) - {"self"}
    kwargs = {k: v for k, v in cfg.items() if k in accepted}

    model = MelBandRoformer(**kwargs)
    state = _unwrap_state_dict(torch.load(str(ckpt_path), map_location="cpu"))
    model.load_state_dict(state, strict=True)
    model.to(device).eval()

    config = ConfigDict(model_data)
    instruments = list(config.training.instruments)
    target = config.training.get("target_instrument")
    return LoadedModel(
        model=model,
        kind="mel_band_roformer",
        config=config,
        instruments=instruments,
        target_instrument=target,
    )


def _unwrap_state_dict(state: dict) -> dict:
    """A checkpoint may be a bare state_dict or wrapped under `state_dict` / `model`."""
    if isinstance(state, dict) and "state_dict" in state:
        return state["state_dict"]
    if isinstance(state, dict) and "model" in state and isinstance(state["model"], dict):
        return state["model"]
    return state
