"""ETag-based update detection in `_download`: a present asset is verified against
the remote ETag and re-downloaded only on change, with graceful fallbacks when the
remote is unreachable or the file is present-but-untracked.

`_download` calls `httpx.head` / `httpx.stream` directly, so we patch those on the
module's `httpx` with a small fake exposing only the surface `_download` touches.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import pytest

from app.pipeline import provision


class _FakeResp:
    """Stands in for both the HEAD response and the streaming GET response."""

    def __init__(self, *, etag: str, body: bytes, size: int | None = None) -> None:
        cl = str(size if size is not None else len(body))
        self.headers = {"x-linked-etag": etag, "content-length": cl}
        self.history: tuple[object, ...] = ()
        self._body = body
        self.num_bytes_downloaded = len(body)

    def raise_for_status(self) -> None:
        return None

    def iter_bytes(self, chunk_size: int = 1 << 20) -> Iterator[bytes]:
        for i in range(0, len(self._body), chunk_size):
            yield self._body[i : i + chunk_size]


def _install_remote(
    monkeypatch: pytest.MonkeyPatch, *, etag: str = "v1", body: bytes = b"DATA", head_fails: bool = False
) -> dict[str, int]:
    counters = {"head": 0, "stream": 0}

    def fake_head(url: str, follow_redirects: bool = True, timeout: object = None) -> _FakeResp:
        counters["head"] += 1
        if head_fails:
            raise RuntimeError("offline")
        return _FakeResp(etag=etag, body=body)

    @contextmanager
    def fake_stream(method: str, url: str, **_kw: object) -> Iterator[_FakeResp]:
        counters["stream"] += 1
        yield _FakeResp(etag=etag, body=body)

    monkeypatch.setattr(provision.httpx, "head", fake_head)
    monkeypatch.setattr(provision.httpx, "stream", fake_stream)
    return counters


def test_downloads_when_absent_and_records_etag(tmp_path, monkeypatch) -> None:
    c = _install_remote(monkeypatch, etag="v1", body=b"HELLO")
    dest = tmp_path / "m.onnx"
    provision._download("http://x/m.onnx", dest)
    assert dest.read_bytes() == b"HELLO"
    assert provision._read_etag(dest) == "v1"
    assert c["stream"] == 1


def test_skips_when_etag_matches(tmp_path, monkeypatch) -> None:
    dest = tmp_path / "m.onnx"
    _install_remote(monkeypatch, etag="v1", body=b"HELLO")
    provision._download("http://x/m.onnx", dest)
    c = _install_remote(monkeypatch, etag="v1", body=b"HELLO")  # reset counters
    provision._download("http://x/m.onnx", dest)
    assert c["stream"] == 0  # not re-downloaded
    assert c["head"] == 1  # but did verify


def test_redownloads_when_etag_changes(tmp_path, monkeypatch) -> None:
    dest = tmp_path / "m.onnx"
    _install_remote(monkeypatch, etag="v1", body=b"OLD")
    provision._download("http://x/m.onnx", dest)
    c = _install_remote(monkeypatch, etag="v2", body=b"NEWER")
    provision._download("http://x/m.onnx", dest)
    assert dest.read_bytes() == b"NEWER"
    assert provision._read_etag(dest) == "v2"
    assert c["stream"] == 1


def test_adopts_etag_on_size_match_without_redownload(tmp_path, monkeypatch) -> None:
    # Present but no etag sidecar (pre-mounted volume); size matches -> adopt.
    dest = tmp_path / "m.onnx"
    dest.write_bytes(b"HELLO")
    c = _install_remote(monkeypatch, etag="v1", body=b"HELLO")
    provision._download("http://x/m.onnx", dest)
    assert c["stream"] == 0
    assert provision._read_etag(dest) == "v1"


def test_redownloads_untracked_on_size_mismatch(tmp_path, monkeypatch) -> None:
    dest = tmp_path / "m.onnx"
    dest.write_bytes(b"SHORT")
    c = _install_remote(monkeypatch, etag="v9", body=b"A_LONGER_BODY")
    provision._download("http://x/m.onnx", dest)
    assert dest.read_bytes() == b"A_LONGER_BODY"
    assert c["stream"] == 1


def test_keeps_present_file_when_remote_unreachable(tmp_path, monkeypatch) -> None:
    dest = tmp_path / "m.onnx"
    dest.write_bytes(b"HELLO")
    c = _install_remote(monkeypatch, head_fails=True)
    provision._download("http://x/m.onnx", dest)
    assert c["stream"] == 0
    assert dest.read_bytes() == b"HELLO"


def test_update_check_off_skips_verification(tmp_path, monkeypatch) -> None:
    dest = tmp_path / "m.onnx"
    dest.write_bytes(b"HELLO")
    c = _install_remote(monkeypatch)
    provision._download("http://x/m.onnx", dest, update_check=False)
    assert c["head"] == 0 and c["stream"] == 0


def test_emits_progress_events(tmp_path, monkeypatch) -> None:
    dest = tmp_path / "m.onnx"
    _install_remote(monkeypatch, etag="v1", body=b"HELLO")
    events: list[provision.ProvisionEvent] = []
    provision._download("http://x/m.onnx", dest, on_progress=events.append)
    phases = [e.phase for e in events]
    assert "downloading" in phases
    assert phases[-1] == "done"

    events.clear()
    _install_remote(monkeypatch, etag="v1", body=b"HELLO")
    provision._download("http://x/m.onnx", dest, on_progress=events.append)
    assert [e.phase for e in events] == ["checking", "skipped"]


def test_startup_capabilities_parses_comma_env(monkeypatch) -> None:
    # Regression: a `list[str]` field made pydantic-settings JSON-decode the env
    # string and crash on `STARTUP_CAPABILITIES=lyrics,pitch`. A plain str + parser
    # accepts the comma form docker-compose sets.
    from app.config import Settings

    monkeypatch.setenv("STARTUP_CAPABILITIES", "lyrics, pitch ,")
    assert Settings().startup_capability_list == ["lyrics", "pitch"]
    monkeypatch.setenv("STARTUP_CAPABILITIES", "")
    assert Settings().startup_capability_list == []


def test_planned_assets_dedupes_and_stays_capability_scoped() -> None:
    names = provision.planned_assets("lyrics", "pitch")
    assert len(names) == len(set(names))  # deduped across the shared separation body
    assert any("ctc_align" in n for n in names)  # lyrics aligners
    assert provision.settings.pitch_model_offline in names  # rmvpe (pitch, offline)
    assert provision.planned_assets("bogus") == []
