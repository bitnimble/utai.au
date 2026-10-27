//! LAN session relay for the desktop app: the protocol of `aligner/app/sessions.py`,
//! plus the embedded frontend so phones can load the remote page from it.

use std::collections::HashMap;
use std::net::{IpAddr, TcpListener, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State as AxumState};
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, AssetResolver, Runtime, State};
use tokio::sync::mpsc;

const SESSION_ID_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SESSION_ID_LENGTH: usize = 6;
const SESSION_IDLE_TTL: Duration = Duration::from_secs(60 * 60);
const MAX_SESSIONS: usize = 1000;
const MAX_FRAME_BYTES: usize = 1_000_000;
const PING_INTERVAL: Duration = Duration::from_secs(20);
const PEER_TIMEOUT: Duration = Duration::from_secs(45);
const CLOSE_NO_SESSION: u16 = 4404;
const CLOSE_BAD_TOKEN: u16 = 4403;
const CLOSE_REPLACED: u16 = 4000;
const DEFAULT_PORT: u16 = 7337;

pub struct SessionServer(Result<String, String>);

#[tauri::command]
pub fn session_server_api_base(server: State<'_, SessionServer>) -> Result<String, String> {
    server.0.clone()
}

/// Binds `UTAI_SESSION_PORT` (default 7337) on all interfaces and serves in the background.
pub fn start<R: Runtime>(app: &AppHandle<R>) -> SessionServer {
    let port = std::env::var("UTAI_SESSION_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let listener = match TcpListener::bind(("0.0.0.0", port)).and_then(|l| {
        l.set_nonblocking(true)?;
        Ok(l)
    }) {
        Ok(listener) => listener,
        Err(e) => {
            let message = format!("session server couldn't bind port {port}: {e}");
            log::error!("{message}");
            return SessionServer(Err(message));
        }
    };
    log::info!("session server on port {port}");
    let resolver = Arc::new(app.asset_resolver());
    let routes = router(Some(port)).fallback(get(move |uri: Uri| {
        let resolver = resolver.clone();
        async move { serve_asset(&resolver, &uri) }
    }));
    tauri::async_runtime::spawn(async move {
        let served = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => axum::serve(listener, routes).await,
            Err(e) => Err(e),
        };
        if let Err(e) = served {
            log::error!("session server stopped: {e}");
        }
    });
    SessionServer(Ok(format!("http://127.0.0.1:{port}/api")))
}

/// `port` advertises `http://<lan-ip>:<port>` as the join origin; None advertises none.
fn router(port: Option<u16>) -> Router {
    let relay = Relay {
        registry: Arc::new(Mutex::new(Registry::default())),
        port,
    };
    Router::new()
        .route("/api/sessions", post(create_session))
        .route("/api/sessions/{id}", get(get_session))
        .route("/api/sessions/{id}/ws", get(session_socket))
        .with_state(relay)
}

fn serve_asset<R: Runtime>(resolver: &AssetResolver<R>, uri: &Uri) -> Response {
    // Dev builds read frontendDist off disk with `..` left in the path.
    if uri.path().split(['/', '\\']).any(|segment| segment == "..") {
        return StatusCode::NOT_FOUND.into_response();
    }
    match resolver
        .get(uri.path().to_string())
        .or_else(|| resolver.get("index.html".to_string()))
    {
        Some(asset) => ([(header::CONTENT_TYPE, asset.mime_type)], asset.bytes).into_response(),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            "The session remote page needs a built app (run `bun run build`).",
        )
            .into_response(),
    }
}

/// No packets are sent: connecting a UDP socket only picks the outbound interface.
fn lan_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind(("0.0.0.0", 0)).ok()?;
    socket.connect(("8.8.8.8", 80)).ok()?;
    Some(socket.local_addr().ok()?.ip())
}

#[derive(Clone)]
struct Relay {
    registry: Arc<Mutex<Registry>>,
    port: Option<u16>,
}

