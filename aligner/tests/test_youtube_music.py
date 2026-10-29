"""YouTube Music search result normalisation, over rows shaped like ytmusicapi's."""
from __future__ import annotations

from app.music.models import TrackResult
from app.music.youtube_music import music_videos_first, normalize_results, rank_by_query

SONG = {
    "resultType": "song",
    "title": "Wing$",
    "artists": [{"name": "Macklemore & Ryan Lewis", "id": "UC93q7WvkXEJBlk_QcO8aAuA"}],
    "album": {"name": "The Heist", "id": "MPREb_38VROXREc7o"},
    "duration_seconds": 299,
    "videoId": "KP4tmbzrCEc",
    "videoType": "MUSIC_VIDEO_TYPE_ATV",
    "thumbnails": [
        {"url": "https://yt3.googleusercontent.com/a=w60-h60", "width": 60, "height": 60},
        {"url": "https://yt3.googleusercontent.com/a=w120-h120", "width": 120, "height": 120},
    ],
}

VIDEO = {
    "resultType": "video",
    "title": 'Macklemore x Ryan Lewis "WINGS" Official Music Video',
    "artists": [{"name": "Zia Mohajerjasbi", "id": "UCVKL6YVMw2qvzXPNIc5UDLg"}],
    "album": None,
    "duration_seconds": 333,
    "videoId": "gAg3uMlNyHA",
    "videoType": "MUSIC_VIDEO_TYPE_UGC",
    "thumbnails": [{"url": "https://i.ytimg.com/vi/gAg3uMlNyHA/hqdefault.jpg", "width": 400, "height": 225}],
}


def test_song_keeps_catalogue_metadata():
    [song] = normalize_results([SONG])
    assert song.model_dump() == {
        "id": "KP4tmbzrCEc",
        "service": "youtube_music",
        "title": "Wing$",
        "artists": "Macklemore & Ryan Lewis",
        "album": "The Heist",
        "durationSec": 299.0,
        "coverUrl": "https://yt3.googleusercontent.com/a=w120-h120",
        "sourceUrl": "https://music.youtube.com/watch?v=KP4tmbzrCEc",
        "uploaderTitled": False,
    }


def test_video_is_uploader_titled():
    [video] = normalize_results([VIDEO])
    assert video.title == 'Macklemore x Ryan Lewis "WINGS" Official Music Video'
    assert video.artists == "Zia Mohajerjasbi"
    assert video.album is None
    assert video.uploaderTitled is True


def _track(title: str, artists: str) -> TrackResult:
    return TrackResult(id=title, service="youtube_music", title=title, artists=artists, sourceUrl="u")


def test_rank_puts_uploads_matching_the_whole_query_above_same_titled_songs():
    results = [
        _track("Jealous Girl", "SubPickle"),
        _track("Jealous Girl", "Ben Kweller"),
        _track("Jealous girl- Lana del rey🤎 unreleased song(lyrics video)", "Selkies Studio"),
        _track("Lana Del Rey - Sad Girl (Lyrics)", "Chhonleang Nol"),
        _track("jealous girl - Lana del Rey unreleased with lyrics", "ciri"),
    ]
    ranked = rank_by_query(results, "jealous girl lana del rey")
    assert [(t.title, t.artists) for t in ranked] == [
        ("Jealous girl- Lana del rey🤎 unreleased song(lyrics video)", "Selkies Studio"),
        ("jealous girl - Lana del Rey unreleased with lyrics", "ciri"),
        ("Lana Del Rey - Sad Girl (Lyrics)", "Chhonleang Nol"),
        ("Jealous Girl", "SubPickle"),
        ("Jealous Girl", "Ben Kweller"),
    ]


def test_rank_keeps_the_catalogue_song_first_and_ties_in_order():
    results = [
        _track("Wing$", "Macklemore & Ryan Lewis"),
        _track("Irish Celebration", "Macklemore & Ryan Lewis"),
        _track('Macklemore x Ryan Lewis "WINGS" Official Music Video', "Zia Mohajerjasbi"),
        _track("Can't Hold Us", "Macklemore & Ryan Lewis"),
    ]
    ranked = rank_by_query(results, "macklemore wings")
    assert [t.title for t in ranked] == [
        "Wing$",
        'Macklemore x Ryan Lewis "WINGS" Official Music Video',
        "Irish Celebration",
        "Can't Hold Us",
    ]


def test_rank_matches_glued_non_latin_words():
    results = [_track("Lemon", "Someone"), _track("LADY", "米津玄師ハチ")]
    assert [t.title for t in rank_by_query(results, "lady 米津玄師")] == ["LADY", "Lemon"]


def _row(video_id: str, title: str, artist: str, video_type: str = "MUSIC_VIDEO_TYPE_UGC") -> dict:
    return {**VIDEO, "videoId": video_id, "title": title, "artists": [{"name": artist}], "videoType": video_type}


def test_music_video_goes_right_before_its_song():
    other_song = {**SONG, "videoId": "other", "title": "Can't Hold Us"}
    official = _row("omv", "Wing$", "Macklemore & Ryan Lewis", "MUSIC_VIDEO_TYPE_OMV")
    ordered = music_videos_first([other_song, SONG], [VIDEO, official])
    assert [r["videoId"] for r in ordered] == ["other", "omv", "gAg3uMlNyHA", "KP4tmbzrCEc"]


def test_song_words_alone_dont_make_a_music_video():
    song = {**SONG, "title": "Video Games", "artists": [{"name": "Lana Del Rey"}]}
    reupload = _row("reupload", "Lana Del Rey - Video Games", "some channel")
    assert [r["videoId"] for r in music_videos_first([song], [reupload])] == ["KP4tmbzrCEc", "reupload"]


def test_song_keeps_its_row_when_the_videos_search_returns_it_too():
    same_id = {**SONG, "resultType": "video", "videoType": "MUSIC_VIDEO_TYPE_OMV"}
    [song] = normalize_results(music_videos_first([SONG], [same_id]))
    assert song.album == "The Heist"
    assert song.uploaderTitled is False


def test_other_videos_stay_below_the_songs():
    videos = [
        _row("wrong-song", "Can't Hold Us (Official Video)", "Macklemore & Ryan Lewis", "MUSIC_VIDEO_TYPE_OMV"),
        _row("live", "Wing$ (Live Video)", "Macklemore & Ryan Lewis", "MUSIC_VIDEO_TYPE_OMV"),
        _row("reupload", "Macklemore & Ryan Lewis - Wing$", "some channel"),
        _row("cover", "Wing$ Macklemore & Ryan Lewis cover video", "some channel"),
    ]
    ordered = music_videos_first([SONG], videos)
    assert [r["videoId"] for r in ordered] == ["KP4tmbzrCEc", "wrong-song", "live", "reupload", "cover"]


def test_joins_artists_and_drops_duplicates_and_malformed_rows():
    duet = {**SONG, "artists": [{"name": "A"}, {"name": "B"}, {"id": "no-name"}]}
    out = normalize_results([duet, SONG, {"title": "no id"}, "junk", VIDEO])
    assert [(t.id, t.artists) for t in out] == [("KP4tmbzrCEc", "A, B"), ("gAg3uMlNyHA", "Zia Mohajerjasbi")]
