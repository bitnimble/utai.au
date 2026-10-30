//! The desktop app's LAN endpoint for phones: the remote page, and the local
//! backend's `/api/sessions*`. The rest of the API is served only to pages this
//! machine loads from the gateway itself (`localhost:7337` in a browser).

use std::future::Future;
use std::io;
use std::net::{SocketAddr, TcpListener};
use std::sync::Arc;
use std::time::Duration;

use axum::http::{header, HeaderValue, StatusCode, Uri};
use axum::middleware::map_response;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use tauri::{AppHandle, AssetResolver, Manager, Runtime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

use crate::local_backend::LocalBackend;

const DEFAULT_PORT: u16 = 7337;
const API_PREFIX: &str = "/api";
const BAD_REQUEST: &[u8] = b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const FORBIDDEN: &[u8] = b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const MAX_HEAD_BYTES: usize = 16 * 1024;
const ROUTE_TIMEOUT: Duration = Duration::from_secs(10);
const PEEK_RETRY: Duration = Duration::from_millis(10);
const ACCEPT_RETRY: Duration = Duration::from_millis(100);

pub struct SessionGateway {
    port: Option<u16>,
}

impl SessionGateway {
    /// None when the port couldn't be bound.
    pub fn port(&self) -> Option<u16> {
        self.port
    }
}

/// Binds `UTAI_SESSION_PORT` (default 7337) on all interfaces and serves in the background.
pub fn start(app: &AppHandle) -> SessionGateway {
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
            log::error!("session gateway couldn't bind port {port}: {e}");
            return SessionGateway { port: None };
        }
    };
    log::info!("session gateway on port {port}");
    let resolver = Arc::new(app.asset_resolver());
    let assets = Router::new().fallback(get(move |uri: Uri| {
        let resolver = resolver.clone();
        async move { serve_asset(&resolver, &uri) }
    }));
    let app = app.clone();
    let backend_port = move || app.state::<LocalBackend>().api_port();
    tauri::async_runtime::spawn(async move {
        match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => serve(listener, assets, backend_port).await,
            Err(e) => log::error!("session gateway stopped: {e}"),
        }
    });
    SessionGateway { port: Some(port) }
}

async fn serve(
    listener: tokio::net::TcpListener,
    assets: Router,
    backend_port: impl Fn() -> Option<u16> + Clone + Send + 'static,
) {
    let (to_assets, from_gateway) = mpsc::channel(64);
    let local_addr = listener.local_addr();
    let asset_listener = Handoff { connections: from_gateway, local_addr };
    // Closed after each response: a connection is routed by its first request alone.
    let assets = assets.layer(map_response(|mut response: Response| async move {
        response.headers_mut().insert(header::CONNECTION, HeaderValue::from_static("close"));
        response
    }));
    tokio::spawn(async move { axum::serve(asset_listener, assets).await });
    loop {
        let (stream, addr) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(e) => {
                // e.g. out of file descriptors: retrying at once would spin
                log::warn!("session gateway accept failed: {e}");
                tokio::time::sleep(ACCEPT_RETRY).await;
                continue;
            }
        };
        let to_assets = to_assets.clone();
        let backend_port = backend_port.clone();
        tokio::spawn(async move {
            match tokio::time::timeout(ROUTE_TIMEOUT, is_api_request(&stream)).await {
                Ok(Ok(true)) => splice_to_backend(stream, addr.ip().is_loopback(), backend_port()).await,
                Ok(Ok(false)) => {
                    let _ = to_assets.send((stream, addr)).await;
                }
                _ => {}
            }
        });
    }
}

struct Handoff {
    connections: mpsc::Receiver<(TcpStream, SocketAddr)>,
    local_addr: io::Result<SocketAddr>,
}

impl axum::serve::Listener for Handoff {
    type Io = TcpStream;
    type Addr = SocketAddr;

    fn accept(&mut self) -> impl Future<Output = (TcpStream, SocketAddr)> + Send {
        async move {
            match self.connections.recv().await {
                Some(connection) => connection,
                // pend, not return: axum's accept loop would spin on a closed channel
                None => std::future::pending().await,
            }
        }
    }

    fn local_addr(&self) -> io::Result<SocketAddr> {
        match &self.local_addr {
            Ok(addr) => Ok(*addr),
            Err(e) => Err(io::Error::new(e.kind(), e.to_string())),
        }
    }
}

