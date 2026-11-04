//! Google Chromecast / Cast devices discovered on the LAN.
//!
//! Presence uses the Eureka HTTP API on port 8008. Transport/volume use Cast v2
//! over TLS on port 8009 with a small JSON-framed client (no heavy crate).

use super::Driver;
use crate::hub::Hub;
use crate::model::{Cmd, Device, Live};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Mutex;
use std::time::Duration;

const CAST_PORT: u16 = 8009;
const EUREKA_PORT: u16 = 8008;

/// Shared TLS connector (native-tls).
fn tls_stream(ip: &str, port: u16) -> Result<native_tls::TlsStream<TcpStream>, String> {
    let addr = format!("{ip}:{port}")
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .next()
        .ok_or_else(|| format!("Cannot resolve {ip}"))?;
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).map_err(|e| e.to_string())?;
    tcp.set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;
    tcp.set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;
    let connector = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()
        .map_err(|e| e.to_string())?;
    connector
        .connect(ip, tcp)
        .map_err(|e| format!("Cast TLS: {e}"))
}

/// Length-prefixed Cast frame (big-endian u32 length + protobuf-like JSON payload).
/// We send the simplified JSON form used by many lightweight clients:
/// protocol fields as a JSON object with type/namespace/payload.
fn write_msg(stream: &mut impl Write, namespace: &str, payload: Value, source: &str, dest: &str) -> Result<(), String> {
    // Cast uses protobuf; for reliability we speak the binary protocol with
    // a minimal hand-rolled CastMessage. Field numbers from googlecast.proto:
    // 1 protocol_version=0, 2 source_id, 3 destination_id, 4 namespace, 5 payload_type=0 (string), 6 payload_utf8
    let body = payload.to_string();
    let mut msg = Vec::new();
    // protocol_version = CASTV2_1_0 (0)
    msg.extend_from_slice(&[0x08, 0x00]);
    // source_id
    encode_string(&mut msg, 2, source);
    // destination_id
    encode_string(&mut msg, 3, dest);
    // namespace
    encode_string(&mut msg, 4, namespace);
    // payload_type = STRING (0)
    msg.extend_from_slice(&[0x28, 0x00]);
    // payload_utf8
    encode_string(&mut msg, 6, &body);
    let len = (msg.len() as u32).to_be_bytes();
    stream.write_all(&len).map_err(|e| e.to_string())?;
    stream.write_all(&msg).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())
}

fn encode_string(buf: &mut Vec<u8>, field: u8, s: &str) {
    let tag = (field << 3) | 2; // length-delimited
    buf.push(tag);
    let bytes = s.as_bytes();
    encode_varint(buf, bytes.len() as u64);
    buf.extend_from_slice(bytes);
}

fn encode_varint(buf: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        buf.push((v as u8) | 0x80);
        v >>= 7;
    }
    buf.push(v as u8);
}

fn read_msg(stream: &mut impl Read) -> Result<Value, String> {
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf).map_err(|e| e.to_string())?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len == 0 || len > 256 * 1024 {
        return Err("Invalid cast frame".into());
    }
    let mut buf = vec![0u8; len];
    stream.read_exact(&mut buf).map_err(|e| e.to_string())?;
    // Find payload_utf8 (field 6) in the protobuf blob
    let mut i = 0;
    while i < buf.len() {
        let tag = buf[i];
        i += 1;
        let field = tag >> 3;
        let wire = tag & 7;
        if wire == 2 {
            let (n, adv) = read_varint(&buf[i..])?;
            i += adv;
            if field == 6 {
                let end = i + n as usize;
                if end > buf.len() {
                    break;
                }
                let s = std::str::from_utf8(&buf[i..end]).map_err(|e| e.to_string())?;
                return serde_json::from_str(s).map_err(|e| e.to_string());
            }
            i += n as usize;
        } else if wire == 0 {
            let (_, adv) = read_varint(&buf[i..])?;
            i += adv;
        } else {
            break;
        }
    }
    Ok(json!({}))
}

fn read_varint(buf: &[u8]) -> Result<(u64, usize), String> {
    let mut v = 0u64;
    let mut shift = 0;
    for (i, b) in buf.iter().enumerate() {
        v |= ((*b as u64) & 0x7f) << shift;
        if *b & 0x80 == 0 {
            return Ok((v, i + 1));
        }
        shift += 7;
        if shift > 63 {
            return Err("varint overflow".into());
        }
    }
    Err("truncated varint".into())
}

