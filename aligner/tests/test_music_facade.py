"""Unit tests for the music-source facade.

No live OnTheSpot: a fake client (the `OnTheSpotApi` Protocol) and a fake account
pool are injected, so these exercise the facade's own logic - priority-merge
search, the fetch state machine, config CRUD, account routing - deterministically.
Async methods are driven through `asyncio.run` so no pytest-asyncio dep is needed.
"""
from __future__ import annotations

import asyncio
import threading
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from app.config import settings
from app.music import facade as facade_module
from app.music.facade import (
    MusicFacade,
    _find_queue_item,
    _normalize_results,
    _opt_seconds,
)
from app.music.models import AddAccountRequest, TrackResult

# --- fakes ----------------------------------------------------------------


class FakeClient:
    def __init__(self) -> None:
        self.active_index: int | None = None
        self.search_by_index: dict[int, list[dict[str, Any]]] = {}
        self.queue_sequence: list[dict[str, dict[str, Any]]] = []
        self.parsed_urls: list[str] = []
        self.added: list[dict[str, Any]] = []
        self.removed: list[str] = []
        self.restarted = 0
        self.calls: list[str] = []
        self._queue_i = 0

    async def search(self, query: str) -> list[dict[str, Any]]:
        return self.search_by_index.get(self.active_index if self.active_index is not None else -1, [])

    async def set_active_account(self, index: int) -> None:
        self.active_index = index

    async def add_account(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.added.append(payload)
        return {"success": True}

    async def remove_account(self, uuid: str) -> None:
        self.removed.append(uuid)

    async def update_settings(self, patch: dict[str, Any]) -> None:
        if "active_account_number" in patch:
            self.active_index = patch["active_account_number"]
        if "raw_media_download" in patch:
            self.calls.append(f"raw_media_download={patch['raw_media_download']}")

    async def parse_url(self, url: str) -> None:
        self.calls.append("parse_url")
        self.parsed_urls.append(url)

    async def download_queue(self) -> dict[str, dict[str, Any]]:
        if not self.queue_sequence:
            return {}
        i = min(self._queue_i, len(self.queue_sequence) - 1)
        self._queue_i += 1
        return self.queue_sequence[i]

    async def restart(self) -> None:
        self.restarted += 1

    def stream_download(self, local_id: str) -> Any:  # unused by these tests
        raise NotImplementedError

    async def aclose(self) -> None:
        pass


class FakePool:
    def __init__(self, accounts: list[dict[str, Any]] | None = None) -> None:
        self._accounts = list(accounts or [])

    def accounts(self) -> list[dict[str, Any]]:
        return list(self._accounts)

    def append_account(self, entry: dict[str, Any]) -> None:
        self._accounts.append(entry)


class FakeYoutubeMusic:
    def __init__(self, results: list[TrackResult] | None = None) -> None:
        self.results = list(results or [])
        self.queries: list[str] = []

    async def search(self, query: str) -> list[TrackResult]:
        self.queries.append(query)
        return self.results


def _facade(
    tmp_path, client: FakeClient, pool: FakePool, youtube_music: FakeYoutubeMusic | None = None
) -> MusicFacade:
    return MusicFacade(client, pool, tmp_path / "music_config.json", youtube_music or FakeYoutubeMusic())


def _yt_track(video_id: str) -> TrackResult:
    return TrackResult(
        id=video_id,
        service="youtube_music",
        title=f"Song {video_id}",
        artists="Artist",
        sourceUrl=f"https://music.youtube.com/watch?v={video_id}",
    )


def _collect(agen: AsyncIterator[dict[str, Any]]) -> list[dict[str, Any]]:
    async def run() -> list[dict[str, Any]]:
        return [event async for event in agen]

    return asyncio.run(run())


def _track_item(item_id: str, service: str) -> dict[str, Any]:
    return {
        "item_id": item_id,
        "item_name": f"Song {item_id}",
        "item_by": f"Artist {item_id}",
        "item_type": "track",
        "item_service": service,
        "item_url": f"https://{service}/{item_id}",
        "item_thumbnail_url": f"https://img/{item_id}",
    }


# --- pure helpers ---------------------------------------------------------


def test_normalize_filters_non_tracks_and_maps_fields():
    raw = [
        _track_item("1", "tidal"),
        {"item_id": "2", "item_type": "album", "item_url": "u", "item_name": "n"},
        {"item_type": "track", "item_name": "no id"},  # missing id/url -> dropped
    ]
    out = _normalize_results(raw, "tidal")
    assert len(out) == 1
    assert out[0].id == "1"
    assert out[0].title == "Song 1"
    assert out[0].artists == "Artist 1"
    assert out[0].service == "tidal"
    assert out[0].sourceUrl == "https://tidal/1"
    assert out[0].coverUrl == "https://img/1"


def test_opt_seconds_handles_ms_seconds_and_junk():
    assert _opt_seconds(180000) == 180.0  # ms
    assert _opt_seconds(210) == 210.0  # already seconds
    assert _opt_seconds(0) is None
    assert _opt_seconds(None) is None
    assert _opt_seconds("nope") is None
    assert _opt_seconds(True) is None  # bool is not a duration


def test_find_queue_item_matches_url_and_prefers_latest():
    url = "https://svc/x"
    queue = {
        "3": {"item_url": url, "item_status": "Downloaded"},
        "10": {"item_url": url, "item_status": "Downloading"},
        "5": {"item_url": "https://svc/other", "item_status": "Downloaded"},
    }
    local_id, item = _find_queue_item(queue, url)
    assert local_id == "10"  # highest local_id among matches
    assert item is not None and item["item_status"] == "Downloading"
    assert _find_queue_item({}, url) == ("", None)


def test_find_queue_item_matches_by_item_id_when_url_differs():
    # OnTheSpot normalized the URL on enqueue -> only the item_id matches.
    queue = {"2": {"item_url": "https://svc/normalized", "item_id": "abc", "item_status": "Downloaded"}}
    local_id, item = _find_queue_item(queue, "https://svc/original", item_id="abc")
    assert local_id == "2"
    assert item is not None
    # No id and a non-matching url -> no match.
    assert _find_queue_item(queue, "https://svc/original") == ("", None)


# --- search ---------------------------------------------------------------


def test_search_merges_in_priority_order(tmp_path):
    client = FakeClient()
    client.search_by_index = {0: [_track_item("t", "tidal")]}
    pool = FakePool([{"service": "tidal", "uuid": "t"}, {"service": "youtube_music", "uuid": "y"}])
    facade = _facade(tmp_path, client, pool, FakeYoutubeMusic([_yt_track("y")]))
    facade.set_config(priority=["tidal", "youtube_music"])
    results = asyncio.run(facade.search("hello"))
    assert [r.service for r in results] == ["tidal", "youtube_music"]

    # Flip the priority -> youtube_music ranks first.
    facade.set_config(priority=["youtube_music", "tidal"])
    results = asyncio.run(facade.search("hello"))
    assert [r.service for r in results] == ["youtube_music", "tidal"]


def test_search_skips_unconfigured(tmp_path):
    client = FakeClient()
    client.search_by_index = {0: [_track_item("t", "tidal")]}
    pool = FakePool([{"service": "tidal", "uuid": "t"}])
    facade = _facade(tmp_path, client, pool)
    facade.set_config(priority=["spotify", "tidal", "youtube_music"])
    # spotify has no account (unconfigured) -> filtered out of the search set.
    # youtube_music is no-login "configured", but its search has no results, so
    # only tidal comes back.
    results = asyncio.run(facade.search("hello"))
    assert [r.service for r in results] == ["tidal"]


def test_youtube_music_searches_youtube_music_not_onthespot(tmp_path):
    client = FakeClient()
    client.search_by_index = {0: [_track_item("ots", "youtube_music")]}
    pool = FakePool([{"service": "youtube_music", "uuid": "public_youtube_music"}])
    youtube_music = FakeYoutubeMusic([_yt_track("KP4tmbzrCEc")])
    facade = _facade(tmp_path, client, pool, youtube_music)
    facade.set_config(priority=["youtube_music"])
    results = asyncio.run(facade.search("macklemore wings"))
    assert [r.id for r in results] == ["KP4tmbzrCEc"]
    assert youtube_music.queries == ["macklemore wings"]
    assert client.active_index is None


def test_plain_youtube_search_is_opt_in_and_listed_after_youtube_music(tmp_path):
    client = FakeClient()
    client.search_by_index = {0: [_track_item("KP4tmbzrCEc", "youtube_music"), _track_item("fallon", "youtube_music")]}
    pool = FakePool([{"service": "youtube_music", "uuid": "public_youtube_music"}])
    facade = _facade(tmp_path, client, pool, FakeYoutubeMusic([_yt_track("KP4tmbzrCEc")]))
    facade.set_config(priority=["youtube_music"])
    assert facade.get_config().includeYoutubeSearch is False
    assert [r.id for r in asyncio.run(facade.search("hello"))] == ["KP4tmbzrCEc"]

    facade.set_config(include_youtube_search=True)
    results = asyncio.run(facade.search("hello"))
    assert [(r.id, r.uploaderTitled) for r in results] == [("KP4tmbzrCEc", False), ("fallon", True)]
    assert _facade(tmp_path, FakeClient(), pool).get_config().includeYoutubeSearch is True


def test_search_seeds_missing_anonymous_account(tmp_path):
    # OnTheSpot shipped no youtube_music account: search seeds it (+ restart)
    # so its downloads work with no UI step.
    client = FakeClient()
    pool = FakePool()  # empty, nothing pre-seeded
    facade = _facade(tmp_path, client, pool, FakeYoutubeMusic([_yt_track("y")]))
    facade.set_config(priority=["youtube_music"])
    results = asyncio.run(facade.search("hello"))
    assert client.restarted == 1
    assert any(a.get("service") == "youtube_music" for a in pool.accounts())
    assert [r.service for r in results] == ["youtube_music"]

    # Already seeded on a second search -> no extra restart.
    asyncio.run(facade.search("hello"))
    assert client.restarted == 1


def test_search_empty_query_short_circuits(tmp_path):
    facade = _facade(tmp_path, FakeClient(), FakePool())
    assert asyncio.run(facade.search("   ")) == []


# --- config ---------------------------------------------------------------


def test_config_roundtrip_and_persist(tmp_path):
    client = FakeClient()
    pool = FakePool()
    facade = _facade(tmp_path, client, pool)

    cfg = facade.get_config()
    # Every catalog service present once in priority.
    assert "youtube_music" in cfg.priority

    facade.set_config(priority=["youtube_music"])
    cfg = facade.get_config()
    assert cfg.priority[0] == "youtube_music"

    # A fresh facade over the same file sees the persisted config.
    reloaded = _facade(tmp_path, FakeClient(), FakePool())
    cfg2 = reloaded.get_config()
    assert cfg2.priority[0] == "youtube_music"


def test_config_drops_unknown_services(tmp_path):
    facade = _facade(tmp_path, FakeClient(), FakePool())
    facade.set_config(priority=["not_a_service", "tidal"])
    cfg = facade.get_config()
    assert "not_a_service" not in cfg.priority
    assert cfg.priority[0] == "tidal"


def test_services_configured_reflects_pool(tmp_path):
    pool = FakePool([{"service": "deezer", "uuid": "d"}])
    facade = _facade(tmp_path, FakeClient(), pool)
    services = {s.id: s.configured for s in facade.services()}
    assert services["deezer"] is True
    assert services["tidal"] is False


def test_services_ignore_placeholder_public_accounts(tmp_path):
    # OnTheSpot seeds these on a fresh install; none is a real user sign-in.
    pool = FakePool(
        [
            {"service": "deezer", "uuid": "public_deezer", "login": {"arl": "public_deezer"}},
            {"service": "soundcloud", "uuid": "public_soundcloud"},
            {"service": "youtube_music", "uuid": "public_youtube_music"},
        ]
    )
    facade = _facade(tmp_path, FakeClient(), pool)
    by_id = {s.id: s for s in facade.services()}
    # Credentialed services with only a placeholder -> NOT signed in.
    assert by_id["deezer"].configured is False
    assert by_id["deezer"].accountUuid is None
    assert by_id["soundcloud"].configured is False
    # Anonymous service needs no login -> always available.
    assert by_id["youtube_music"].configured is True
    # A real (non-placeholder) account still counts.
    pool.append_account({"service": "deezer", "uuid": "real-arl"})
    by_id = {s.id: s for s in facade.services()}
    assert by_id["deezer"].configured is True
    assert by_id["deezer"].accountUuid == "real-arl"


def test_youtube_music_downloads_from_placeholder_only(tmp_path):
    # Fresh install: OnTheSpot ships ONLY its default public YouTube Music
    # account. It's no-login (always configured), and downloads must still route
    # to it via the placeholder fallback -- no utai-side seeding needed.
    client = FakeClient()
    pool = FakePool([{"service": "tidal", "uuid": "t"}, {"service": "youtube_music", "uuid": "public_youtube_music"}])
    facade = _facade(tmp_path, client, pool)
    assert {s.id: s.configured for s in facade.services()}["youtube_music"] is True
    url = "https://music.youtube.com/watch?v=KP4tmbzrCEc"
    client.queue_sequence = [{"1": {"item_url": url, "item_id": "KP4tmbzrCEc", "item_status": "Downloaded"}}]
    events = _collect(facade.fetch(url, service="youtube_music", item_id="KP4tmbzrCEc"))
    assert events[-1]["type"] == "result"
    assert client.active_index == 1


def test_search_prefers_real_account_over_placeholder(tmp_path):
    # public_deezer sits before the real deezer account; search must switch to
    # the real one's index, not the placeholder's.
    client = FakeClient()
    client.search_by_index = {1: [_track_item("d", "deezer")]}
    pool = FakePool(
        [
            {"service": "deezer", "uuid": "public_deezer"},
            {"service": "deezer", "uuid": "real"},
        ]
    )
    facade = _facade(tmp_path, client, pool)
    facade.set_config(priority=["deezer"])
    results = asyncio.run(facade.search("hello"))
    # The fake only returns deezer results for the real account's index (1), not
    # the placeholder's (0), so a deezer result proves the real account was used.
    assert [r.service for r in results] == ["deezer"]


# --- fetch ----------------------------------------------------------------


def test_fetch_success(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "music_poll_interval_sec", 0.0)
    url = "https://youtube_music/y"
    client = FakeClient()
    client.queue_sequence = [
        {},  # not enqueued yet
        {"7": {"item_url": url, "item_status": "Downloading", "progress": 40}},
        {
            "7": {
                "item_url": url,
                "item_status": "Downloaded",
                "progress": 100,
                "item_name": "Song y",
                "item_service": "youtube_music",
                "file_path": "/downloads/Song y.webm",
            }
        },
    ]
    facade = _facade(tmp_path, client, FakePool([{"service": "youtube_music", "uuid": "y"}]))
    events = _collect(facade.fetch(url, "youtube_music"))

    assert client.calls == ["raw_media_download=True", "parse_url"]
    assert client.parsed_urls == [url]
    assert events[0] == {"type": "running", "stage": "queued", "frac": 0.0}
    assert any(e["type"] == "running" and e.get("frac") == 0.4 for e in events)
    result = events[-1]
    assert result["type"] == "result"
    assert result["audio"]["path"] == "music/audio/7"
    assert result["audio"]["contentType"] == "audio/webm"
    assert result["audio"]["filename"] == "Song y"


_YT_URL = "https://music.youtube.com/watch?v=dQw4w9WgXcQ"


def _shared_downloads(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "music_poll_interval_sec", 0.0)
    monkeypatch.setattr(settings, "cache_dir", tmp_path / "cache")
    downloads = tmp_path / "downloads"
    monkeypatch.setattr(settings, "music_download_dir", downloads)
    file = downloads / "Tracks" / "Song.webm"
    file.parent.mkdir(parents=True)
    file.write_bytes(b"audio")
    return file


def _downloaded(file, local_id: str = "dQw4w9WgXcQ-0") -> dict[str, dict[str, Any]]:
    return {
        local_id: {
            "item_url": _YT_URL,
            "item_id": "dQw4w9WgXcQ",
            "item_status": "Downloaded",
            "item_name": "Song: A",
            "file_path": str(file),
        }
    }


def test_fetch_moves_a_shared_download_into_its_songs_folder(tmp_path, monkeypatch):
    file = _shared_downloads(tmp_path, monkeypatch)
    client = FakeClient()
    client.queue_sequence = [_downloaded(file)]

    result = _collect(_facade(tmp_path, client, FakePool()).fetch(_YT_URL))[-1]

    held = tmp_path / "cache" / "songs" / "dQw4w9WgXcQ" / "download" / "Song_ A.webm"
    assert held.read_bytes() == b"audio"
    assert not file.exists()
    assert result["type"] == "result"
    assert result["audio"] == {
        "path": "music/songs/dQw4w9WgXcQ/download",
        "serverPath": str(held),
        "filename": "Song_ A",
        "contentType": "audio/webm",
    }


def test_refetching_a_held_track_skips_onthespot(tmp_path, monkeypatch):
    file = _shared_downloads(tmp_path, monkeypatch)
    client = FakeClient()
    client.queue_sequence = [_downloaded(file)]
    facade = _facade(tmp_path, client, FakePool())
    first = _collect(facade.fetch(_YT_URL))[-1]
    client.parsed_urls.clear()

    assert _collect(facade.fetch(_YT_URL)) == [first]
    assert client.parsed_urls == []


def test_refetching_an_evicted_track_waits_for_its_new_download(tmp_path, monkeypatch):
    moved_away = _shared_downloads(tmp_path, monkeypatch)
    moved_away.unlink()
    fresh = moved_away.with_name("Song again.webm")
    fresh.write_bytes(b"again")
    client = FakeClient()
    client.queue_sequence = [
        _downloaded(moved_away),
        {**_downloaded(moved_away), **_downloaded(fresh, "dQw4w9WgXcQ-1")},
    ]

    result = _collect(_facade(tmp_path, client, FakePool()).fetch(_YT_URL))[-1]

    assert result["type"] == "result"
    assert Path(result["audio"]["serverPath"]).read_bytes() == b"again"
    assert not fresh.exists()


def test_fetch_keeps_a_shared_download_in_place_if_it_cannot_be_moved(tmp_path, monkeypatch):
    file = _shared_downloads(tmp_path, monkeypatch)
    client = FakeClient()
    client.queue_sequence = [_downloaded(file)]

    def fail(*_args: Any) -> None:
        raise OSError("disk full")

    monkeypatch.setattr("app.music.facade.store_file", fail)
    result = _collect(_facade(tmp_path, client, FakePool()).fetch(_YT_URL))[-1]

    assert result["audio"]["path"] == "music/audio/dQw4w9WgXcQ-0"
    assert result["audio"]["serverPath"] == str(file.resolve())
    assert file.read_bytes() == b"audio"


def test_a_long_title_still_moves_into_the_songs_folder(tmp_path, monkeypatch):
    file = _shared_downloads(tmp_path, monkeypatch)
    item = _downloaded(file)
    item["dQw4w9WgXcQ-0"]["item_name"] = "歌" * 200
    client = FakeClient()
    client.queue_sequence = [item]

    result = _collect(_facade(tmp_path, client, FakePool()).fetch(_YT_URL))[-1]

    held = Path(result["audio"]["serverPath"])
    assert held.read_bytes() == b"audio"
    assert held.parent == tmp_path / "cache" / "songs" / "dQw4w9WgXcQ" / "download"
    assert result["audio"]["filename"] == "歌" * 50
    assert not file.exists()


def test_a_second_fetch_waits_for_a_move_whose_fetch_was_cancelled(tmp_path, monkeypatch):
    file = _shared_downloads(tmp_path, monkeypatch)
    moving, release = threading.Event(), threading.Event()
    real_store = facade_module.store_file

    def slow_store(dest: Path, src: Path) -> None:
        moving.set()
        assert release.wait(5)
        real_store(dest, src)

    monkeypatch.setattr(facade_module, "store_file", slow_store)
    facade = _facade(tmp_path, FakeClient(), FakePool())
    item = _downloaded(file)["dQw4w9WgXcQ-0"]

    async def scenario() -> dict[str, Any]:
        first = asyncio.create_task(facade._finished_download("dQw4w9WgXcQ", "dQw4w9WgXcQ-0", item))
        await asyncio.to_thread(moving.wait, 5)
        first.cancel()
        second = asyncio.create_task(facade._finished_download("dQw4w9WgXcQ", "dQw4w9WgXcQ-0", item))
        await asyncio.sleep(0.05)
        release.set()
        return await second

    result = asyncio.run(scenario())

    assert result["audio"]["path"] == "music/songs/dQw4w9WgXcQ/download"
    assert Path(result["audio"]["serverPath"]).read_bytes() == b"audio"


def test_find_queue_item_prefers_the_latest_enqueue_of_a_track():
    queue = {
        "dQw4w9WgXcQ-2": {"item_url": _YT_URL, "item_status": "Downloading"},
        "dQw4w9WgXcQ-10": {"item_url": _YT_URL, "item_status": "Waiting"},
        "dQw4w9WgXcQ-1": {"item_url": _YT_URL, "item_status": "Failed"},
    }
    assert _find_queue_item(queue, _YT_URL)[0] == "dQw4w9WgXcQ-10"


def test_fetch_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "music_poll_interval_sec", 0.0)
    url = "https://svc/x"
    client = FakeClient()
    client.queue_sequence = [{"1": {"item_url": url, "item_status": "Failed", "progress": 0}}]
    facade = _facade(tmp_path, client, FakePool())
    events = _collect(facade.fetch(url, None))
    assert events[-1]["type"] == "error"


