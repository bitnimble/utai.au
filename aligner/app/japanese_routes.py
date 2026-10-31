"""POST /lyrics/japanese: furigana, romaji and phrase starts for Japanese lyric
lines (`jp_annotate`). Dictionary-only, so it answers on any worker, with or
without models."""
from __future__ import annotations

import logging

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool

from app.models import (
    JapaneseLineOut,
    JapaneseRequest,
    JapaneseResponse,
    JapaneseWordOut,
    RubySegment,
)
from app.pipeline.jp_annotate import LineAnnotation, Segment, WordAnnotation, annotate_line

log = logging.getLogger(__name__)

router = APIRouter()


@router.post("/lyrics/japanese", response_model=JapaneseResponse)
async def japanese(body: JapaneseRequest) -> JapaneseResponse:
    return await run_in_threadpool(_annotate, body)


def _annotate(body: JapaneseRequest) -> JapaneseResponse:
    lines: list[JapaneseLineOut] = []
    for line in body.lines:
        words = [(w.text, w.reading) for w in line.words]
        try:
            ann = annotate_line(words)
        except Exception:
            # One unreadable line (a kana cutlet can't map) shows bare, not the batch.
            log.exception("lyrics/japanese: couldn't annotate %r", "".join(t for t, _ in words))
            ann = LineAnnotation([WordAnnotation([Segment(text)], "") for text, _ in words], [])
        lines.append(
            JapaneseLineOut(
                words=[
                    JapaneseWordOut(
                        segments=[RubySegment(base=s.base, reading=s.reading) for s in w.segments],
                        romaji=w.romaji,
                        romajiJoinsNext=w.romaji_joins_next,
                    )
                    for w in ann.words
                ],
                phraseStarts=ann.phrase_starts,
            )
        )
    return JapaneseResponse(lines=lines)