fn eureka(ip: &str) -> Option<Value> {
    ureq::get(&format!("http://{ip}:{EUREKA_PORT}/setup/eureka_info"))
        .timeout(Duration::from_secs(2))
        .call()
        .ok()
        .and_then(|r| r.into_json::<Value>().ok())
}

fn port_open(ip: &str, port: u16) -> bool {
    let Ok(mut addrs) = format!("{ip}:{port}").to_socket_addrs() else {
        return false;
    };
    let Some(addr) = addrs.next() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(600)).is_ok()
}

/// Apply a single Cast receiver command (SET_VOLUME / GET_STATUS).
fn cast_cmd(ip: &str, payload: Value) -> Result<Value, String> {
    let mut stream = tls_stream(ip, CAST_PORT)?;
    // CONNECT to receiver
    write_msg(
        &mut stream,
        "urn:x-cast:com.google.cast.tp.connection",
        json!({"type":"CONNECT"}),
        "sender-0",
        "receiver-0",
    )?;
    let _ = read_msg(&mut stream);
    write_msg(
        &mut stream,
        "urn:x-cast:com.google.cast.receiver",
        payload,
        "sender-0",
        "receiver-0",
    )?;
    // Read a few frames looking for RECEIVER_STATUS
    for _ in 0..6 {
        if let Ok(v) = read_msg(&mut stream) {
            if v.get("type").and_then(|t| t.as_str()) == Some("RECEIVER_STATUS") {
                return Ok(v);
            }
            if v.get("type").and_then(|t| t.as_str()) == Some("MEDIA_STATUS") {
                return Ok(v);
            }
        }
    }
    Ok(json!({}))
}

fn media_cmd(ip: &str, payload: Value) -> Result<(), String> {
    let mut stream = tls_stream(ip, CAST_PORT)?;
    write_msg(
        &mut stream,
        "urn:x-cast:com.google.cast.tp.connection",
        json!({"type":"CONNECT"}),
        "sender-0",
        "receiver-0",
    )?;
    let _ = read_msg(&mut stream);
    // Ask receiver status for transport id
    write_msg(
        &mut stream,
        "urn:x-cast:com.google.cast.receiver",
        json!({"type":"GET_STATUS","requestId":1}),
        "sender-0",
        "receiver-0",
    )?;
    let mut transport = String::from("receiver-0");
    let mut session: Option<i64> = None;
    for _ in 0..8 {
        let Ok(v) = read_msg(&mut stream) else { continue };
        if let Some(apps) = v
            .pointer("/status/applications")
            .and_then(|a| a.as_array())
        {
            if let Some(app) = apps.first() {
                if let Some(tid) = app.get("transportId").and_then(|t| t.as_str()) {
                    transport = tid.to_string();
                }
                session = app.get("sessionId").and_then(|s| s.as_i64());
            }
        }
        if v.get("type").and_then(|t| t.as_str()) == Some("RECEIVER_STATUS") {
            break;
        }
    }
    if transport != "receiver-0" {
        write_msg(
            &mut stream,
            "urn:x-cast:com.google.cast.tp.connection",
            json!({"type":"CONNECT"}),
            "sender-0",
            &transport,
        )?;
    }
    let mut body = payload;
    if let Some(obj) = body.as_object_mut() {
        obj.insert("requestId".into(), json!(2));
        if let Some(s) = session {
            obj.entry("mediaSessionId").or_insert(json!(s));
        }
    }
    write_msg(
        &mut stream,
        "urn:x-cast:com.google.cast.media",
        body,
        "sender-0",
        &transport,
    )?;
    Ok(())
}

pub fn add_cast(hub: &Hub, ip: &str, name: Option<String>, port: u16) -> Device {
    let info = eureka(ip);
    let friendly = info
        .as_ref()
        .and_then(|v| v.get("name").and_then(|n| n.as_str()))
        .map(String::from)
        .or(name)
        .unwrap_or_else(|| format!("Cast {ip}"));
    let uuid = info
        .as_ref()
        .and_then(|v| v.get("ssdp_udn").or_else(|| v.get("cast_uuid")).and_then(|u| u.as_str()))
        .map(|u| u.trim_start_matches("uuid:").to_string())
        .unwrap_or_else(|| ip.replace('.', "-"));
    let id = format!("cast:{uuid}");
    if let Some(existing) = hub.device(&id) {
        hub.update_device(&id, |d| {
            d.ip = ip.to_string();
            if port != 0 {
                d.port = port;
            }
        });
        return existing;
    }
    let dev = Device {
        id,
        driver: "cast".into(),
        kind: "media".into(),
        name: friendly,
        ip: ip.to_string(),
        port: if port != 0 { port } else { CAST_PORT },
        caps: vec!["onoff".into(), "volume".into(), "media".into(), "cast".into()],
        ..Default::default()
    };
    hub.add_device(dev)
}

