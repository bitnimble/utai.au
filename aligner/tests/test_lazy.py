from __future__ import annotations

from app.lazy import Lazy


def test_a_value_is_built_once_until_reset() -> None:
    builds = iter([1, 2])
    lazy = Lazy(lambda: next(builds))
    assert (lazy.get(), lazy.get()) == (1, 1)
    lazy.reset()
    assert lazy.get() == 2


def test_a_none_build_is_retried() -> None:
    results = iter([None, "model"])
    lazy = Lazy(lambda: next(results))
    assert lazy.get() is None
    assert lazy.get() == "model"
    assert lazy.get() == "model"
