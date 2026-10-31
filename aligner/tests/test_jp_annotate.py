"""Tests for `app.pipeline.jp_annotate` and POST /lyrics/japanese."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.japanese_routes import router
from app.pipeline.jp_annotate import Segment, annotate_line, fit_furigana, slice_segments


def _shown(*words: str | tuple[str, str]) -> list[tuple[list[tuple[str, str | None]], str]]:
    ann = annotate_line([w if isinstance(w, tuple) else (w, None) for w in words])
    return [([(s.base, s.reading) for s in w.segments], w.romaji) for w in ann.words]


def test_fit_furigana_puts_the_reading_over_the_kanji_only():
    assert fit_furigana("食べる", "たべる") == [Segment("食", "た"), Segment("べる")]
    assert fit_furigana("取り引き", "とりひき") == [
        Segment("取", "と"),
        Segment("り"),
        Segment("引", "ひ"),
        Segment("き"),
    ]
    assert fit_furigana("お前", "おまえ") == [Segment("お"), Segment("前", "まえ")]


def test_fit_furigana_keeps_a_compound_whole():
    assert fit_furigana("今日", "きょう") == [Segment("今日", "きょう")]
    assert fit_furigana("日々", "ひび") == [Segment("日々", "ひび")]


def test_fit_furigana_anchors_okurigana_that_also_starts_the_reading():
    assert fit_furigana("笑わ", "わらわ") == [Segment("笑", "わら"), Segment("わ")]
    assert fit_furigana("失う", "うしなう") == [Segment("失", "うしな"), Segment("う")]


def test_fit_furigana_shows_bare_text_when_the_reading_does_not_fit():
    assert fit_furigana("見る", "みた") == [Segment("見る")]
    assert fit_furigana("見る", "みるある") == [Segment("見る")]
    assert fit_furigana("する", "する") == [Segment("する")]


def test_slice_segments_cuts_bare_runs_but_not_readings():
    line = [Segment("取", "と"), Segment("り"), Segment("引", "ひ"), Segment("き")]
    assert slice_segments(line, 0, 2) == [Segment("取", "と"), Segment("り")]
    assert slice_segments([Segment("私実は")], 1, 2) == [Segment("実")]
    assert slice_segments([Segment("盲目的", "もうもくてき")], 0, 2) is None


def test_reads_a_compound_the_line_tokenizes_whole():
    assert _shown("裂けた心内環境を")[0][0][2:4] == [("心内", "しんない"), ("環境", "かんきょう")]


def test_reads_each_word_in_the_context_of_the_line():
    assert _shown("本当", "に") == [([("本当", "ほんとう")], "hontou"), ([("に", None)], "ni")]
    assert _shown("君と", "二人") == [
        ([("君", "きみ"), ("と", None)], "kimi to"),
        ([("二人", "ふたり")], "futari"),
    ]


def test_a_word_shows_the_romaji_of_its_own_span():
    assert [romaji for _, romaji in _shown("どう", "やっ", "て")] == ["dou", "yat", "te"]
    assert [romaji for _, romaji in _shown("堂々", "さらし", "た", "罪", "の", "群れ", "と")] == [
        "doudou",
        "sarashi",
        "ta",
        "tsumi",
        "no",
        "mure",
        "to",
    ]
    assert _shown("君と二人で行った")[0][1] == "kimi to futari de itta"
    assert _shown("嗤ってきた奴ら")[0] == (
        [("嗤", "わら"), ("ってきた", None), ("奴", "やつ"), ("ら", None)],
        "waratte kita yatsura",
    )


def test_romaji_joins_next_only_across_one_romanized_word():
    ann = annotate_line([("どう", None), ("やっ", None), ("て", None), ("空", None)])
    assert [w.romaji_joins_next for w in ann.words] == [False, True, False, False]
    before_punctuation = annotate_line([("やっ", None), ("、", None), ("て", None)])
    assert [w.romaji_joins_next for w in before_punctuation.words] == [False, False, False]


def test_a_word_cutting_a_morpheme_reads_on_its_own_in_furigana_and_romaji():
    assert _shown("心", "内") == [([("心", "こころ")], "kokoro"), ([("内", "うち")], "uchi")]


def test_a_word_cutting_a_bare_morpheme_shows_its_share_of_the_romaji():
    ann = annotate_line([("あり", None), ("がとう", None)])
    assert [(w.romaji, w.romaji_joins_next) for w in ann.words] == [("ari", True), ("gatou", False)]


def test_a_word_cut_right_after_a_sokuon_keeps_the_doubled_consonant():
    ann = annotate_line([("ちょっ", None), ("と", None)])
    assert [(w.romaji, w.romaji_joins_next) for w in ann.words] == [("chot", True), ("to", False)]


def test_a_heard_word_inside_a_morpheme_still_joins_the_next():
    ann = annotate_line([("生き", "いき"), ("る", None)])
    assert [(w.romaji, w.romaji_joins_next) for w in ann.words] == [("iki", True), ("ru", False)]


def test_phrase_starts_count_utf16_units_past_an_astral_kanji():
    line = "𠮷の空"
    ann = annotate_line([(line, None)])
    assert ann.phrase_starts == [line.encode("utf-16-le").index("空".encode("utf-16-le")) // 2]


def test_a_heard_reading_wins_over_the_dictionary():
    shown = _shown("上がっ", "て", "いる", "、", ("生", "せい"), "。")
    assert shown[4] == ([("生", "せい")], "sei")
    assert shown[0] == ([("上", "あ"), ("がっ", None)], "agat")


def test_katakana_okurigana_reads_as_the_word_it_spells():
    assert _shown("回レ回レ") == [([("回", "まわ"), ("レ", None), ("回", "まわ"), ("レ", None)], "maware maware")]
    assert _shown("美シイ")[0] == ([("美", "うつく"), ("シイ", None)], "utsukushii")
    assert _shown("愛シテル")[0] == ([("愛", "あい"), ("シテル", None)], "aishiteru")
    assert _shown("泣カナイデ")[0] == ([("泣", "な"), ("カナイデ", None)], "nakanaide")


def test_a_word_split_off_its_katakana_okurigana_keeps_the_reading():
    assert _shown("回", "レ", "!") == [([("回", "まわ")], "mawa"), ([("レ", None)], "re"), ([("!", None)], "")]


def test_a_heard_reading_fits_over_katakana_okurigana():
    assert _shown(("回レ", "まわれ"))[0] == ([("回", "まわ"), ("レ", None)], "maware")


def test_katakana_particles_read_as_particles():
    assert _shown("僕ハ君ヲ")[0] == ([("僕", "ぼく"), ("ハ", None), ("君", "きみ"), ("ヲ", None)], "boku wa kimi o")


def test_a_katakana_loanword_after_kanji_stays_itself():
    assert _shown("東京タワー")[0] == ([("東京", "とうきょう"), ("タワー", None)], "toukyou tawaa")
    assert _shown("英語テスト")[0] == ([("英語", "えいご"), ("テスト", None)], "eigo tesuto")
    assert _shown("白ワイン")[0] == ([("白", "しろ"), ("ワイン", None)], "shiro wain")
    assert _shown("金メダル")[0][1] == "kin medaru"
    assert _shown("白シャツ")[0] == ([("白", "しろ"), ("シャツ", None)], "shiro shatsu")
    assert _shown("恋ハナ")[0] == ([("恋", "こい"), ("ハナ", None)], "koi hana")


def test_latin_and_punctuation_stay_bare_and_unromanized():
    assert _shown("愛 don't KNOW 上に") == [
        ([("愛", "あい"), (" don't KNOW ", None), ("上", "うえ"), ("に", None)], "ai ue ni")
    ]


def test_a_line_marked_as_chinese_is_left_bare():
    assert _shown("这是我的心") == [([("这是我的心", None)], "")]


def test_phrases_start_at_content_words_past_their_particles_and_endings():
    ann = annotate_line([("君の名前を呼んでいたんだずっと遠い空", None)])
    line = "君の名前を呼んでいたんだずっと遠い空"
    assert [line[i] for i in ann.phrase_starts] == ["名", "呼", "ず", "遠", "空"]


def test_route_annotates_each_line():
    app = FastAPI()
    app.include_router(router)
    res = TestClient(app).post(
        "/lyrics/japanese",
        json={
            "lines": [
                {"words": [{"text": "生", "reading": "せい"}]},
                {"words": [{"text": "hello"}]},
                {"words": [{"text": "やっ"}, {"text": "て"}]},
            ]
        },
    )
    assert res.status_code == 200
    assert res.json() == {
        "lines": [
            {
                "words": [{"segments": [{"base": "生", "reading": "せい"}], "romaji": "sei", "romajiJoinsNext": False}],
                "phraseStarts": [],
            },
            {
                "words": [{"segments": [{"base": "hello", "reading": None}], "romaji": "", "romajiJoinsNext": False}],
                "phraseStarts": [],
            },
            {
                "words": [
                    {"segments": [{"base": "やっ", "reading": None}], "romaji": "yat", "romajiJoinsNext": True},
                    {"segments": [{"base": "て", "reading": None}], "romaji": "te", "romajiJoinsNext": False},
                ],
                "phraseStarts": [],
            },
        ]
    }
