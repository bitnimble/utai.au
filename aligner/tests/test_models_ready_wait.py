"""A job that arrives while the models are still loading waits for them,
streaming `loading` meanwhile, instead of being turned away; and the startup
check only offers the missing models, downloading them when asked."""

import asyncio

import app.provisioning as provisioning
from app.pipeline.provision import AssetCheck
from app.provisioning import Provisioner, ProvisionStatus


async def _job():
    yield {"type": "running"}
    yield {"type": "result"}


def test_a_job_during_loading_waits_then_runs() -> None:
    async def run() -> tuple[list[dict], list[dict], list[dict]]:
        status = ProvisionStatus([])
        during: list[dict] = []

        async def consume() -> None:
            async for envelope in status.once_loaded(_job()):
                during.append(envelope)

        task = asyncio.create_task(consume())
        await asyncio.sleep(0)
        before_loaded = list(during)
        status.set_loaded(True)
        await task
        return before_loaded, during, [e async for e in status.once_loaded(_job())]

    before_loaded, during, after = asyncio.run(run())
    assert before_loaded == [{"type": "loading"}]
    assert during == [{"type": "loading"}, {"type": "running"}, {"type": "result"}]
    assert after == [{"type": "running"}, {"type": "result"}]


def test_the_check_offers_only_what_is_missing_or_outdated() -> None:
    status = ProvisionStatus(["a.onnx", "b.onnx"])
    status.set_checked([AssetCheck("a.onnx", "current", 10), AssetCheck("b.onnx", "missing", 20)])
    snapshot = status.snapshot()
    assert snapshot["state"] == "available"
    assert [(a["name"], a["phase"], a["bytesTotal"]) for a in snapshot["assets"]] == [
        ("a.onnx", "current", 10),
        ("b.onnx", "missing", 20),
    ]

    everything_current = ProvisionStatus(["a.onnx"])
    everything_current.set_checked([AssetCheck("a.onnx", "current", 10)])
    assert everything_current.snapshot()["state"] == "ready"


def test_asking_to_download_downloads_then_reloads(monkeypatch) -> None:
    calls: list[str] = []
    monkeypatch.setattr(provisioning, "provision", lambda *caps, on_progress: calls.append("provision"))
    monkeypatch.setattr(provisioning, "reset_models", lambda: calls.append("reset"))
    monkeypatch.setattr(provisioning, "warm_models", lambda: calls.append("warm"))

    async def run() -> dict:
        provisioner = Provisioner()
        provisioner.status.set_checked([AssetCheck("a.onnx", "missing", 1)])
        provisioner.download()
        provisioner.download()
        assert provisioner.status.snapshot()["state"] == "downloading"
        await asyncio.gather(*provisioner._tasks)
        return provisioner.status.snapshot()

    snapshot = asyncio.run(run())
    assert calls == ["provision", "reset", "warm"]
    assert snapshot["state"] == "ready"
    assert snapshot["loaded"] is True


def test_a_reload_waits_for_the_running_gpu_job(monkeypatch) -> None:
    calls: list[str] = []
    monkeypatch.setattr(provisioning, "provision", lambda *caps, on_progress: None)
    monkeypatch.setattr(provisioning, "reset_models", lambda: calls.append("reset"))
    monkeypatch.setattr(provisioning, "warm_models", lambda: calls.append("warm"))

    async def run() -> None:
        provisioner = Provisioner()
        provisioner.status.set_checked([AssetCheck("a.onnx", "missing", 1)])
        await provisioner.gpu_lock.acquire()
        provisioner.download()
        for _ in range(5):
            await asyncio.sleep(0)
        calls.append("job done")
        provisioner.gpu_lock.release()
        await asyncio.gather(*provisioner._tasks)

    asyncio.run(run())
    assert calls == ["job done", "reset", "warm"]


def test_a_failed_reload_reports_the_error_and_reopens_the_gate(monkeypatch) -> None:
    def fail() -> None:
        raise OSError("disk gone")

    monkeypatch.setattr(provisioning, "provision", lambda *caps, on_progress: None)
    monkeypatch.setattr(provisioning, "reset_models", fail)

    async def run() -> dict:
        provisioner = Provisioner()
        provisioner.status.set_checked([AssetCheck("a.onnx", "missing", 1)])
        provisioner.download()
        await asyncio.gather(*provisioner._tasks)
        return provisioner.status.snapshot()

    snapshot = asyncio.run(run())
    assert snapshot["state"] == "error"
    assert snapshot["error"] == "disk gone"
    assert snapshot["loaded"] is True


def test_a_failed_download_keeps_the_loaded_models(monkeypatch) -> None:
    def fail(*caps, on_progress):
        raise RuntimeError("offline")

    monkeypatch.setattr(provisioning, "provision", fail)

    async def run() -> dict:
        provisioner = Provisioner()
        provisioner.status.set_checked([AssetCheck("a.onnx", "outdated", 1)])
        provisioner.status.set_loaded(True)
        provisioner.download()
        await asyncio.gather(*provisioner._tasks)
        return provisioner.status.snapshot()

    snapshot = asyncio.run(run())
    assert snapshot["state"] == "error"
    assert snapshot["error"] == "offline"
    assert snapshot["loaded"] is True
