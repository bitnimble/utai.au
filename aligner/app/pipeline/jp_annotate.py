"""Furigana and romaji for displaying Japanese lyrics, from the same readings
the aligner uses (`jp_romaji`). Dictionary-only: no model involved, so it
works whether or not alignment does.

A line arrives as its display words (one word for a line nothing aligned);
they're read together, so each reading has the whole line as context (実 is
じつ in 実は, not the lone み), then each word takes its own span back. A word
whose `reading` the aligner heard in the vocal shows that one instead.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.pipeline import jp_romaji
from app.pipeline.jp_romaji import Morpheme, is_han, is_kana, kana_romaji, morpheme_romaji

_CONTENT_POS1 = frozenset(
    {"名詞", "代名詞", "動詞", "形容詞", "形状詞", "副詞", "連体詞", "接続詞", "感動詞", "接頭辞"}
)


@dataclass
class Segment:
    """A run of base text, with the hiragana `reading` over it when it's a
    kanji run."""

    base: str
    reading: str | None = None


@dataclass
class WordAnnotation:
    segments: list[Segment]
    romaji: str


@dataclass
class LineAnnotation:
    words: list[WordAnnotation]
    # UTF-16 offsets into the joined words, past the first, where a bunsetsu
    # (a content word plus the particles and endings it carries) begins.
    phrase_starts: list[int]


@dataclass
class _RomajiWord:
    start: int
    end: int
    romaji: str


def annotate_line(words: list[tuple[str, str | None]]) -> LineAnnotation:
    """Annotate a line given as `(text, heard reading)` display words. A word
    shows the romaji of every romanized word that starts in it, so one the
    aligner split (やっ · て) reads whole on its first part (yatte) and the
    rest show none."""
    line = "".join(text for text, _ in words)
    if not _is_japanese(line):
        return LineAnnotation([WordAnnotation([Segment(text)], "") for text, _ in words], [])
    spans: list[tuple[int, int]] = []
    start = 0
    for text, _ in words:
        spans.append((start, start + len(text)))
        start += len(text)
    ms = _morphemes(line)
    heard ={span: reading for span, (_, reading) in zip(spans, words, strict=True) if reading}
    for m in ms:
        reading = heard.pop((m.start, m.end), None)
        if reading is not None:
            m.kana, m.romaji = reading, morpheme_romaji(reading, m.pos1, None)
    jp_romaji.geminate_all(ms)
    line_segments = _line_segments(line, ms)
    romaji_words = _romaji_words(ms)
    out = [
        _word(text, heard.get(span), span, line_segments, romaji_words)
        for (text, _), span in zip(words, spans, strict=True)
    ]
    return LineAnnotation(out, [_utf16_offset(line, i) for i in _phrase_starts(ms)])


def fit_furigana(surface: str, reading: str) -> list[Segment]:
    """Fit a hiragana `reading` onto the kanji runs of `surface`, leaving kana
    (okurigana) bare: 食べる / たべる -> 食=た · べる, 取り引き / とりひき ->
    取=と · り · 引=ひ · き, 今日 / きょう -> 今日=きょう. Each kana run must sit
    verbatim in the reading, pinning where the kanji run before it ends; when
    they don't line up the surface comes back bare, since a wrong reading
    reads worse than none."""
    runs: list[tuple[str, bool]] = []
    for ch in surface:
        kanji = _is_kanji(ch)
        if runs and runs[-1][1] == kanji:
            runs[-1] = (runs[-1][0] + ch, kanji)
        else:
            runs.append((ch, kanji))
    bare = [Segment(surface)]
    if not any(kanji for _, kanji in runs):
        return bare
    segments: list[Segment] = []
    ri = 0
    for i, (text, kanji) in enumerate(runs):
        if not kanji:
            if reading[ri : ri + len(text)] != text:
                return bare
            segments.append(Segment(text))
            ri += len(text)
            continue
        if i + 1 == len(runs):
            piece, ri = reading[ri:], len(reading)
        else:
            # A kanji run reads at least one kana; searching from `ri` would
            # anchor 笑わ / わらわ's okurigana on the reading's first わ.
            at = reading.find(runs[i + 1][0], ri + 1)
            if at < 0:
                return bare
            piece, ri = reading[ri:at], at
        if not piece:
            return bare
        segments.append(Segment(text, piece))
    return _merge_bare(segments) if ri == len(reading) else bare


def slice_segments(segments: list[Segment], start: int, end: int) -> list[Segment] | None:
    """The segments covering `[start, end)` of a line, bare runs cut to fit;
    None when a reading run straddles the span's edge, since a fitted reading
    can't be cut."""
    out: list[Segment] = []
    offset = 0
    for seg in segments:
        seg_start, seg_end = offset, offset + len(seg.base)
        offset = seg_end
        if seg_end <= start or seg_start >= end:
            continue
        if seg.reading is not None:
            if seg_start < start or seg_end > end:
                return None
            out.append(Segment(seg.base, seg.reading))
        else:
            out.append(Segment(seg.base[max(seg_start, start) - seg_start : min(seg_end, end) - seg_start]))
    return _merge_bare(out) if out else None