impl Relay {
    fn registry(&self) -> std::sync::MutexGuard<'_, Registry> {
        self.registry.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn describe(&self, id: &str) -> Value {
        // Per request, not at startup: the machine may since have joined or changed networks.
        let public_url = self
            .port
            .and_then(|port| lan_ip().map(|ip| format!("http://{ip}:{port}")));
        json!({ "id": id, "publicUrl": public_url })
    }
}

fn api_response(status: StatusCode, body: Value) -> Response {
    (
        status,
        [(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")],
        Json(body),
    )
        .into_response()
}

async fn create_session(AxumState(relay): AxumState<Relay>) -> Response {
    let created = relay.registry().create(Instant::now());
    let Some((id, host_token)) = created else {
        return api_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "detail": "Too many sessions; try again later." }),
        );
    };
    let mut body = relay.describe(&id);
    body["hostToken"] = json!(host_token);
    api_response(StatusCode::OK, body)
}

async fn get_session(AxumState(relay): AxumState<Relay>, Path(id): Path<String>) -> Response {
    let found = relay
        .registry()
        .find(&id, Instant::now())
        .map(|s| s.id.clone());
    match found {
        Some(id) => api_response(StatusCode::OK, relay.describe(&id)),
        None => api_response(
            StatusCode::NOT_FOUND,
            json!({ "detail": "No such session." }),
        ),
    }
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Role {
    Host,
    #[default]
    Remote,
}

#[derive(Deserialize)]
struct SocketQuery {
    #[serde(default)]
    role: Role,
    #[serde(default)]
    token: String,
}

async fn session_socket(
    ws: WebSocketUpgrade,
    AxumState(relay): AxumState<Relay>,
    Path(id): Path<String>,
    Query(query): Query<SocketQuery>,
) -> Response {
    ws.on_upgrade(move |socket| run_client(socket, relay, id, query))
}

async fn run_client(mut socket: WebSocket, relay: Relay, raw_id: String, query: SocketQuery) {
    let (outbox, mut inbox) = mpsc::unbounded_channel();
    let joined = relay
        .registry()
        .join(&raw_id, query.role, &query.token, outbox, Instant::now());
    let client = match joined {
        Ok(client) => client,
        Err(code) => {
            let _ = socket.send(close(code)).await;
            return;
        }
    };
    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + PING_INTERVAL, PING_INTERVAL);
    let mut last_heard = Instant::now();
    loop {
        tokio::select! {
            outgoing = inbox.recv() => match outgoing {
                Some(message) => if socket.send(message).await.is_err() { break },
                None => break,
            },
            incoming = socket.recv() => {
                last_heard = Instant::now();
                match incoming {
                    Some(Ok(Message::Text(text))) if text.len() <= MAX_FRAME_BYTES => {
                        relay.registry().route(&client, &text)
                    }
                    Some(Ok(_)) => {}
                    _ => break,
                }
            },
            _ = ping.tick() => {
                // A phone that sleeps or leaves the network never closes its socket.
                if last_heard.elapsed() > PEER_TIMEOUT
                    || socket.send(Message::Ping(Default::default())).await.is_err()
                {
                    break;
                }
            },
        }
    }
    relay.registry().leave(&client, Instant::now());
}

#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
enum Frame<'a> {
    Hello {
        client_id: &'a str,
        host_connected: bool,
        state: &'a Value,
    },
    State {
        state: &'a Value,
    },
    Host {
        connected: bool,
    },
    Reply {
        reply: &'a Value,
    },
    Command {
        from: &'a str,
        command: &'a Value,
    },
    Replaced,
}

impl Frame<'_> {
    fn message(&self) -> Message {
        Message::Text(
            serde_json::to_string(self)
                .expect("frames are plain JSON")
                .into(),
        )
    }
}

fn close(code: u16) -> Message {
    Message::Close(Some(CloseFrame {
        code,
        reason: "".into(),
    }))
}

type Outbox = mpsc::UnboundedSender<Message>;

struct Session {
    id: String,
    host_token: String,
    idle_since: Option<Instant>,
    host: Option<(String, Outbox)>,
    remotes: HashMap<String, Outbox>,
    state: Value,
}

impl Session {
    fn is_host(&self, client_id: &str) -> bool {
        self.host.as_ref().is_some_and(|(id, _)| id == client_id)
    }

