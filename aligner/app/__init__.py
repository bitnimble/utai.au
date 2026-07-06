"""Utai karaoke backend.

Word-timed lyrics from a full mix + the caller's lyric text:

    audio bytes + lyric lines
        -> Mel-Band Roformer              (full mix -> vocals stem)
        -> CTC forced alignment (MMS-300m via ctc-forced-aligner)
                                          (align the caller's text to the vocals)
        -> word/line timings returned as structured data

The endpoint is forced-alignment only -- it never transcribes speech from
audio; the caller's lyric text is treated as ground truth and only the
timings are recomputed. See `app/main.py` (HTTP) and `app/comms/` (the stdio
sidecar) for the two transports.
"""
