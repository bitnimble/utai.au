"""Framing + latest-window hand-off for the live pitch sidecar (no model)."""
from __future__ import annotations

import io

import numpy as np

from app.pitch_sidecar import LatestWindow, read_exact


def test_read_exact_reads_all_bytes():
    assert read_exact(io.BytesIO(b"abcd"), 4) == b"abcd"


def test_read_exact_returns_none_on_short_read():
    assert read_exact(io.BytesIO(b"ab"), 4) is None


def test_latest_window_keeps_only_the_freshest():
    latest = LatestWindow()
    latest.set(np.array([1.0], dtype=np.float32))
    latest.set(np.array([2.0], dtype=np.float32))  # drops the first
    got = latest.take()
    assert got is not None and got[0] == 2.0


def test_latest_window_take_returns_none_after_close():
    latest = LatestWindow()
    latest.close()
    assert latest.take() is None