    fn broadcast(&self, frame: &Frame) {
        let message = frame.message();
        for remote in self.remotes.values() {
            let _ = remote.send(message.clone());
        }
    }
}

struct Client {
    session_id: String,
    client_id: String,
    role: Role,
}

#[derive(Default)]
struct Registry {
    sessions: HashMap<String, Session>,
    client_count: u64,
}

impl Registry {
    /// `(id, host_token)`, or None when the relay already holds MAX_SESSIONS.
    fn create(&mut self, now: Instant) -> Option<(String, String)> {
        self.sweep(now);
        if self.sessions.len() >= MAX_SESSIONS {
            return None;
        }
        let id = loop {
            let id = random_session_id();
            if !self.sessions.contains_key(&id) {
                break id;
            }
        };
        let host_token = random_host_token();
        self.sessions.insert(
            id.clone(),
            Session {
                id: id.clone(),
                host_token: host_token.clone(),
                idle_since: Some(now),
                host: None,
                remotes: HashMap::new(),
                state: Value::Null,
            },
        );
        Some((id, host_token))
    }

    fn find(&mut self, raw_id: &str, now: Instant) -> Option<&mut Session> {
        self.sweep(now);
        self.sessions.get_mut(&normalize_session_id(raw_id))
    }

    /// Err is the close code to refuse the socket with.
    fn join(
        &mut self,
        raw_id: &str,
        role: Role,
        token: &str,
        outbox: Outbox,
        now: Instant,
    ) -> Result<Client, u16> {
        let session = self.find(raw_id, now).ok_or(CLOSE_NO_SESSION)?;
        if role == Role::Host && !tokens_match(token, &session.host_token) {
            return Err(CLOSE_BAD_TOKEN);
        }
        let session_id = session.id.clone();
        self.client_count += 1;
        let client_id = format!("c{}", self.client_count);
        let session = self
            .sessions
            .get_mut(&session_id)
            .ok_or(CLOSE_NO_SESSION)?;
        let hello = Frame::Hello {
            client_id: &client_id,
            host_connected: session.host.is_some(),
            state: &session.state,
        };
        let _ = outbox.send(hello.message());
        match role {
            Role::Host => match session.host.replace((client_id.clone(), outbox)) {
                Some((_, previous)) => {
                    let _ = previous.send(Frame::Replaced.message());
                    let _ = previous.send(close(CLOSE_REPLACED));
                }
                None => session.broadcast(&Frame::Host { connected: true }),
            },
            Role::Remote => {
                session.remotes.insert(client_id.clone(), outbox);
            }
        }
        session.idle_since = None;
        Ok(Client {
            session_id,
            client_id,
            role,
        })
    }

    fn route(&mut self, client: &Client, text: &str) {
        let Ok(Value::Object(message)) = serde_json::from_str(text) else {
            return;
        };
        let Some(session) = self.sessions.get_mut(&client.session_id) else {
            return;
        };
        let field = |key: &str| message.get(key).unwrap_or(&Value::Null);
        let kind = field("type").as_str();
        if client.role == Role::Host {
            if !session.is_host(&client.client_id) {
                return;
            }
            match kind {
                Some("state") => {
                    session.state = field("state").clone();
                    session.broadcast(&Frame::State {
                        state: &session.state,
                    });
                }
                Some("reply") => {
                    let target = field("to").as_str().and_then(|to| session.remotes.get(to));
                    if let Some(target) = target {
                        let _ = target.send(
                            Frame::Reply {
                                reply: field("reply"),
                            }
                            .message(),
                        );
                    }
                }
                _ => {}
            }
        } else if kind == Some("command") {
            if let Some((_, host)) = &session.host {
                let command = Frame::Command {
                    from: &client.client_id,
                    command: field("command"),
                };
                let _ = host.send(command.message());
            }
        }
    }

    fn leave(&mut self, client: &Client, now: Instant) {
        let Some(session) = self.sessions.get_mut(&client.session_id) else {
            return;
        };
        match client.role {
            Role::Host => {
                if session.is_host(&client.client_id) {
                    session.host = None;
                    session.broadcast(&Frame::Host { connected: false });
                }
            }
            Role::Remote => {
                session.remotes.remove(&client.client_id);
            }
        }
        if session.host.is_none() && session.remotes.is_empty() {
            session.idle_since = Some(now);
        }
    }

