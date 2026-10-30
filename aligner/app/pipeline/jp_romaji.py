"""The one Japanese reading stack: how each morpheme of a lyric reads, for
the aligner (romaji it can match against the vocal) and for display
(furigana and romaji, see `jp_annotate`).

uroman (invoked inside `ctc_forced_aligner.preprocess_text`) reads
kanji as Chinese, so Japanese spans are pre-romanized here with
fugashi/MeCab + unidic-lite, the original kana/kanji preserved for display.

The module is two layers:

  - Pure Unicode logic (`_normalize`, `_split_runs`): NFKC-normalize and
    partition a line into maximal Japanese vs non-Japanese runs.
  - Morphemes (`morphemes`, `tokenize`): each morpheme's in-context reading
    and romaji, plus the alternative readings the aligner can pick between.
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

# unidic-lite's in-context reading of these is wrong for lyrics nearly every
# time (私 as わたくし, 愛 before a verb as the prefix まな).
_LYRIC_READINGS = {"私": "わたし", "明日": "あした", "正気": "しょうき", "愛": "あい"}
# The pronoun 何 reads なん before a t / d / n sound (何で, 何の, 何だ), なに
# elsewhere (何を, 何か, 何に); unidic-lite reads it なん everywhere.
_NAN_BEFORE = frozenset("たちつてとだぢづでどなぬねの")


def _normalize(text: str) -> str:
    """NFKC-normalize `text`.

    Folds full-width Latin / digits (`Ｌｏｖｅ`, `１２３`) to their ASCII
    forms *before* any script classification, so they take the
    non-Japanese path instead of being mistaken for a non-Latin run.
    """
    return unicodedata.normalize("NFKC", text)


def is_kana(cp: int) -> bool:
    """Hiragana + katakana (incl. the prolonged sound mark ー at 0x30FC,
    which lives in the katakana block) and the katakana phonetic
    extensions. Kana is a definitive Japanese signal."""
    return (0x3040 <= cp <= 0x30FF) or (0x31F0 <= cp <= 0x31FF)


def is_han(cp: int) -> bool:
    """CJK ideographs (kanji): the main block, Extensions A and B, the
    compatibility block, and the iteration mark 々 (0x3005, e.g. 人々).
    Glyph-ambiguous between Japanese and Chinese on its own - the
    caller's `treat_kanji_as_japanese` flag decides a kanji-only run."""
    return (
        (0x4E00 <= cp <= 0x9FFF)
        or (0x3400 <= cp <= 0x4DBF)
        or (0xF900 <= cp <= 0xFAFF)
        or (0x20000 <= cp <= 0x2A6DF)
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
    `kana` is the in-context hiragana reading of a Japanese token, None when
    it has none. `readings` lists every reading the dictionary has for a
    kanji surface with more than one (生: せい, なま, ...), the in-context one
    first, so the aligner can pick the one actually sung; empty otherwise.
    """

    surface: str
    romaji: str
    is_japanese: bool
    kana: str | None = None
    readings: list[Reading] = field(default_factory=list)


@dataclass
class Morpheme:
    """One morpheme of a line, `start` its index in the line. `kana` is its
    in-context hiragana reading (None for symbols, Latin and kanji nothing
    could read) and `romaji` that reading romanized ('' when it has none).
    `joins_next`: its romaji runs straight into the next morpheme's as one
    word (行っ + た -> itta)."""

    surface: str
    start: int
    kana: str | None
    romaji: str
    pos1: str
    pos2: str
    lemma: str
    joins_next: bool

    @property
    def end(self) -> int:
        return self.start + len(self.surface)


# Lazy cutlet singleton. Constructed on first use (loading the unidic-lite
# dictionary is not free); held for the process lifetime. cutlet supplies the
# tagger, its kana -> romaji table and its romaji word spacing.
_cutlet_instance: Any | None = None
_cutlet_lock = threading.Lock()
# MeCab's tagger isn't thread-safe, and its nodes point into a lattice the next
# parse overwrites; /lyrics/japanese parses beside a running alignment.
_tagger_lock = threading.Lock()


def _cutlet() -> Any:
    global _cutlet_instance
    if _cutlet_instance is None:
        with _cutlet_lock:
            if _cutlet_instance is None:
                import cutlet  # type: ignore[import-not-found]

                _cutlet_instance = cutlet.Cutlet(use_foreign_spelling=False)
    return _cutlet_instance


def morphemes(text: str) -> list[Morpheme]:
    """Every morpheme of `text` (symbols and Latin included), in order."""
    out: list[Morpheme] = []
    with _tagger_lock:
        nodes = _cutlet().tagger(text)
        # Only for the spacing: each token's romaji comes from `_kana` instead.
        spacing = _cutlet().romaji_tokens(nodes, capitalize=False)
        cursor = 0
        for i, node in enumerate(nodes):
            start = cursor + len(node.white_space)
            cursor = start + len(node.surface)
            kana = _kana(nodes, i)
            f = node.feature
            out.append(
                Morpheme(
                    surface=node.surface,
                    start=start,
                    kana=kana,
                    romaji=morpheme_romaji(kana, f.pos1, f.pron),
                    pos1=f.pos1 or "",
                    pos2=f.pos2 or "",
                    lemma=f.lemma or "",
                    joins_next=not spacing[i].space,
                )
            )
    geminate_all(out)
    return out


def geminate_all(ms: list[Morpheme]) -> None:
    """Resolve each romaji ending in っ against the morpheme after it."""
    for i, m in enumerate(ms):
        m.romaji = _geminate(m.romaji, ms[i + 1].romaji if i + 1 < len(ms) else "")


def kana_romaji(kana: str) -> str:
    """Hepburn romaji for kana; kanji are dropped, anything else that isn't
    kana passes through."""
    out = ""
    for run, kana_run in _kana_runs(_hiragana(kana)):
        if kana_run:
            try:
                out += _cutlet().map_kana(run)
            except KeyError:  # a kana cutlet has no romaji for
                continue
        else:
            out += "".join(c for c in run if not is_han(ord(c)))
    return _squash(out).replace("っ", "")


def tokenize(text: str, *, treat_kanji_as_japanese: bool) -> list[JpToken]:
    """Tokenize a line into ordered {@link JpToken}s, romanizing Japanese.

    Japanese runs (per {@link _split_runs}) are segmented into morphemes;
    each keeps its original surface for display and carries its in-context
    reading as `romaji`. Punctuation-only morphemes are dropped. Non-Japanese
    runs are whitespace-split and passed through verbatim (`romaji ==
    surface`), so English is left for the existing aligner path untouched.
    """
    tokens: list[JpToken] = []
    for run_text, is_japanese in _split_runs(
        text, treat_kanji_as_japanese=treat_kanji_as_japanese
    ):
        if is_japanese:
            spoken = [m for m in morphemes(run_text) if m.pos1 not in _DROP_POS1 and m.romaji]
            for i, m in enumerate(spoken):
                following = spoken[i + 1].romaji if i + 1 < len(spoken) else ""
                tokens.append(
                    JpToken(
                        surface=m.surface,
                        romaji=m.romaji,
                        is_japanese=True,
                        kana=m.kana,
                        readings=_readings(m.surface, m.kana, m.romaji, following),
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


def _kana(nodes: list[Any], i: int) -> str | None:
    """Hiragana reading of `nodes[i]` in its line."""
    node = nodes[i]
    surface = node.surface
    if surface in _LYRIC_READINGS:
        return _LYRIC_READINGS[surface]
    kana = node.feature.kana
    if not kana:
        if node.is_unk and any(is_kana(ord(c)) for c in surface):
            return _hiragana(surface)
        return _unread_kanji_reading(surface, nodes[i + 1].surface if i + 1 < len(nodes) else "")
    kana = _hiragana(kana)
    if surface == "何" and node.feature.pos1 == "代名詞":
        following = _hiragana(nodes[i + 1].feature.kana or "") if i + 1 < len(nodes) else ""
        return "なん" if following[:1] in _NAN_BEFORE and following else "なに"
    # 行っ is the shared stem of 行く and 行う (行った); unidic picks 行う, lyrics mean 行く.
    if node.feature.lemma == "行う" and surface.startswith("行っ"):
        return "いっ" + kana.removeprefix("おこなっ")
    return kana


def _unread_kanji_reading(surface: str, following: str) -> str | None:
    """A single kanji the dictionary doesn't know (嗤 before って), read the way
    JMdict reads it before the same kana."""
    if len(surface) != 1 or not is_han(ord(surface)) or not following:
        return None
    readings = _kanji_readings().get(surface + following[0])
    return readings[0] if readings else None


def morpheme_romaji(kana: str | None, pos1: str | None, pron: str | None) -> str:
    """Romaji of a morpheme read `kana`, with the は / へ / を particles as
    pronounced (wa / e / o). A trailing っ stays for {@link geminate_all}."""
    if not kana:
        return ""
    if pos1 == "助詞":
        particle = {"ワ": "wa", "エ": "e", "オ": "o"}.get(pron or "")
        if particle:
            return particle
    try:
        return _squash(_cutlet().map_kana(kana))
    except KeyError:  # a kana cutlet has no romaji for
        return ""


def _kana_runs(text: str) -> list[tuple[str, bool]]:
    runs: list[tuple[str, bool]] = []
    for ch in text:
        kana_char = is_kana(ord(ch))
        if runs and runs[-1][1] == kana_char:
            runs[-1] = (runs[-1][0] + ch, kana_char)
        else:
            runs.append((ch, kana_char))
    return runs


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


def _readings(surface: str, kana: str | None, romaji: str, following: str) -> list[Reading]:
    """The in-context reading, then the other dictionary readings of a kanji
    surface, deduplicated by romaji (ずくめ and づくめ sound alike). Empty when
    the surface has no kanji or only one reading. `romaji` is already
    resolved against `following`, the romaji after it."""
    if not kana or not any(is_han(ord(c)) for c in surface):
        return []
    readings = [Reading(kana=kana, romaji=romaji)]
    for alt in [*_homographs(surface), *_okurigana_readings(surface)]:
        try:
            alt_romaji = _geminate(_squash(_cutlet().map_kana(alt)), following)
        except KeyError:  # kana cutlet has no romaji for
            continue
        if alt_romaji and all(alt_romaji != r.romaji for r in readings):
            readings.append(Reading(kana=alt, romaji=alt_romaji))
    return readings if len(readings) > 1 else []


def _homographs(surface: str) -> list[str]:
    """Readings of the dictionary entries spelled exactly `surface` (生: なま,
    せい, しょう, ...), names (一人 as かずと) aside."""
    with _tagger_lock:
        return [
            _hiragana(parse[0].feature.kana)
            for parse in _cutlet().tagger.nbestToNodeList(surface, _READING_PARSES)
            if len(parse) == 1 and parse[0].feature.kana and parse[0].feature.pos2 != "固有名詞"
        ]


def _okurigana_readings(surface: str) -> list[str]:
    """`surface` read with each reading its one kanji takes before the
    okurigana after it (尽くめ: つくめ, ずくめ, ことごとくめ)."""
    kanji = [i for i, c in enumerate(surface) if is_han(ord(c))]
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
        kana_char = is_kana(cp)
        is_cjk = kana_char or is_han(cp)
        if buf_is_cjk is None or is_cjk == buf_is_cjk:
            buf.append(ch)
            buf_is_cjk = is_cjk
            buf_has_kana = buf_has_kana or kana_char
        else:
            flush()
            buf = [ch]
            buf_is_cjk = is_cjk
            buf_has_kana = kana_char
    flush()
    return runs
