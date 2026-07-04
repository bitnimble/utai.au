"""Guard the capability-scoped provisioning: each capability downloads only its
own assets (never everything), and every name a loader resolves via `shipped_onnx`
is provisioned by some capability -- so the upload / download / lookup filenames
can't drift, and the dependency-group split isn't silently defeated.
"""

from pathlib import Path

from app.config import settings
from app.pipeline.provision import (
    _capability_assets,
    _sep_onnx_asset,
    deprovision,
    provisioned_file,
    shipped_onnx,
)


def _names(capability):
    return {a.filename for a in _capability_assets(capability)}


def test_separation_is_scoped_to_separation():
    names = _names("separation")
    assert {"model_bs_roformer_sw.fp16.onnx", "config_bs_roformer_sw.yaml"} <= names
    # never pulls lyrics weights
    assert not any("ctc_align" in f for f in names)


def test_lyrics_composes_separation():
    names = _names("lyrics")
    assert "model_bs_roformer_sw.fp16.onnx" in names  # /lyrics needs the vocals stem
    assert any(f.startswith("ctc_align__") for f in names)


def test_every_loader_lookup_is_provisioned_by_some_capability():
    provisioned = set()
    for cap in ("separation", "lyrics"):
        provisioned |= _names(cap)
    loader_names = {
        "model_bs_roformer_sw",  # separation
        f"ctc_align__{settings.lyrics_align_model_english.replace('/', '__')}",
        f"ctc_align__{settings.lyrics_align_model_default.replace('/', '__')}",  # lyrics
    }
    for name in loader_names:
        assert f"{name}.fp16.onnx" in provisioned, f"{name}.fp16.onnx not provisioned"


def test_roformer_ships_platform_variant_under_canonical_local_name(monkeypatch):
    stem = Path(settings.demucs_model).stem  # the bs_roformer body
    for platform, variant in (("darwin", "coreml"), ("linux", "mha"), ("win32", "mha")):
        monkeypatch.setattr("app.pipeline.provision.sys.platform", platform)
        asset = _sep_onnx_asset(stem)
        # local name stays canonical (the loader is platform-agnostic)...
        assert asset.filename == f"{stem}.fp16.onnx"
        # ...while the remote file is the platform's mutually-exclusive variant.
        assert asset.url.endswith(f"{stem}.{variant}.fp16.onnx")


def test_deprovision_removes_only_orphaned_assets(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "models_dir", tmp_path)
    sep = {a.filename for a in _capability_assets("separation")}
    lyr = {a.filename for a in _capability_assets("lyrics")}  # composes separation
    for name in sep | lyr:
        (tmp_path / name).write_bytes(b"x")
    (tmp_path / "coreml" / "cached.mlmodelc").parent.mkdir()  # unrelated cache, must survive
    (tmp_path / "coreml" / "cached.mlmodelc").write_bytes(b"x")

    # keep only separation -> the lyrics-only weights go, the shared
    # separation bodies stay, and the unrelated cache is never touched.
    removed = deprovision(["separation"])
    assert removed == len(lyr - sep)
    for name in sep:
        assert (tmp_path / name).exists(), f"{name} (still needed by separation) was deleted"
    for name in lyr - sep:
        assert not (tmp_path / name).exists(), f"{name} (orphaned) was not deleted"
    assert (tmp_path / "coreml" / "cached.mlmodelc").exists()

    # uninstalling the rest removes everything known; idempotent second call is a no-op.
    assert deprovision([]) == len(sep)
    assert deprovision([]) == 0


def test_resolution(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "models_dir", tmp_path)
    assert shipped_onnx("beat_this") is None
    (tmp_path / "beat_this.fp16.onnx").write_bytes(b"onnx")
    assert shipped_onnx("beat_this") == tmp_path / "beat_this.fp16.onnx"
    (tmp_path / "empty.fp16.onnx").write_bytes(b"")  # interrupted download != present
    assert shipped_onnx("empty") is None
    assert provisioned_file("onset_meta.json") is None
    (tmp_path / "onset_meta.json").write_text("{}")
    assert provisioned_file("onset_meta.json") == tmp_path / "onset_meta.json"
