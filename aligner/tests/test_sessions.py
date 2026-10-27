from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import app.sessions as sessions


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock(monkeypatch) -> FakeClock:
    fake = FakeClock()
    monkeypatch.setattr(sessions, "registry", sessions.SessionRegistry(clock=fake))
    return fake


@pytest.fixture
def client(clock) -> TestClient:
    app = FastAPI()
    app.include_router(sessions.router)
    return TestClient(app)


def _create(client: TestClient) -> tuple[str, str]:
    res = client.post("/sessions")
    assert res.status_code == 200
    body = res.json()
    return body["id"], body["hostToken"]


def _host_url(session_id: str, token: str) -> str:
    return f"/sessions/{session_id}/ws?role=host&token={token}"


def _remote_url(session_id: str) -> str:
    return f"/sessions/{session_id}/ws?role=remote"


def test_created_session_is_found_case_insensitively(client):
    session_id, token = _create(client)
    assert len(session_id) == 6
    assert set(session_id) <= set(sessions.SESSION_ID_ALPHABET)
    assert len(token) >= 16
    assert client.get(f"/sessions/{session_id.lower()}").json() == {
        "id": session_id,
        "publicUrl": None,
    }


def test_unknown_session_is_404(client):
    assert client.get("/sessions/ZZZZZZ").status_code == 404


def test_normalize_reads_ambiguous_letters_as_digits():
    assert sessions.normalize_session_id(" oil2ab ") == "0112AB"


def test_public_url_comes_from_settings(client, monkeypatch):
    monkeypatch.setattr(sessions.settings, "public_url", "https://karaoke.lan:5175")
    assert client.post("/sessions").json()["publicUrl"] == "https://karaoke.lan:5175"


def test_creation_is_refused_past_the_session_cap(client, monkeypatch):
    monkeypatch.setattr(sessions, "MAX_SESSIONS", 1)
    _create(client)
    assert client.post("/sessions").status_code == 503


def test_unknown_session_socket_closes_4404(client):
    with client.websocket_connect(_remote_url("ZZZZZZ")) as ws:
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
    assert exc.value.code == sessions.CLOSE_NO_SESSION


@pytest.mark.parametrize("token", ["", "wrong", "ü"])
def test_hosting_needs_the_host_token(client, token):
    session_id, _ = _create(client)
    with client.websocket_connect(_host_url(session_id, token)) as ws:
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
    assert exc.value.code == sessions.CLOSE_BAD_TOKEN


def test_relays_commands_state_and_replies(client):
    session_id, token = _create(client)
    with client.websocket_connect(_host_url(session_id, token)) as host:
        assert host.receive_json() == {
            "type": "hello",
            "clientId": "c1",
            "hostConnected": False,
            "state": None,
        }
        host.send_json({"type": "state", "state": {"queue": ["a"]}})
        with client.websocket_connect(_remote_url(session_id)) as remote:
            assert remote.receive_json() == {
                "type": "hello",
                "clientId": "c2",
                "hostConnected": True,
                "state": {"queue": ["a"]},
            }
            remote.send_json({"type": "command", "command": {"kind": "skip"}})
            assert host.receive_json() == {
                "type": "command",
                "from": "c2",
                "command": {"kind": "skip"},
            }
            host.send_json({"type": "reply", "to": "c2", "reply": {"ok": True}})
            assert remote.receive_json() == {"type": "reply", "reply": {"ok": True}}
            host.send_json({"type": "state", "state": {"queue": []}})
            assert remote.receive_json() == {"type": "state", "state": {"queue": []}}


def test_remotes_cannot_publish_state_or_replies(client):
    session_id, token = _create(client)
    with client.websocket_connect(_host_url(session_id, token)) as host:
        host.receive_json()
        with client.websocket_connect(_remote_url(session_id)) as remote:
            remote.receive_json()
            with client.websocket_connect(_remote_url(session_id)) as other:
                other.receive_json()
                remote.send_json({"type": "state", "state": {"queue": ["evil"]}})
                remote.send_json({"type": "reply", "to": "c3", "reply": {"ok": False}})
                host.send_json({"type": "state", "state": {"queue": ["real"]}})
                assert other.receive_json() == {"type": "state", "state": {"queue": ["real"]}}


def test_malformed_frames_are_ignored(client):
    session_id, token = _create(client)
    with client.websocket_connect(_host_url(session_id, token)) as host:
        host.receive_json()
        with client.websocket_connect(_remote_url(session_id)) as remote:
            remote.receive_json()
            remote.send_text("not json")
            remote.send_text("[1, 2]")
            remote.send_text("[" * 100_000)
            remote.send_text(" " * (sessions.MAX_FRAME_CHARS + 1))
            remote.send_bytes(b'{"type": "command", "command": "binary"}')
            remote.send_json({"type": "command", "command": {"kind": "play"}})
            assert host.receive_json()["command"] == {"kind": "play"}


def test_remotes_hear_host_leave_and_a_new_host_replaces_the_old(client):
    session_id, token = _create(client)
    with client.websocket_connect(_remote_url(session_id)) as remote:
        remote.receive_json()
        with client.websocket_connect(_host_url(session_id, token)) as first:
            first.receive_json()
            assert remote.receive_json() == {"type": "host", "connected": True}
            with client.websocket_connect(_host_url(session_id, token)) as second:
                assert second.receive_json()["hostConnected"] is True
                assert first.receive_json() == {"type": "replaced"}
                with pytest.raises(WebSocketDisconnect) as exc:
                    first.receive_json()
                assert exc.value.code == sessions.CLOSE_REPLACED
                remote.send_json({"type": "command", "command": {"kind": "play"}})
                assert second.receive_json()["command"] == {"kind": "play"}
        assert remote.receive_json() == {"type": "host", "connected": False}


def test_session_expires_after_an_idle_hour_without_clients(client, clock):
    session_id, token = _create(client)
    with client.websocket_connect(_host_url(session_id, token)) as host:
        host.receive_json()
        clock.now += 2 * sessions.SESSION_IDLE_TTL_SEC
        assert client.get(f"/sessions/{session_id}").status_code == 200
    clock.now += sessions.SESSION_IDLE_TTL_SEC - 1
    assert client.get(f"/sessions/{session_id}").status_code == 200
    clock.now += 1
    assert client.get(f"/sessions/{session_id}").status_code == 404