def test_fetch_timeout(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "music_poll_interval_sec", 0.0)
    monkeypatch.setattr(settings, "music_fetch_timeout_sec", 0.0)
    client = FakeClient()  # empty queue forever
    facade = _facade(tmp_path, client, FakePool())
    events = _collect(facade.fetch("https://svc/never", None))
    assert events[-1]["type"] == "error"
    assert "imed out" in events[-1]["message"]


# --- accounts -------------------------------------------------------------


def test_add_account_interactive_service(tmp_path):
    # Tidal is the OnTheSpot-tab interactive flow (Spotify is its own OAuth kind).
    facade = _facade(tmp_path, FakeClient(), FakePool())
    result = asyncio.run(facade.add_account(AddAccountRequest(service="tidal")))
    assert result.status == "interactive_required"
    # The absolute authUrl is filled by the HTTP route (it needs the request
    # host); the facade stays transport-agnostic.
    assert result.authUrl is None


def test_add_account_token_service(tmp_path):
    client = FakeClient()
    facade = _facade(tmp_path, client, FakePool())
    result = asyncio.run(
        facade.add_account(AddAccountRequest(service="deezer", token="ARL123"))
    )
    assert result.status == "added"
    assert client.added == [{"service": "deezer", "password": "ARL123"}]


def test_add_account_youtube_music_anonymous(tmp_path):
    client = FakeClient()
    pool = FakePool()
    facade = _facade(tmp_path, client, pool)
    result = asyncio.run(facade.add_account(AddAccountRequest(service="youtube_music")))
    assert result.status == "added"
    assert any(a.get("service") == "youtube_music" for a in pool.accounts())
    assert client.restarted == 1


def test_add_account_missing_credentials_errors(tmp_path):
    facade = _facade(tmp_path, FakeClient(), FakePool())
    result = asyncio.run(facade.add_account(AddAccountRequest(service="qobuz")))
    assert result.status == "error"


def test_add_account_unknown_service_errors(tmp_path):
    facade = _facade(tmp_path, FakeClient(), FakePool())
    result = asyncio.run(facade.add_account(AddAccountRequest(service="nope")))
    assert result.status == "error"
