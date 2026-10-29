"""Japanese-aware romanization for lyrics forced-alignment.

uroman (invoked inside `ctc_forced_aligner.preprocess_text`) reads
kanji as Chinese. This module pre-romanizes Japanese spans with cutlet
(on fugashi/MeCab + unidic-lite) so the aligner sees romaji that
matches the sung audio, while the original kana/kanji are preserved for
display.

The module is two layers:

  - Pure Unicode logic (`_normalize`, `_split_runs`): NFKC-normalize and
    partition a line into maximal Japanese vs non-Japanese runs. No
    third-party dependency; deterministic and unit-tested directly.
  - cutlet/fugashi morpheme romanization (`tokenize`): lazy-imported, so
    importing this module is cheap and a box without the Japanese stack
    can still import (and the caller degrades gracefully).
"""

from __future__ import annotations

import functools
import threading
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Japanese POS tags (unidic `pos1`) whose morphemes carry no spoken
# content - punctuation, symbols, whitespace. Dropped from both
# alignment and display, matching how `preprocess_text` strips
# punctuation on the English path.
_DROP_POS1 = frozenset({"補助記号", "空白", "記号"})

_READING_PARSES = 10
_KANJI_READINGS = Path(__file__).resolve().parent.parent / "data" / "kanji_readings.tsv"


def _normalize(text: str) -> str:
    """NFKC-normalize `text`.

    Folds full-width Latin / digits (`Ｌｏｖｅ`, `１２３`) to their ASCII
    forms *before* any script classification, so they take the
    non-Japanese path instead of being mistaken for a non-Latin run.
    """
    return unicodedata.normalize("NFKC", text)


def _is_kana(cp: int) -> bool:
    """Hiragana + katakana (incl. the prolonged sound mark ー at 0x30FC,
    which lives in the katakana block) and the katakana phonetic
    extensions. Kana is a definitive Japanese signal."""
    return (0x3040 <= cp <= 0x30FF) or (0x31F0 <= cp <= 0x31FF)


def _is_han(cp: int) -> bool:
    """CJK ideographs (kanji): the main block, Extension A, the
    compatibility block, and the iteration mark 々 (0x3005, e.g. 人々).
    Glyph-ambiguous between Japanese and Chinese on its own - the
    caller's `treat_kanji_as_japanese` flag decides a kanji-only run."""
    return (
        (0x4E00 <= cp <= 0x9FFF)
        or (0x3400 <= cp <= 0x4DBF)
        or (0xF900 <= cp <= 0xFAFF)
        or cp == 0x3005
    )


@dataclass
class Reading:
    """One way to read a token: `kana` (hiragana) for furigana, `romaji` for
    the aligner."""

    kana: str
    romaji: str


@dataclass
class JpToken:
    """One alignment unit produced by {@link tokenize}.

    `surface` is the original text for display (e.g. "君と" -> two tokens
    "君", "と"); `romaji` is the Latin form fed to the aligner (lowercase,
    ASCII, space-free). For non-Japanese tokens the two are identical.
    `readings` lists every reading the dictionary has for a kanji surface
    with more than one (生: せい, なま, ...), the in-context one (`romaji`)
    first, so the aligner can pick the one actually sung; empty otherwise.
    """

    surface: str
    romaji: str
    is_japanese: bool
    readings: list[Reading] = field(default_factory=list)


# Lazy cutlet singleton. Constructed on first `tokenize` call (loading
# the unidic-lite dictionary is not free); held for the process
# lifetime. `use_foreign_spelling=False` keeps loanword readings
# phonetic (カツカレー -> "katsu karee", not "Cutlet curry") so the
# romaji matches what is actually sung rather than the source-language
# spelling.
_cutlet_instance: Any | None = None
_cutlet_lock = threading.Lock()


def _cutlet() -> Any:
    global _cutlet_instance
    if _cutlet_instance is None:
        with _cutlet_lock:
            if _cutlet_instance is None:
                import cutlet  # type: ignore[import-not-found]  # lazy + optional

                _cutlet_instance = cutlet.Cutlet(use_foreign_spelling=False)
    return _cutlet_instance


def tokenize(text: str, *, treat_kanji_as_japanese: bool) -> list[JpToken]:
    """Tokenize a line into ordered {@link JpToken}s, romanizing Japanese.

    Japanese runs (per {@link _split_runs}) are segmented into morphemes
    by fugashi; each morpheme keeps its original surface for display and
    carries a contextual Japanese reading as `romaji`. Punctuation-only
    morphemes are dropped. Non-Japanese runs are whitespace-split and
    passed through verbatim (`romaji == surface`), so English is left
    for the existing aligner path untouched.

    Requires the cutlet/fugashi stack; callers that may run without it
    must guard the import (see `lyrics_align`'s graceful fallback).
    """
    tokens: list[JpToken] = []
    for run_text, is_japanese in _split_runs(
        text, treat_kanji_as_japanese=treat_kanji_as_japanese
    ):
        if is_japanese:
            # Copied out before `_readings` re-parses: fugashi nodes point into
            # the tagger's lattice, which the next parse overwrites.
            morphemes = [
                (node.surface, node.feature.kana, _squash(_cutlet().romaji_word(node)))
                for node in _cutlet().tagger(run_text)
                if node.feature.pos1 not in _DROP_POS1
            ]
            for i, (surface, kana, romaji) in enumerate(morphemes):
                if not romaji:
                    continue
                following = morphemes[i + 1][2] if i + 1 < len(morphemes) else ""
                readings = [
                    Reading(kana=r.kana, romaji=_geminate(r.romaji, following))
                    for r in _readings(surface, kana, romaji)
                ]
                tokens.append(
                    JpToken(
                        surface=surface,
                        romaji=_geminate(romaji, following),
                        is_japanese=True,
                        readings=readings,
                    )
                )
        else:
            for word in run_text.split():
                # Drop punctuation-only splits (e.g. a stray 、 or "-"
                # that fell into a non-Japanese run); the existing
                # English path strips these too via preprocess_text.
                if not any(c.isalnum() for c in word):
                    continue
                tokens.append(JpToken(surface=word, romaji=word, is_japanese=False))
    return tokens


