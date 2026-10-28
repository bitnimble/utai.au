"""The long-lived sidecar builds the vocals separator once for every runner, and
never drives it from two job threads at the same time."""

import threading
import time

from app.comms.align_lyrics_runner import AlignLyricsRunner
from app.comms.core import Cancelled, CancelToken
from app.comms.runners import build_registry
from app.comms.separate_stems_runner import SeparateStemsRunner
from app.comms.shared_separator import SharedSeparator
from app.pipeline import separate


class _FakeSeparator:
    built = 0

    def __init__(self) -> None:
        type(self).built += 1
        self.active = 0
        self.max_active = 0

    def work(self) -> None:
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        time.sleep(0.02)
        self.active -= 1


def test_runners_share_one_separator(monkeypatch) -> None:
    monkeypatch.setattr(separate, "Separator", _FakeSeparator)
    _FakeSeparator.built = 0
    registry = build_registry()
    align, stems = registry["alignLyrics"], registry["separateStems"]
    assert isinstance(align, AlignLyricsRunner)
    assert isinstance(stems, SeparateStemsRunner)

    a = align._separator.use(lambda s: s)
    b = stems._separator.use(lambda s: s)

    assert a is b
    assert _FakeSeparator.built == 1


def test_concurrent_jobs_take_turns(monkeypatch) -> None:
    monkeypatch.setattr(separate, "Separator", _FakeSeparator)
    shared = SharedSeparator()
    threads = [threading.Thread(target=shared.use, args=(lambda s: s.work(),)) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert shared.use(lambda s: s.max_active) == 1


def test_a_job_cancelled_while_queued_skips_its_separation(monkeypatch) -> None:
    monkeypatch.setattr(separate, "Separator", _FakeSeparator)
    shared = SharedSeparator()
    first_running, release_first = threading.Event(), threading.Event()
    first = threading.Thread(
        target=shared.use, args=(lambda _: (first_running.set(), release_first.wait()),)
    )
    first.start()
    first_running.wait()

    token = CancelToken()
    ran: list[bool] = []
    raised: list[BaseException] = []

    def queued() -> None:
        try:
            shared.use(lambda _: ran.append(True), token)
        except Cancelled as exc:
            raised.append(exc)

    second = threading.Thread(target=queued)
    second.start()
    time.sleep(0.05)
    token.cancel()
    release_first.set()
    first.join()
    second.join()

    assert ran == []
    assert len(raised) == 1
