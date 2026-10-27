"""`/sessions/*`: karaoke sessions, one playback host plus any number of remotes.

The server is a relay and knows nothing about what it carries. The host owns
the queue and playback and publishes its state; remotes send commands to the
host and get its state (and its replies, e.g. search results) back.

    POST /sessions              -> {"id", "publicUrl"}
    GET  /sessions/{id}         -> {"id", "publicUrl"} | 404
    WS   /sessions/{id}/ws?role=host|remote

Frames (JSON text):
    server -> any     {"type": "hello", "clientId", "hostConnected", "state"}
    server -> remote  {"type": "state", "state"} | {"type": "host", "connected"}
                      | {"type": "reply", "reply"}
    server -> host    {"type": "command", "from", "command"}
    server -> host    {"type": "replaced"}, then close: another host took over
    host -> server    {"type": "state", "state"} | {"type": "reply", "to", "reply"}
    remote -> server  {"type": "command", "command"}

An unknown session id closes the socket with code 4404. A session with no
connected clients for an hour is dropped.

`src-tauri/src/session_server.rs` serves the same protocol for the desktop app.
"""
from __future__ import annotations

import itertools
import json
import secrets
import time
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from app.config import settings

SESSION_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
SESSION_ID_LENGTH = 6
SESSION_IDLE_TTL_SEC = 60 * 60
CLOSE_NO_SESSION = 4404
CLOSE_REPLACED = 4000

Role = Literal["host", "remote"]


def normalize_session_id(raw: str) -> str:
    """Crockford-style: case-insensitive, with O/I/L read as 0/1/1."""
    return raw.strip().upper().replace("O", "0").replace("I", "1").replace("L", "1")


@dataclass
class Session:
    id: str
    idle_since: float | None
    host: WebSocket | None = None
    remotes: dict[str, WebSocket] = field(default_factory=dict)
    state: Any = None

    def has_clients(self) -> bool:
        return self.host is not None or bool(self.remotes)


class SessionRegistry:
    def __init__(
        self,
        idle_ttl_sec: float = SESSION_IDLE_TTL_SEC,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._sessions: dict[str, Session] = {}
        self._client_ids = itertools.count(1)
        self._idle_ttl_sec = idle_ttl_sec
        self._clock = clock

    def create(self) -> Session:
        self._sweep()
        while True:
            session_id = "".join(
                secrets.choice(SESSION_ID_ALPHABET) for _ in range(SESSION_ID_LENGTH)
            )
            if session_id not in self._sessions:
                break
        session = Session(id=session_id, idle_since=self._clock())
        self._sessions[session_id] = session
        return session

    def get(self, raw_id: str) -> Session | None:
        self._sweep()
        return self._sessions.get(normalize_session_id(raw_id))

    def next_client_id(self) -> str:
        return f"c{next(self._client_ids)}"

    def mark_active(self, session: Session) -> None:
        session.idle_since = None

    def mark_idle_if_empty(self, session: Session) -> None:
        if not session.has_clients():
            session.idle_since = self._clock()

    def _sweep(self) -> None:
        cutoff = self._clock() - self._idle_ttl_sec
        expired = [
            sid
            for sid, s in self._sessions.items()
            if s.idle_since is not None and s.idle_since <= cutoff
        ]
        for sid in expired:
            del self._sessions[sid]


registry = SessionRegistry()
router = APIRouter(prefix="/sessions", tags=["sessions"])


def _describe(session: Session) -> dict[str, Any]:
    return {"id": session.id, "publicUrl": settings.public_url or None}


@router.post("")
async def create_session() -> dict[str, Any]:
    return _describe(registry.create())


@router.get("/{session_id}")
async def get_session(session_id: str) -> dict[str, Any]:
    session = registry.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="No such session.")
    return _describe(session)


@router.websocket("/{session_id}/ws")
async def session_socket(ws: WebSocket, session_id: str, role: Role = "remote") -> None:
    await ws.accept()
    session = registry.get(session_id)
    if session is None:
        await ws.close(code=CLOSE_NO_SESSION)
        return

    client_id = registry.next_client_id()
    await _send(
        ws,
        {
            "type": "hello",
            "clientId": client_id,
            "hostConnected": session.host is not None,
            "state": session.state,
        },
    )
    if role == "host":
        previous = session.host
        session.host = ws
        if previous is not None:
            await _send(previous, {"type": "replaced"})
            with suppress(Exception):
                await previous.close(code=CLOSE_REPLACED)
        else:
            await _broadcast(session, {"type": "host", "connected": True})
    else:
        session.remotes[client_id] = ws
    registry.mark_active(session)

    try:
        while True:
            message = _parse(await ws.receive_text())
            if message is not None:
                await _route(session, ws, role, client_id, message)
    except WebSocketDisconnect:
        pass
    finally:
        if role == "host":
            if session.host is ws:
                session.host = None
                await _broadcast(session, {"type": "host", "connected": False})
        else:
            session.remotes.pop(client_id, None)
        registry.mark_idle_if_empty(session)


async def _route(
    session: Session, ws: WebSocket, role: Role, client_id: str, message: dict[str, Any]
) -> None:
    kind = message.get("type")
    if role == "host":
        if session.host is not ws:
            return
        if kind == "state":
            session.state = message.get("state")
            await _broadcast(session, {"type": "state", "state": session.state})
        elif kind == "reply":
            target = session.remotes.get(str(message.get("to")))
            if target is not None:
                await _send(target, {"type": "reply", "reply": message.get("reply")})
    elif kind == "command" and session.host is not None:
        await _send(
            session.host,
            {"type": "command", "from": client_id, "command": message.get("command")},
        )


async def _broadcast(session: Session, message: dict[str, Any]) -> None:
    for remote in list(session.remotes.values()):
        await _send(remote, message)


async def _send(ws: WebSocket, message: dict[str, Any]) -> None:
    # A peer that's mid-disconnect must not take down the sender's loop.
    with suppress(Exception):
        await ws.send_text(json.dumps(message))


def _parse(text: str) -> dict[str, Any] | None:
    try:
        message = json.loads(text)
    except json.JSONDecodeError:
        return None
    return message if isinstance(message, dict) else None