def _squash(romaji: str) -> str:
    return "".join(romaji.split()).lower()


def _geminate(romaji: str, following: str) -> str:
    """Romaji ending in the sokuon っ (a stem cut off before its ending, 分かっ
    + て) with the consonant it doubles: wakat + te. Left as っ, uroman reads it
    as a whole "tsu" syllable."""
    if not romaji.endswith("っ"):
        return romaji
    doubled = "t" if following.startswith("ch") else following[:1]
    return romaji[:-1] + (doubled if doubled and doubled not in "aeiou" else "")


def _readings(surface: str, kana: str | None, romaji: str) -> list[Reading]:
    """The in-context reading, then the other dictionary readings of a kanji
    surface, deduplicated by romaji (ずくめ and づくめ sound alike). Empty when
    the surface has no kanji or only one reading."""
    if not kana or not any(_is_han(ord(c)) for c in surface):
        return []
    readings = [Reading(kana=_hiragana(kana), romaji=romaji)]
    for alt in [*_homographs(surface), *_okurigana_readings(surface)]:
        try:
            alt_romaji = _squash(_cutlet().map_kana(alt))
        except KeyError:  # kana cutlet has no romaji for
            continue
        if alt_romaji and all(alt_romaji != r.romaji for r in readings):
            readings.append(Reading(kana=alt, romaji=alt_romaji))
    return readings if len(readings) > 1 else []


def _homographs(surface: str) -> list[str]:
    """Readings of the dictionary entries spelled exactly `surface` (生: なま,
    せい, しょう, ...)."""
    return [
        _hiragana(parse[0].feature.kana)
        for parse in _cutlet().tagger.nbestToNodeList(surface, _READING_PARSES)
        if len(parse) == 1 and parse[0].feature.kana
    ]


def _okurigana_readings(surface: str) -> list[str]:
    """`surface` read with each reading its one kanji takes before the
    okurigana after it (尽くめ: つくめ, ずくめ, ことごとくめ)."""
    kanji = [i for i, c in enumerate(surface) if _is_han(ord(c))]
    if len(kanji) != 1 or kanji[0] + 1 >= len(surface):
        return []
    i = kanji[0]
    head, tail = surface[:i], surface[i + 1 :]
    return [head + r + tail for r in _kanji_readings().get(surface[i : i + 2], [])]


@functools.cache
def _kanji_readings() -> dict[str, list[str]]:
    table: dict[str, list[str]] = {}
    with _KANJI_READINGS.open(encoding="utf-8") as f:
        for line in f:
            key, readings = line.rstrip("\r\n").split("\t")
            table[key] = readings.split(" ")
    return table


def _hiragana(kana: str) -> str:
    return "".join(chr(ord(c) - 0x60) if 0x30A1 <= ord(c) <= 0x30F6 else c for c in kana)


def _split_runs(text: str, *, treat_kanji_as_japanese: bool) -> list[tuple[str, bool]]:
    """NFKC-normalize then partition `text` into maximal runs, each
    tagged `is_japanese`.

    Grouping is by script: contiguous kana/kanji characters form one
    CJK run, everything else (Latin, digits, punctuation, spaces) forms
    non-CJK runs. A CJK run is Japanese when it contains any kana, or
    when it is kanji-only and `treat_kanji_as_japanese` is set; this is
    why a kanji adjacent to kana (僕の心) stays one Japanese run while a
    bare kanji stretch (心) is gated by the flag. Non-CJK runs are never
    Japanese.
    """
    normalized = _normalize(text)
    runs: list[tuple[str, bool]] = []
    buf: list[str] = []
    buf_is_cjk: bool | None = None
    buf_has_kana = False

    def flush() -> None:
        if not buf:
            return
        is_japanese = (buf_has_kana or treat_kanji_as_japanese) if buf_is_cjk else False
        runs.append(("".join(buf), is_japanese))

    for ch in normalized:
        cp = ord(ch)
        is_kana = _is_kana(cp)
        is_cjk = is_kana or _is_han(cp)
        if buf_is_cjk is None or is_cjk == buf_is_cjk:
            buf.append(ch)
            buf_is_cjk = is_cjk
            buf_has_kana = buf_has_kana or is_kana
        else:
            flush()
            buf = [ch]
            buf_is_cjk = is_cjk
            buf_has_kana = is_kana
    flush()
    return runs