fn apply_status(l: &mut Live, status: &Value) {
    if let Some(vol) = status.pointer("/status/volume/level").and_then(|v| v.as_f64()) {
        l.volume = Some(vol);
    }
    if let Some(muted) = status.pointer("/status/volume/muted").and_then(|v| v.as_bool()) {
        if muted {
            l.volume = Some(0.0);
        }
    }
    if let Some(apps) = status.pointer("/status/applications").and_then(|a| a.as_array()) {
        if let Some(app) = apps.first() {
            l.media_app = app
                .get("displayName")
                .and_then(|n| n.as_str())
                .map(String::from);
            l.on = Some(true);
            l.value = Some("playing".into());
        } else {
            l.on = Some(false);
            l.value = Some("idle".into());
        }
    }
}

pub struct CastDriver {
    /// request id counter (unused beyond local frames)
    _lock: Mutex<()>,
}

impl Default for CastDriver {
    fn default() -> Self {
        Self {
            _lock: Mutex::new(()),
        }
    }
}

impl Driver for CastDriver {
    fn name(&self) -> &'static str {
        "cast"
    }

    fn every(&self) -> u64 {
        2
    }

    fn poll(&self, hub: &Hub, devices: &[Device]) {
        for d in devices {
            if d.ip.is_empty() {
                hub.report_miss(&d.id);
                continue;
            }
            if let Some(info) = eureka(&d.ip) {
                hub.report_ok(&d.id, |l| {
                    l.on = Some(
                        info.get("has_update")
                            .is_some()
                            || port_open(&d.ip, CAST_PORT),
                    );
                    if let Some(n) = info.get("name").and_then(|n| n.as_str()) {
                        // keep live app hint empty; name stays on Device
                        let _ = n;
                    }
                    l.value = l.value.clone().or_else(|| Some("idle".into()));
                });
                // Best-effort richer status
                if let Ok(st) = cast_cmd(&d.ip, json!({"type":"GET_STATUS","requestId":1})) {
                    hub.report_ok(&d.id, |l| apply_status(l, &st));
                }
            } else if port_open(&d.ip, CAST_PORT) || port_open(&d.ip, EUREKA_PORT) {
                hub.report_ok(&d.id, |l| {
                    l.on = Some(true);
                });
            } else {
                hub.report_miss(&d.id);
            }
        }
    }

    fn command(&self, hub: &Hub, dev: &Device, cmd: &Cmd) -> Result<(), String> {
        let ip = &dev.ip;
        if ip.is_empty() {
            return Err("Cast device has no IP".into());
        }
        if let Some(v) = cmd.volume {
            let st = cast_cmd(
                ip,
                json!({"type":"SET_VOLUME","volume":{"level": v.clamp(0.0, 1.0)},"requestId":1}),
            )?;
            hub.write_live(&dev.id, Duration::from_millis(800), |l| apply_status(l, &st));
        }
        if let Some(uri) = cmd.play_uri.as_deref() {
            // Launch default media receiver then LOAD
            cast_cmd(
                ip,
                json!({"type":"LAUNCH","appId":"CC1AD845","requestId":1}),
            )?;
            std::thread::sleep(Duration::from_millis(400));
            media_cmd(
                ip,
                json!({
                    "type": "LOAD",
                    "autoplay": true,
                    "media": {
                        "contentId": uri,
                        "streamType": "BUFFERED",
                        "contentType": "audio/mpeg"
                    }
                }),
            )?;
            return Ok(());
        }
        if let Some(m) = cmd.media.as_deref() {
            let ty = match m {
                "play" => "PLAY",
                "pause" => "PAUSE",
                "stop" => "STOP",
                _ => return Err(format!("Cast does not support media action {m}")),
            };
            media_cmd(ip, json!({"type": ty}))?;
        }
        if let Some(on) = cmd.on {
            if !on {
                cast_cmd(ip, json!({"type":"STOP","requestId":1}))?;
            }
        }
        Ok(())
    }
}
