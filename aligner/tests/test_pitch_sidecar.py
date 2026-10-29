"""Framing, latest-window hand-off and protocol pipes of the live pitch sidecar (no model)."""
from __future__ import annotations

import io
import subprocess
import sys
from pathlib import Path

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


_CLAIM_SCRIPT = """
import os, subprocess, sys
from app.pitch_sidecar import claim_protocol_streams

proto_in, proto_out = claim_protocol_streams()
os.write(1, b"native noise\\n")
print("stray print")
child = subprocess.run(
    [sys.executable, "-c", "import sys; print('child'); print(repr(sys.stdin.read()))"],
    timeout=30,
)
assert child.returncode == 0
proto_out.write("got " + proto_in.read(4).hex() + "\\n")
proto_out.flush()
"""


def test_protocol_pipes_carry_only_the_protocol():
    proc = subprocess.run(
        [sys.executable, "-u", "-c", _CLAIM_SCRIPT],
        cwd=Path(__file__).resolve().parents[1],
        input=b"\x01\x00\x00\x00",
        capture_output=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr.decode()
    assert proc.stdout.decode().replace("\r\n", "\n") == "got 01000000\n"
    stderr = proc.stderr.decode().replace("\r\n", "\n")
    assert "native noise\n" in stderr
    assert "stray print\n" in stderr
    assert "child\n''\n" in stderr