    fn sweep(&mut self, now: Instant) {
        self.sessions.retain(|_, s| {
            s.idle_since
                .map_or(true, |idle| now.duration_since(idle) < SESSION_IDLE_TTL)
        });
    }
}

fn random_session_id() -> String {
    let mut bytes = [0u8; SESSION_ID_LENGTH];
    getrandom::fill(&mut bytes).expect("OS randomness is available");
    // 256 is a multiple of the 32-letter alphabet, so `% 32` is unbiased.
    bytes
        .iter()
        .map(|b| SESSION_ID_ALPHABET[*b as usize % SESSION_ID_ALPHABET.len()] as char)
        .collect()
}

fn random_host_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("OS randomness is available");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn tokens_match(given: &str, expected: &str) -> bool {
    given.len() == expected.len()
        && given
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0
}

fn normalize_session_id(raw: &str) -> String {
    raw.trim()
        .to_uppercase()
        .replace('O', "0")
        .replace(['I', 'L'], "1")
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_tungstenite::tungstenite;

    type Socket = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    #[test]
    fn ids_use_the_alphabet() {
        let mut registry = Registry::default();
        for _ in 0..200 {
            let (id, _) = registry.create(Instant::now()).unwrap();
            assert_eq!(id.len(), SESSION_ID_LENGTH);
            assert!(id.bytes().all(|b| SESSION_ID_ALPHABET.contains(&b)), "{id}");
        }
    }

    #[test]
    fn normalize_reads_ambiguous_letters_as_digits() {
        assert_eq!(normalize_session_id(" oil2ab "), "0112AB");
    }

    #[test]
    fn session_expires_after_an_idle_hour_without_clients() {
        let start = Instant::now();
        let mut registry = Registry::default();
        let (id, token) = registry.create(start).unwrap();
        let (outbox, _inbox) = mpsc::unbounded_channel();
        let host = registry.join(&id, Role::Host, &token, outbox, start).unwrap();
        let later = start + 2 * SESSION_IDLE_TTL;
        assert!(registry.find(&id, later).is_some());
        registry.leave(&host, later);
        let second = Duration::from_secs(1);
        assert!(registry
            .find(&id, later + SESSION_IDLE_TTL - second)
            .is_some());
        assert!(registry.find(&id, later + SESSION_IDLE_TTL).is_none());
    }

    #[tokio::test]
    async fn created_session_is_found_case_insensitively() {
        let base = serve().await;
        let (status, created) = http(&base, "POST", "/api/sessions").await;
        assert_eq!(status, 200);
        let id = created["id"].as_str().unwrap();
        assert_eq!(created["hostToken"].as_str().unwrap().len(), 32);
        let (status, found) = http(
            &base,
            "GET",
            &format!("/api/sessions/{}", id.to_lowercase()),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(found, json!({ "id": id, "publicUrl": null }));
        let (status, missing) = http(&base, "GET", "/api/sessions/ZZZZZZ").await;
        assert_eq!(status, 404);
        assert_eq!(missing, json!({ "detail": "No such session." }));
    }

    #[tokio::test]
    async fn unknown_session_socket_closes_4404() {
        let base = serve().await;
        let mut ws = connect(&base, "ZZZZZZ", "remote", "").await;
        assert_eq!(close_code(&mut ws).await, 4404);
    }

    #[tokio::test]
    async fn hosting_needs_the_host_token() {
        let base = serve().await;
        let (id, _) = create(&base).await;
        let mut ws = connect(&base, &id, "host", "guessed").await;
        assert_eq!(close_code(&mut ws).await, 4403);
    }

    #[tokio::test]
    async fn relays_commands_state_and_replies() {
        let base = serve().await;
        let (id, token) = create(&base).await;
        let mut host = connect(&base, &id, "host", &token).await;
        assert_eq!(
            recv(&mut host).await,
            json!({ "type": "hello", "clientId": "c1", "hostConnected": false, "state": null })
        );
        send(
            &mut host,
            json!({ "type": "state", "state": { "queue": ["a"] } }),
        )
        .await;
        let mut remote = connect(&base, &id, "remote", "").await;
        assert_eq!(
            recv(&mut remote).await,
            json!({ "type": "hello", "clientId": "c2", "hostConnected": true, "state": { "queue": ["a"] } })
        );
        remote
            .send(tungstenite::Message::text("not json"))
            .await
            .unwrap();
        send(
            &mut remote,
            json!({ "type": "command", "command": { "kind": "skip" } }),
        )
        .await;
        assert_eq!(
            recv(&mut host).await,
            json!({ "type": "command", "from": "c2", "command": { "kind": "skip" } })
        );
        send(
            &mut host,
            json!({ "type": "reply", "to": "c2", "reply": { "ok": true } }),
        )
        .await;
        assert_eq!(
            recv(&mut remote).await,
            json!({ "type": "reply", "reply": { "ok": true } })
        );
        send(
            &mut host,
            json!({ "type": "state", "state": { "queue": [] } }),
        )
        .await;
        assert_eq!(
            recv(&mut remote).await,
            json!({ "type": "state", "state": { "queue": [] } })
        );
    }

    #[tokio::test]
    async fn remotes_hear_host_leave_and_a_new_host_replaces_the_old() {
        let base = serve().await;
        let (id, token) = create(&base).await;
        let mut remote = connect(&base, &id, "remote", "").await;
        recv(&mut remote).await;
        let mut first = connect(&base, &id, "host", &token).await;
        recv(&mut first).await;
        assert_eq!(
            recv(&mut remote).await,
            json!({ "type": "host", "connected": true })
        );
        let mut second = connect(&base, &id, "host", &token).await;
        assert_eq!(recv(&mut second).await["hostConnected"], true);
        assert_eq!(recv(&mut first).await, json!({ "type": "replaced" }));
        assert_eq!(close_code(&mut first).await, 4000);
        send(
            &mut remote,
            json!({ "type": "command", "command": { "kind": "play" } }),
        )
        .await;
        assert_eq!(
            recv(&mut second).await["command"],
            json!({ "kind": "play" })
        );
        second.close(None).await.unwrap();
        assert_eq!(
            recv(&mut remote).await,
            json!({ "type": "host", "connected": false })
        );
    }

    async fn serve() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router(None)).await });
        addr.to_string()
    }

    async fn http(base: &str, method: &str, path: &str) -> (u16, Value) {
        let mut stream = tokio::net::TcpStream::connect(base).await.unwrap();
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: {base}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        let (head, body) = response.split_once("\r\n\r\n").unwrap();
        assert!(head.contains("access-control-allow-origin: *"), "{head}");
        (
            head[9..12].parse().unwrap(),
            serde_json::from_str(body).unwrap(),
        )
    }

    async fn create(base: &str) -> (String, String) {
        let (_, created) = http(base, "POST", "/api/sessions").await;
        (
            created["id"].as_str().unwrap().to_string(),
            created["hostToken"].as_str().unwrap().to_string(),
        )
    }

    async fn connect(base: &str, id: &str, role: &str, token: &str) -> Socket {
        let url = format!("ws://{base}/api/sessions/{id}/ws?role={role}&token={token}");
        tokio_tungstenite::connect_async(url).await.unwrap().0
    }

    async fn send(ws: &mut Socket, message: Value) {
        ws.send(tungstenite::Message::text(message.to_string()))
            .await
            .unwrap();
    }

    async fn recv(ws: &mut Socket) -> Value {
        match ws.next().await {
            Some(Ok(tungstenite::Message::Text(text))) => serde_json::from_str(&text).unwrap(),
            other => panic!("expected a text frame, got {other:?}"),
        }
    }

    async fn close_code(ws: &mut Socket) -> u16 {
        match ws.next().await {
            Some(Ok(tungstenite::Message::Close(Some(frame)))) => u16::from(frame.code),
            other => panic!("expected a close frame, got {other:?}"),
        }
    }
}
