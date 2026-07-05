"""Load a BS-Roformer checkpoint from a (ckpt, yaml) pair without importing
`audio-separator`.

Mirrors audio-separator's roformer loading path:
`architectures/mdxc_separator.py::MDXCSeparator.load_model` (the `is_roformer`
branch) -> `roformer/roformer_loader.py::RoformerLoader` ->
`roformer/configuration_normalizer.py`. The yaml `model:` section is flattened,
parameter-name aliases are mapped, defaults are applied, then a fixed set of
kwargs is handed to `BSRoformer(**kwargs)`. We reproduce the same kwarg
selection; see `_BS_DEFAULTS` / `_BS_ALIASES`.

The yaml is read exactly as audio-separator does in
`separator.py::load_model_data_from_yaml` (`yaml.FullLoader`).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import torch
import yaml
from ml_collections import ConfigDict

from .architectures.bs_roformer import BSRoformer


@dataclass
class LoadedModel:
    """A loaded separation model plus the config metadata the runner needs.

    `kind` is always "bs_roformer". `config` is the parsed yaml as a
    `ConfigDict` (the runner reads `audio`/`inference`/`training` from it).
    `instruments` is the ordered output-stem list. `target_instrument` is set
    only for single-target models (None for the multi-stem SW model).
    """

    model: torch.nn.Module
    kind: str
    config: ConfigDict
    instruments: list[str]
    target_instrument: str | None


def load_yaml(yaml_path: str | Path) -> dict:
    with open(yaml_path, encoding="utf-8") as fh:
        return yaml.load(fh, Loader=yaml.FullLoader)


def load_model(
    ckpt_path: str | Path,
    yaml_path: str | Path,
    *,
    device: str | torch.device = "cpu",
) -> LoadedModel:
    model_data = load_yaml(yaml_path)
    if not _is_bs_roformer(str(yaml_path), str(ckpt_path), model_data):
        raise ValueError(
            f"unsupported separation model {Path(ckpt_path).name!r}: only BS-Roformer "
            "is supported (config must carry a roformer name or `freqs_per_bands`)"
        )
    return _load_bs_roformer(ckpt_path, model_data, device)


def _is_bs_roformer(yaml_path: str, ckpt_path: str, model_data: dict) -> bool:
    haystack = (yaml_path + " " + ckpt_path).lower()
    if "roformer" in haystack:
        return True
    return "freqs_per_bands" in model_data.get("model", {})


# ---- BS-Roformer -------------------------------------------------------

# audio-separator's RoformerLoader flattens the yaml `model:` section, maps a
# handful of parameter-name aliases, then BSRoformer is built from this exact
# kwarg set (roformer_loader.py::_create_bs_roformer). Anything not in this set
# (e.g. linear_transformer_depth, dim_freqs_in, stft_normalized, the
# multi_stft_* keys, mask_estimator_depth) falls through to the BSRoformer
# constructor defaults -- matching upstream, which also does not forward them.
_BS_ALIASES = {
    "n_fft": "stft_n_fft",
    "hop_length": "stft_hop_length",
    "win_length": "stft_win_length",
    "n_heads": "heads",
    "num_heads": "heads",
    "head_dim": "dim_head",
}

_BS_DEFAULTS = {
    "stereo": False,
    "num_stems": 2,
    "time_transformer_depth": 2,
    "freq_transformer_depth": 2,
    "dim_head": 64,
    "heads": 8,
    "attn_dropout": 0.0,
    "ff_dropout": 0.0,
    "flash_attn": True,
    "mlp_expansion_factor": 4,
    "sage_attention": False,
    "zero_dc": True,
    "use_torch_checkpoint": False,
    "skip_connection": False,
}


def _load_bs_roformer(
    ckpt_path: str | Path, model_data: dict, device: str | torch.device
) -> LoadedModel:
    cfg = _flatten_model_section(model_data)
    cfg = {_BS_ALIASES.get(k, k): v for k, v in cfg.items()}
    if isinstance(cfg.get("freqs_per_bands"), list):
        cfg["freqs_per_bands"] = tuple(cfg["freqs_per_bands"])

    kwargs = {**_BS_DEFAULTS, **{k: cfg[k] for k in _BS_DEFAULTS if k in cfg}}
    kwargs["dim"] = cfg["dim"]
    kwargs["depth"] = cfg["depth"]
    kwargs["freqs_per_bands"] = cfg["freqs_per_bands"]
    for key in ("stft_n_fft", "stft_hop_length", "stft_win_length"):
        if key in cfg:
            kwargs[key] = cfg[key]

    model = BSRoformer(**kwargs)
    state = torch.load(str(ckpt_path), map_location="cpu")
    state = _unwrap_state_dict(state)
    model.load_state_dict(state, strict=True)
    model.to(device).eval()

    config = ConfigDict(model_data)
    instruments = list(config.training.instruments)
    target = config.training.target_instrument
    return LoadedModel(
        model=model,
        kind="bs_roformer",
        config=config,
        instruments=instruments,
        target_instrument=target,
    )


def _flatten_model_section(config: dict) -> dict:
    """Replicate ConfigurationNormalizer._normalize_structure for the keys
    BSRoformer reads: lift the nested `model:`/`architecture:`/`params:`
    section up to the top level."""
    flat: dict = {}
    for key, value in config.items():
        if isinstance(value, dict) and key in ("model", "architecture", "params"):
            flat.update(value)
        elif key not in ("training", "inference", "audio", "augmentations", "loss_multistft"):
            flat[key] = value
    return flat


def _unwrap_state_dict(state: dict) -> dict:
    """Match RoformerLoader / mdxc_separator: a checkpoint may be a bare
    state_dict or wrapped under a `state_dict` / `model` key."""
    if isinstance(state, dict) and "state_dict" in state:
        return state["state_dict"]
    if isinstance(state, dict) and "model" in state and isinstance(state["model"], dict):
        return state["model"]
    return state
