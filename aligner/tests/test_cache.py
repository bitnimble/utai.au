from __future__ import annotations

from app.cache import BlobCache


def test_put_evicts_lru_but_never_the_entry_just_written(tmp_path):
    cache = BlobCache(tmp_path, cap_bytes=10)
    cache.put_bytes("a", b"12345")
    cache.put_bytes("b", b"12345")

    big = cache.put_bytes("c", b"x" * 20)

    assert big.read_bytes() == b"x" * 20
    assert cache.get("c") == big
    assert cache.get("a") is None
    assert cache.get("b") is None
