//! Embedded web server: serves the same UI plus an HTTP/SSE API for wall tablets and phones.

use crate::hub::Hub;
use axum::{
    body::Body,
    extract::{Path, Request, State},
    http::{header, HeaderMap, StatusCode, Uri},
    middleware::{self, Next},
    response::{
        sse::{Event as SseEvent, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use futures_util::StreamExt;
use include_dir::{include_dir, Dir};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::sync::{Arc, OnceLock};
use tokio::sync::oneshot;
use tokio_stream::wrappers::BroadcastStream;

static ASSETS: Dir = include_dir!("$CARGO_MANIFEST_DIR/../src");

pub struct WebHandle {
    pub port: u16,
    shutdown: Option<oneshot::Sender<()>>,
}

static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

fn rt() -> &'static tokio::runtime::Runtime {
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("tokio runtime")
    })
}

pub fn status(hub: &Hub) -> Value {
    let running = hub.web.lock().as_ref().map(|h| h.port);
    let urls: Vec<String> = match (running, crate::discovery::local_ip()) {
        (Some(p), Some(ip)) => vec![format!("http://{ip}:{p}")],
        _ => vec![],
    };
    json!({
        "running": running.is_some(),
        "port": running,
        "urls": urls,
        "error": *LAST_ERROR.lock(),
    })
}

/// Start, stop or restart the server so it matches the settings.
pub fn apply(hub: &Arc<Hub>) {
    let (enabled, port) = {
        let c = hub.config.lock();
        (c.settings.web_enabled, c.settings.web_port)
    };
    let current = hub.web.lock().as_ref().map(|h| h.port);
    if current.is_some() && (!enabled || current != Some(port)) {
        if let Some(mut h) = hub.web.lock().take() {
            if let Some(tx) = h.shutdown.take() {
                let _ = tx.send(());
            }
        }
        // give the old listener a moment to release the port
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
    if enabled && hub.web.lock().is_none() {
        match start(hub.clone(), port) {
            Ok(h) => {
                *LAST_ERROR.lock() = None;
                *hub.web.lock() = Some(h);
            }
            Err(e) => *LAST_ERROR.lock() = Some(e),
        }
    } else if !enabled {
        *LAST_ERROR.lock() = None;
    }
}

fn start(hub: Arc<Hub>, port: u16) -> Result<WebHandle, String> {
    let listener = std::net::TcpListener::bind(("0.0.0.0", port))
        .map_err(|e| format!("Cannot listen on port {port}: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let (tx, rx) = oneshot::channel::<()>();
    let app = router(hub);
    rt().spawn(async move {
        let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
            return;
        };
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });
    Ok(WebHandle {
        port,
        shutdown: Some(tx),
    })
}

pub fn router(hub: Arc<Hub>) -> Router {
    let api = Router::new()
        .route("/state", get(api_state))
        .route("/events", get(api_events))
        .route("/call/{cmd}", post(api_call))
        .layer(middleware::from_fn_with_state(hub.clone(), auth));
    Router::new()
        .route("/api/ping", get(ping))
        .nest("/api", api)
        .fallback(static_file)
        .with_state(hub)
}

fn query_pin(uri: &Uri) -> Option<String> {
    uri.query()?
        .split('&')
        .find_map(|kv| kv.strip_prefix("pin=").map(|v| v.replace('+', " ")))
}

async fn auth(State(hub): State<Arc<Hub>>, req: Request, next: Next) -> Response {
    let pin = hub.config.lock().settings.web_pin.clone();
    if !pin.is_empty() {
        let given = req
            .headers()
            .get("x-hub-pin")
            .and_then(|v| v.to_str().ok())
            .map(String::from)
            .or_else(|| query_pin(req.uri()));
        if given.as_deref() != Some(pin.as_str()) {
            return (StatusCode::UNAUTHORIZED, Json(json!({"error": "PIN required"}))).into_response();
        }
    }
    next.run(req).await
}

async fn ping(State(hub): State<Arc<Hub>>) -> Json<Value> {
    let pin = !hub.config.lock().settings.web_pin.is_empty();
    Json(json!({"ok": true, "pin_required": pin}))
}

async fn api_state(State(hub): State<Arc<Hub>>) -> Json<Value> {
    Json(hub.snapshot())
}

async fn api_call(
    State(hub): State<Arc<Hub>>,
    Path(cmd): Path<String>,
    body: Option<Json<Value>>,
) -> Response {
    let args = body.map(|b| b.0).unwrap_or(Value::Null);
    let args = if args.is_null() { json!({}) } else { args };
    let r = tokio::task::spawn_blocking(move || crate::dispatch::dispatch(&hub, &cmd, args, true)).await;
    match r {
        Ok(Ok(v)) => Json(json!({"ok": true, "data": v})).into_response(),
        Ok(Err(e)) => (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e.to_string()}))).into_response(),
    }
}

async fn api_events(State(hub): State<Arc<Hub>>) -> Sse<impl futures_util::Stream<Item = Result<SseEvent, Infallible>>> {
    let rx = hub.bus.subscribe();
    let first = hub.snapshot().to_string();
    let h2 = hub.clone();
    let head = futures_util::stream::once(async move {
        Ok::<_, Infallible>(SseEvent::default().event("snapshot").data(first))
    });
    let rest = BroadcastStream::new(rx).map(move |r| match r {
        Ok(ev) => Ok(SseEvent::default().event(ev.name).data(ev.data.to_string())),
        // receiver lagged: resync with a full snapshot
        Err(_) => Ok(SseEvent::default().event("snapshot").data(h2.snapshot().to_string())),
    });
    Sse::new(head.chain(rest)).keep_alive(KeepAlive::default())
}

fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "webmanifest" => "application/manifest+json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

async fn static_file(uri: Uri, _h: HeaderMap) -> Response {
    let mut path = uri.path().trim_start_matches('/').to_string();
    if path.is_empty() {
        path = "index.html".into();
    }
    // Development: serve straight from disk so the UI can be edited without rebuilding.
    if let Some(dir) = std::env::var_os("HUB_STATIC_DIR") {
        let file = std::path::Path::new(&dir).join(&path);
        if let Ok(bytes) = std::fs::read(&file) {
            return Response::builder()
                .header(header::CONTENT_TYPE, mime(&path))
                .header(header::CACHE_CONTROL, "no-store")
                .body(Body::from(bytes))
                .unwrap();
        }
    }
    match ASSETS.get_file(&path) {
        Some(f) => Response::builder()
            .header(header::CONTENT_TYPE, mime(&path))
            .header(header::CACHE_CONTROL, "no-cache")
            .body(Body::from(f.contents().to_vec()))
            .unwrap(),
        None => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}