/// Reads the request line without consuming it, so a non-API connection reaches axum intact.
async fn is_api_request(stream: &TcpStream) -> io::Result<bool> {
    let mut buf = [0u8; 64];
    loop {
        let n = stream.peek(&mut buf).await?;
        if n == 0 {
            return Ok(false);
        }
        let seen = &buf[..n];
        if let Some(is_api) = targets(seen, API_PREFIX) {
            return Ok(is_api);
        }
        if n == buf.len() || seen.contains(&b'\n') {
            return Ok(false);
        }
        // peek returns at once with what's buffered; wait for the rest of the line.
        tokio::time::sleep(PEEK_RETRY).await;
    }
}

/// Whether the request line targets `prefix` or a path under it; None until enough of it has arrived to tell.
fn targets(line: &[u8], prefix: &str) -> Option<bool> {
    let target = &line[line.iter().position(|&b| b == b' ')? + 1..];
    let prefix = prefix.as_bytes();
    let compared = target.len().min(prefix.len());
    if target[..compared] != prefix[..compared] {
        return Some(false);
    }
    let after_prefix = target.get(prefix.len())?;
    Some(matches!(after_prefix, b'/' | b'?' | b' '))
}

async fn splice_to_backend(mut client: TcpStream, from_this_machine: bool, backend_port: Option<u16>) {
    let Ok(Some((head, rest))) = tokio::time::timeout(ROUTE_TIMEOUT, read_head(&mut client)).await else {
        let _ = client.write_all(BAD_REQUEST).await;
        return;
    };
    let head = match rewrite_head(&head, from_this_machine) {
        Ok(head) => head,
        Err(response) => {
            let _ = client.write_all(response).await;
            return;
        }
    };
    let backend = match backend_port {
        Some(port) => TcpStream::connect(("127.0.0.1", port)).await.ok(),
        None => None,
    };
    let Some(mut backend) = backend else {
        let _ = client
            .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await;
        return;
    };
    let forwarded = [head.as_bytes(), &rest].concat();
    if backend.write_all(&forwarded).await.is_err() {
        return;
    }
    let _ = tokio::io::copy_bidirectional(&mut client, &mut backend).await;
}

/// The head (without its blank line) and whatever was read past it.
async fn read_head(stream: &mut TcpStream) -> Option<(String, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            if end > MAX_HEAD_BYTES {
                return None;
            }
            let head = String::from_utf8(buf[..end].to_vec()).ok()?;
            return Some((head, buf[end + 4..].to_vec()));
        }
        if buf.len() > MAX_HEAD_BYTES {
            return None;
        }
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

/// `/api/…` to the backend's `/…`, as exactly one request: a websocket upgrade, or
/// one the backend closes the connection after. Only the session routes are open to
/// the LAN. Err is the response for a refused head.
fn rewrite_head(head: &str, from_this_machine: bool) -> Result<String, &'static [u8]> {
    // A bare CR/LF could hide a second, unrouted request from the backend.
    if head.split("\r\n").any(|line| line.contains(['\r', '\n'])) {
        return Err(BAD_REQUEST);
    }
    let mut lines = head.split("\r\n");
    let (method, rest) = lines.next().and_then(|line| line.split_once(' ')).ok_or(BAD_REQUEST)?;
    let (target, version) = rest.split_once(' ').ok_or(BAD_REQUEST)?;
    let path = target.strip_prefix(API_PREFIX).ok_or(BAD_REQUEST)?;
    let path_only = path.split('?').next().unwrap_or_default();
    // Routing is decided on the raw path: `/sessions/../music` must not count as a session route.
    if path_only.split('/').any(|segment| segment == "..") || path_only.to_ascii_lowercase().contains("%2e") {
        return Err(BAD_REQUEST);
    }
    let separator = if path.starts_with('/') { "" } else { "/" };
    let request_line = format!("{method} {separator}{path} {version}");
    let headers: Vec<(String, &str)> = lines
        .map(|line| {
            let (name, value) = line.split_once(':')?;
            Some((name.trim().to_ascii_lowercase(), value))
        })
        .collect::<Option<_>>()
        .ok_or(BAD_REQUEST)?;
    let header = |name: &str| headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.trim());
    let is_session = targets(request_line.as_bytes(), "/sessions") == Some(true);
    let allowed = is_session
        || (from_this_machine && is_own_page(header("host"), header("origin"), header("sec-fetch-site")));
    if !allowed {
        return Err(FORBIDDEN);
    }
    let has = |name: &str, matches: fn(&str) -> bool| headers.iter().any(|(n, v)| n == name && matches(v.trim()));
    let websocket = has("upgrade", |v| v.eq_ignore_ascii_case("websocket"))
        && has("connection", |v| v.split(',').any(|t| t.trim().eq_ignore_ascii_case("upgrade")));
    let mut out = vec![request_line];
    for (name, value) in &headers {
        if !matches!(name.as_str(), "connection" | "keep-alive" | "upgrade") {
            out.push(format!("{name}:{value}"));
        }
    }
    if websocket {
        out.push("Connection: Upgrade".to_string());
        out.push("Upgrade: websocket".to_string());
    } else {
        out.push("Connection: close".to_string());
    }
    Ok(out.join("\r\n") + "\r\n\r\n")
}

