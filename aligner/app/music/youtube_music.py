"""YouTube Music's own search via ytmusicapi: music only, with catalogue
metadata for songs. Downloads still go through OnTheSpot."""
from __future__ import annotations

import asyncio
import re
import unicodedata
from difflib import SequenceMatcher
from typing import Any, Protocol

from .models import TrackResult

SERVICE = "youtube_music"
_RESULTS_PER_KIND = 10
_SAME_WORD_RATIO = 0.8
_COMBINING_DIACRITICS = re.compile("[̀-ͯ]")
_WORD = re.compile(r"[^\W_]+")
_OFFICIAL_MUSIC_VIDEO = "MUSIC_VIDEO_TYPE_OMV"
_MUSIC_VIDEO_WORDS = {"video", "mv", "pv"}
_OTHER_VERSION_WORDS = {
    "live", "cover", "remix", "karaoke", "instrumental", "acoustic", "reaction",
    "lyric", "lyrics", "audio", "visualizer", "visualiser", "teaser", "trailer", "dance",
    "slowed", "sped", "reverb", "nightcore", "performance", "concert", "tutorial",
}


def rank_by_query(results: list[TrackResult], query: str) -> list[TrackResult]:
    """Most query words found in the title + artists first; ties keep their order."""
    words = _tokens(query)
    return sorted(results, key=lambda t: -_matched_count(words, _tokens(f"{t.title} {t.artists}")))


def music_videos_first(songs: list[Any], videos: list[Any]) -> list[Any]:
    """Each song's own music video (official first) right before it, the remaining videos after the songs."""
    remaining = list(videos)
    out: list[Any] = []
    for row in songs:
        song = _normalize_one(row)
        if song is None:
            out.append(row)
            continue
        own = [v for v in remaining if _is_music_video_of(v, song)]
        own.sort(key=lambda v: v.get("videoType") != _OFFICIAL_MUSIC_VIDEO)
        remaining = [v for v in remaining if v not in own]
        out += [*own, row]
    return [*out, *remaining]


def _is_music_video_of(row: Any, song: TrackResult) -> bool:
    video = _normalize_one(row)
    # Same id = the song row itself, which keeps its catalogue metadata only if it stays first.
    if video is None or video.id == song.id:
        return False
    words = _tokens(f"{video.title} {video.artists}")
    song_words = _tokens(f"{song.title} {song.artists}")
    extra_words = set(words) - set(song_words)
    is_music_video = row.get("videoType") == _OFFICIAL_MUSIC_VIDEO or bool(_MUSIC_VIDEO_WORDS & extra_words)
    return (
        is_music_video
        and bool(song_words)
        and _matched_count(song_words, words) == len(song_words)
        and not (_OTHER_VERSION_WORDS & extra_words)
    )


def _matched_count(words: list[str], candidate: list[str]) -> int:
    return sum(1 for w in words if any(_same_word(w, c) for c in candidate))


def _same_word(word: str, candidate: str) -> bool:
    if word == candidate:
        return True
    # Non-Latin scripts glue words together ("米津玄師ハチ").
    if not word.isascii() and len(word) >= 2 and word in candidate:
        return True
    return SequenceMatcher(None, word, candidate).ratio() >= _SAME_WORD_RATIO


def _tokens(text: str) -> list[str]:
    folded = _COMBINING_DIACRITICS.sub("", unicodedata.normalize("NFKD", text))
    return _WORD.findall(unicodedata.normalize("NFC", folded).lower())


class YoutubeMusicSearch(Protocol):
    async def search(self, query: str) -> list[TrackResult]: ...


class YtMusicSearch:
    """Songs (catalogue tracks), each led by its own music video, then the other videos."""

    def __init__(self) -> None:
        from ytmusicapi import YTMusic

        self._yt = YTMusic()

    async def search(self, query: str) -> list[TrackResult]:
        return await asyncio.to_thread(self._search, query)

    def _search(self, query: str) -> list[TrackResult]:
        songs = self._yt.search(query, filter="songs")[:_RESULTS_PER_KIND]
        videos = self._yt.search(query, filter="videos")[:_RESULTS_PER_KIND]
        return normalize_results(music_videos_first(songs, videos))


def normalize_results(rows: list[dict[str, Any]]) -> list[TrackResult]:
    seen: set[str] = set()
    out: list[TrackResult] = []
    for row in rows:
        track = _normalize_one(row)
        if track is None or track.id in seen:
            continue
        seen.add(track.id)
        out.append(track)
    return out


def _normalize_one(row: Any) -> TrackResult | None:
    if not isinstance(row, dict):
        return None
    video_id, title = row.get("videoId"), row.get("title")
    if not isinstance(video_id, str) or not isinstance(title, str):
        return None
    artists = ", ".join(
        a["name"] for a in row.get("artists") or [] if isinstance(a, dict) and isinstance(a.get("name"), str)
    )
    album = row.get("album")
    album_name = album.get("name") if isinstance(album, dict) else None
    thumbnails = row.get("thumbnails") or []
    largest = thumbnails[-1] if thumbnails and isinstance(thumbnails[-1], dict) else {}
    duration = row.get("duration_seconds")
    return TrackResult(
        id=video_id,
        service=SERVICE,
        title=title,
        artists=artists,
        album=album_name if isinstance(album_name, str) else None,
        durationSec=float(duration) if isinstance(duration, int | float) else None,
        coverUrl=largest.get("url") if isinstance(largest.get("url"), str) else None,
        sourceUrl=f"https://music.youtube.com/watch?v={video_id}",
        uploaderTitled=row.get("resultType") != "song",
    )