def _word(
    text: str,
    unmatched_reading: str | None,
    span: tuple[int, int],
    line_segments: list[Segment],
    romaji_words: list[_RomajiWord],
) -> WordAnnotation:
    """`unmatched_reading`: a heard reading for a word that isn't one
    morpheme of the line, so it couldn't stand in for one."""
    start, end = span
    if unmatched_reading:
        heard = fit_furigana(text, unmatched_reading)
        if _has_reading(heard):
            return WordAnnotation(heard, kana_romaji(unmatched_reading))
    segments = slice_segments(line_segments, start, end)
    if segments is None:
        # The word cuts through a morpheme (心 · 内 of 心内), so it reads on its
        # own, furigana and romaji alike.
        return annotate_line([(text, unmatched_reading)]).words[0]
    romaji = " ".join(w.romaji for w in romaji_words if start <= w.start < end)
    return WordAnnotation(segments, kana_romaji(unmatched_reading) if unmatched_reading else romaji)


def _morphemes(line: str) -> list[Morpheme]:
    """The morphemes of each kana / kanji run of `line`, read apart from the
    text around them the way the aligner reads them."""
    out: list[Morpheme] = []
    run_start: int | None = None
    for i, ch in enumerate([*line, ""]):
        if ch and (_is_kanji(ch) or _is_kana_char(ch)):
            if run_start is None:
                run_start = i
            continue
        if run_start is not None:
            for m in jp_romaji.morphemes(line[run_start:i]):
                m.start += run_start
                out.append(m)
            run_start = None
    return out


def _line_segments(line: str, ms: list[Morpheme]) -> list[Segment]:
    segments: list[Segment] = []
    cursor = 0
    for m in ms:
        if m.start > cursor:
            segments.append(Segment(line[cursor : m.start]))
        has_kanji = any(_is_kanji(c) for c in m.surface)
        segments.extend(fit_furigana(m.surface, m.kana) if m.kana and has_kanji else [Segment(m.surface)])
        cursor = m.end
    if cursor < len(line):
        segments.append(Segment(line[cursor:]))
    return _merge_bare(segments)


def _romaji_words(ms: list[Morpheme]) -> list[_RomajiWord]:
    """Romanized words: a morpheme's romaji with the ones it joins onto
    (inflections, auxiliaries)."""
    words: list[_RomajiWord] = []
    glue = False
    for m in ms:
        if not m.romaji:
            glue = False
            continue
        if glue and words:
            words[-1].romaji += m.romaji
            words[-1].end = m.end
        else:
            words.append(_RomajiWord(m.start, m.end, m.romaji))
        glue = m.joins_next
    return words


def _phrase_starts(ms: list[Morpheme]) -> list[int]:
    return [m.start for prev, m in zip(ms, ms[1:], strict=False) if _starts_phrase(m, prev)]


def _starts_phrase(m: Morpheme, prev: Morpheme) -> bool:
    if m.pos1 not in _CONTENT_POS1:
        return False
    if m.start > prev.end:
        return True
    if prev.pos1 == "接頭辞":
        return False
    # auxiliary verb / adjective after て (呼んで + いた, 来て + ほしい)
    if m.pos2 == "非自立可能" and prev.pos2 == "接続助詞":
        return False
    # compound noun (東京 + タワー), compound verb (走り + 続ける)
    if m.pos1 in ("名詞", "動詞") and prev.pos1 == m.pos1:
        return False
    # noun + する (愛 + する)
    return not (m.lemma == "為る" and prev.pos1 == "名詞")


def _is_japanese(line: str) -> bool:
    """Any kana, or kanji in a line that isn't marked as Chinese."""
    from app.pipeline.lyrics_align import _resolve_cjk_lang

    return any(_is_kana_char(c) for c in line) or (
        any(_is_kanji(c) for c in line) and _resolve_cjk_lang(line) == "ja"
    )


def _merge_bare(segments: list[Segment]) -> list[Segment]:
    out: list[Segment] = []
    for s in segments:
        if s.reading is None and out and out[-1].reading is None:
            out[-1] = Segment(out[-1].base + s.base)
        else:
            out.append(Segment(s.base, s.reading))
    return out


def _has_reading(segments: list[Segment]) -> bool:
    return any(s.reading is not None for s in segments)


def _is_kanji(ch: str) -> bool:
    return is_han(ord(ch))


def _is_kana_char(ch: str) -> bool:
    return is_kana(ord(ch))


def _utf16_offset(text: str, index: int) -> int:
    return len(text[:index].encode("utf-16-le")) // 2