/// Port 7337 is fixed, so any site the user opens could aim requests at it: refuse
/// other sites' pages (Origin, or Sec-Fetch-Site on GETs that carry no Origin) and
/// DNS names rebound to loopback (Host).
fn is_own_page(host: Option<&str>, origin: Option<&str>, fetch_site: Option<&str>) -> bool {
    let Some(host) = host else { return false };
    let name = host.rsplit_once(':').map_or(host, |(name, _)| name);
    matches!(name, "localhost" | "127.0.0.1")
        && origin.map_or(true, |origin| origin == format!("http://{host}"))
        && fetch_site.map_or(true, |site| matches!(site, "same-origin" | "none"))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_requests_are_rewritten_to_close_after_one_response() {
        let head = "GET /api/sessions/AB12CD HTTP/1.1\r\nHost: 10.0.0.2:7337\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5";
        assert_eq!(
            rewrite_head(head, false).unwrap(),
            "GET /sessions/AB12CD HTTP/1.1\r\nhost: 10.0.0.2:7337\r\nConnection: close\r\n\r\n"
        );
    }

    #[test]
    fn the_rest_of_the_api_is_only_for_this_machines_own_pages() {
        let head = "GET /api/music/services HTTP/1.1\r\nHost: localhost:7337";
        assert_eq!(
            rewrite_head(head, true).unwrap(),
            "GET /music/services HTTP/1.1\r\nhost: localhost:7337\r\nConnection: close\r\n\r\n"
        );
        let post = "POST /api/music/config HTTP/1.1\r\nHost: 127.0.0.1:7337\r\nOrigin: http://127.0.0.1:7337";
        assert!(rewrite_head(post, true).is_ok());
        assert_eq!(rewrite_head("GET /api HTTP/1.1\r\nHost: localhost", true).unwrap(), "GET / HTTP/1.1\r\nhost: localhost\r\nConnection: close\r\n\r\n");

        assert_eq!(rewrite_head(head, false), Err(FORBIDDEN));
        assert_eq!(rewrite_head("GET /api/music/services HTTP/1.1\r\nHost: rebound.example:7337", true), Err(FORBIDDEN));
        assert_eq!(rewrite_head("GET /api/music/services HTTP/1.1", true), Err(FORBIDDEN));
        let cross_site = "POST /api/music/accounts HTTP/1.1\r\nHost: localhost:7337\r\nOrigin: https://evil.example";
        assert_eq!(rewrite_head(cross_site, true), Err(FORBIDDEN));
        let cross_site_get = "GET /api/music/search?q=x HTTP/1.1\r\nHost: localhost:7337\r\nSec-Fetch-Site: cross-site";
        assert_eq!(rewrite_head(cross_site_get, true), Err(FORBIDDEN));
    }

    #[test]
    fn dot_segments_cannot_pass_for_a_session_route() {
        assert_eq!(rewrite_head("GET /api/sessions/../music/config HTTP/1.1\r\nHost: x", false), Err(BAD_REQUEST));
        assert_eq!(rewrite_head("GET /api/sessions/%2E%2E/music/config HTTP/1.1\r\nHost: x", false), Err(BAD_REQUEST));
        let search = "GET /api/music/search?q=wait... HTTP/1.1\r\nHost: localhost:7337";
        assert!(rewrite_head(search, true).is_ok());
    }

    #[test]
    fn websocket_upgrades_stay_upgrades() {
        let head = "GET /api/sessions/AB12CD/ws?role=remote HTTP/1.1\r\nConnection: keep-alive, Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: k";
        assert_eq!(
            rewrite_head(head, false).unwrap(),
            "GET /sessions/AB12CD/ws?role=remote HTTP/1.1\r\nsec-websocket-key: k\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"
        );
    }

    #[test]
    fn a_bogus_upgrade_still_closes_after_one_response() {
        // Without the close, the backend would serve a pipelined request to any route.
        let head = "GET /api/sessions HTTP/1.1\r\nUpgrade: x";
        assert_eq!(rewrite_head(head, false).unwrap(), "GET /sessions HTTP/1.1\r\nConnection: close\r\n\r\n");
    }

    #[test]
    fn heads_hiding_headers_behind_a_bare_cr_or_lf_are_refused() {
        assert_eq!(rewrite_head("GET /api/sessions HTTP/1.1\r\nX: a\nConnection: keep-alive", false), Err(BAD_REQUEST));
        assert_eq!(rewrite_head("GET /api/sessions HTTP/1.1\r\nX: a\rConnection: keep-alive", false), Err(BAD_REQUEST));
        assert_eq!(rewrite_head("GET /api/sessions HTTP/1.1\r\nno colon", false), Err(BAD_REQUEST));
    }

    #[test]
    fn routing_is_decided_from_the_start_of_the_target() {
        let long_socket = format!("GET /api/sessions/AB12CD/ws?role=host&token={}", "f".repeat(64));
        assert_eq!(targets(&long_socket.as_bytes()[..32], API_PREFIX), Some(true));
        assert_eq!(targets(b"POST /api/sessions HTTP/1.1", API_PREFIX), Some(true));
        assert_eq!(targets(b"GET /api?x", API_PREFIX), Some(true));
        assert_eq!(targets(b"GET /index.h", API_PREFIX), Some(false));
        assert_eq!(targets(b"GET /apifoo HTTP/1.1", API_PREFIX), Some(false));
        assert_eq!(targets(b"GET /ap", API_PREFIX), None);
        assert_eq!(targets(b"GET /api", API_PREFIX), None);
        assert_eq!(targets(b"GET /sessionsfoo HTTP/1.1", "/sessions"), Some(false));
    }

    #[tokio::test]
    async fn sessions_go_to_the_backend_and_the_rest_to_the_assets() {
        let backend = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend_port = backend.local_addr().unwrap().port();
        let (seen_tx, mut seen_rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let (mut stream, _) = backend.accept().await.unwrap();
            let (head, _) = read_head(&mut stream).await.unwrap();
            seen_tx.send(head).unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nsession")
                .await
                .unwrap();
        });
        let gateway = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let gateway_addr = gateway.local_addr().unwrap();
        let assets = Router::new().fallback(get(|| async { "asset" }));
        tokio::spawn(serve(gateway, assets, move || Some(backend_port)));

        let session = request(gateway_addr, "POST /api/sessions HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n").await;
        assert!(session.ends_with("\r\n\r\nsession"), "{session}");
        let seen = seen_rx.recv().await.unwrap();
        assert!(seen.starts_with("POST /sessions HTTP/1.1\r\n"), "{seen}");
        assert!(seen.ends_with("\r\nConnection: close"), "{seen}");

        let asset = request(gateway_addr, "GET /session/AB12CD/remote HTTP/1.1\r\nHost: x\r\n\r\n").await;
        assert!(asset.ends_with("\r\n\r\nasset"), "{asset}");

        let refused = request(gateway_addr, "GET /api/music/services HTTP/1.1\r\nHost: x\r\n\r\n").await;
        assert!(refused.starts_with("HTTP/1.1 403"), "{refused}");

        let oversized = format!("GET /api/sessions HTTP/1.1\r\nCookie: {}\r\n\r\n", "c".repeat(MAX_HEAD_BYTES));
        let refused = request(gateway_addr, &oversized).await;
        assert!(refused.starts_with("HTTP/1.1 400"), "{refused}");
    }

    #[tokio::test]
    async fn this_machines_own_page_reaches_the_whole_api() {
        let backend = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend_port = backend.local_addr().unwrap().port();
        let (seen_tx, mut seen_rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let (mut stream, _) = backend.accept().await.unwrap();
            let (head, _) = read_head(&mut stream).await.unwrap();
            seen_tx.send(head).unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .await
                .unwrap();
        });
        let gateway = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let gateway_addr = gateway.local_addr().unwrap();
        tokio::spawn(serve(gateway, Router::new(), move || Some(backend_port)));

        let raw = format!("GET /api/music/services HTTP/1.1\r\nHost: localhost:{}\r\n\r\n", gateway_addr.port());
        let response = request(gateway_addr, &raw).await;
        assert!(response.ends_with("\r\n\r\n{}"), "{response}");
        let seen = seen_rx.recv().await.unwrap();
        assert!(seen.starts_with("GET /music/services HTTP/1.1\r\n"), "{seen}");
    }

    #[tokio::test]
    async fn sessions_get_a_503_while_the_backend_is_down() {
        let gateway = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let gateway_addr = gateway.local_addr().unwrap();
        tokio::spawn(serve(gateway, Router::new(), || None));
        let response = request(gateway_addr, "GET /api/sessions/AB12CD HTTP/1.1\r\nHost: x\r\n\r\n").await;
        assert!(response.starts_with("HTTP/1.1 503"), "{response}");
    }

    async fn request(addr: SocketAddr, raw: &str) -> String {
        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream.write_all(raw.as_bytes()).await.unwrap();
        let mut response = String::new();
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_string(&mut response))
            .await
            .expect("the connection should close after one response")
            .unwrap();
        response
    }
}
