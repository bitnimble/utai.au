"""Karaoke sessions: one playback host plus any number of remotes, through a relay
that forwards payloads untouched.

`POST /sessions` returns the session's `hostToken`, which only the creator gets;
a `role=host` socket must pass it as `?token=`, so knowing the code alone only
lets you join as a remote.

Frames (JSON text):
    server -> any     {"type": "hello", "clientId", "hostConnected", "state"}
    server -> remote  {"type": "state", "state"} | {"type": "host", "connected"}
                      | {"type": "reply", "reply"}
    server -> host    {"type": "command", "from", "command"}
    server -> host    {"type": "replaced"}, then close 4000: another host took over
    host -> server    {"type": "state", "state"} | {"type": "reply", "to", "reply"}
    remote -> server  {"type": "command", "command"}

An unknown session closes the socket with 4404, a wrong host token with 4403. A
session with no connected clients for an hour is dropped.

`src-tauri/src/session_server.rs` serves the same protocol for the desktop app.
"""
from __future__ import annotations

import asyncio
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
MAX_SESSIONS = 1000
MAX_FRAME_CHARS = 1_000_000
CLOSE_NO_SESSION = 4404
CLOSE_BAD_TOKEN = 4403
CLOSE_REPLACED = 4000

Role = Literal["host", "remote"]


def normalize_session_id(raw: str) -> str:
    """Crockford-style: case-insensitive, with O/I/L read as 0/1/1."""
    return raw.strip().upper().replace("O", "0").replace("I", "1").replace("L", "1")


@dataclass
class Client:
    id: str
    ws: WebSocket
    # Each client has its own writer, so a remote that stops reading only backs up its own queue.
    outbox: asyncio.Queue[str | int] = field(default_factory=asyncio.Queue)

    def send(self, message: dict[str, Any]) -> None:
        self.outbox.put_nowait(json.dumps(message))

    def close(self, code: int) -> None:
        self.outbox.put_nowait(code)


@dataclass
class Session:
    id: str
    host_token: str
    idle_since: float | None
    host: Client | None = None
    remotes: dict[str, Client] = field(default_factory=dict)
    state: Any = None

    def has_clients(self) -> bool:
        return self.host is not None or bool(self.remotes)

    def broadcast(self, message: dict[str, Any]) -> None:
        for remote in self.remotes.values():
            remote.send(message)


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

    def create(self) -> Session | None:
        """None when the server already holds MAX_SESSIONS."""
        self._sweep()
        if len(self._sessions) >= MAX_SESSIONS:
            return None
        while True:
            session_id = "".join(
                secrets.choice(SESSION_ID_ALPHABET) for _ in range(SESSION_ID_LENGTH)
            )
            if session_id not in self._sessions:
                break
        session = Session(
            id=session_id, host_token=secrets.token_urlsafe(16), idle_since=self._clock()
        )
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
    session = registry.create()
    if session is None:
        raise HTTPException(status_code=503, detail="Too many sessions; try again later.")
    return {**_describe(session), "hostToken": session.host_token}


@router.get("/{session_id}")
async def get_session(session_id: str) -> dict[str, Any]:
    session = registry.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="No such session.")
    return _describe(session)


@router.websocket("/{session_id}/ws")
async def session_socket(
    ws: WebSocket, session_id: str, role: Role = "remote", token: str = ""
) -> None:
    await ws.accept()
    session = registry.get(session_id)
    if session is None:
        await ws.close(code=CLOSE_NO_SESSION)
        return
    if role == "host" and not secrets.compare_digest(token.encode(), session.host_token.encode()):
        await ws.close(code=CLOSE_BAD_TOKEN)
        return

    client = Client(id=registry.next_client_id(), ws=ws)
    writer = asyncio.create_task(_write(client))
    client.send(
        {
            "type": "hello",
            "clientId": client.id,
            "hostConnected": session.host is not None,
            "state": session.state,
        }
    )
    if role == "host":
        previous = session.host
        session.host = client
        if previous is not None:
            previous.send({"type": "replaced"})
            previous.close(CLOSE_REPLACED)
        else:
            session.broadcast({"type": "host", "connected": True})
    else:
        session.remotes[client.id] = client
    registry.mark_active(session)

    try:
        while True:
            frame = await ws.receive()
            if frame["type"] == "websocket.disconnect":
                break
            text = frame.get("text")
            message = _parse(text) if text is not None and len(text) <= MAX_FRAME_CHARS else None
            if message is not None:
                _route(session, client, role, message)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        if role == "host":
            if session.host is client:
                session.host = None
                session.broadcast({"type": "host", "connected": False})
        else:
            session.remotes.pop(client.id, None)
        registry.mark_idle_if_empty(session)
        writer.cancel()


def _route(session: Session, client: Client, role: Role, message: dict[str, Any]) -> None:
    kind = message.get("type")
    if role == "host":
        if session.host is not client:
            return
        if kind == "state":
            session.state = message.get("state")
            session.broadcast({"type": "state", "state": session.state})
        elif kind == "reply":
            target = session.remotes.get(str(message.get("to")))
            if target is not None:
                target.send({"type": "reply", "reply": message.get("reply")})
    elif kind == "command" and session.host is not None:
        session.host.send({"type": "command", "from": client.id, "command": message.get("command")})


async def _write(client: Client) -> None:
    while True:
        item = await client.outbox.get()
        if isinstance(item, int):
            with suppress(Exception):
                await client.ws.close(code=item)
            return
        try:
            await client.ws.send_text(item)
        except Exception:
            return


def _parse(text: str) -> dict[str, Any] | None:
    try:
        message = json.loads(text)
    except (ValueError, RecursionError):
        return None
    return message if isinstance(message, dict) else None
