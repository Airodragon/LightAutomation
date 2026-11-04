//! Call Center: open FaceTime / WhatsApp / Instagram / Telegram / etc. on the hub Mac.

use crate::hub::Hub;
use crate::model::Contact;
use serde_json::{json, Value};
use std::process::Command;

fn open_url(url: &str) -> Result<(), String> {
    let status = Command::new("open")
        .arg(url)
        .status()
        .map_err(|e| format!("open: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Could not open app".into())
    }
}

fn open_app(bundle_or_name: &str) -> Result<(), String> {
    let status = Command::new("open")
        .arg("-a")
        .arg(bundle_or_name)
        .status()
        .map_err(|e| format!("open -a: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Could not open {bundle_or_name}"))
    }
}

pub fn provider_url(app: &str, handle: &str) -> Option<String> {
    let h = handle.trim();
    match app {
        "facetime" => {
            if h.is_empty() {
                Some("facetime:".into())
            } else if h.contains('@') {
                Some(format!("facetime://{h}"))
            } else {
                let digits: String = h.chars().filter(|c| c.is_ascii_digit() || *c == '+').collect();
                Some(format!("facetime://{digits}"))
            }
        }
        "facetime-audio" => {
            if h.is_empty() {
                None
            } else {
                Some(format!("facetime-audio://{h}"))
            }
        }
        "whatsapp" => {
            let digits: String = h.chars().filter(|c| c.is_ascii_digit()).collect();
            if digits.is_empty() {
                Some("whatsapp://".into())
            } else {
                Some(format!("https://wa.me/{digits}"))
            }
        }
        "instagram" => {
            if h.is_empty() {
                Some("instagram://".into())
            } else {
                let user = h.trim_start_matches('@');
                Some(format!("https://instagram.com/{user}"))
            }
        }
        "telegram" => {
            if h.is_empty() {
                Some("tg://".into())
            } else if h.starts_with('+') || h.chars().all(|c| c.is_ascii_digit()) {
                Some(format!("https://t.me/{h}"))
            } else {
                Some(format!("https://t.me/{}", h.trim_start_matches('@')))
            }
        }
        "messages" => {
            if h.is_empty() {
                Some("sms:".into())
            } else {
                Some(format!("sms:{h}"))
            }
        }
        "phone" => {
            let digits: String = h.chars().filter(|c| c.is_ascii_digit() || *c == '+').collect();
            if digits.is_empty() {
                None
            } else {
                Some(format!("tel:{digits}"))
            }
        }
        "zoom" => {
            if h.is_empty() {
                Some("zoommtg://".into())
            } else if h.starts_with("http") {
                Some(h.to_string())
            } else {
                Some(format!("https://zoom.us/j/{h}"))
            }
        }
        "meet" => {
            if h.is_empty() {
                Some("https://meet.google.com/".into())
            } else if h.starts_with("http") {
                Some(h.to_string())
            } else {
                Some(format!("https://meet.google.com/{h}"))
            }
        }
        "home" => None, // first-party Home Call — handled by frontend WebRTC
        _ => {
            if h.starts_with("http") {
                Some(h.to_string())
            } else {
                None
            }
        }
    }
}

pub fn start_call(hub: &Hub, a: &Value) -> Result<Value, String> {
    let app = a
        .get("app")
        .and_then(|v| v.as_str())
        .unwrap_or("facetime")
        .to_string();
    let handle = a
        .get("handle")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let name = a
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Contact")
        .to_string();

    if app == "home" {
        // WebRTC invite/ring is handled by webrtc_signal — no wall toast here (avoids
        // the caller seeing "Incoming Home Call" / "Calling…" banners on themselves).
        hub.emit(
            "home_call",
            json!({
                "action": "invite",
                "name": name,
                "from": a.get("from").cloned().unwrap_or(Value::Null),
                "target_client": a.get("target_client").cloned().unwrap_or(Value::Null),
                "all": a.get("all").and_then(|v| v.as_bool()).unwrap_or(false),
            }),
        );
        return Ok(json!({"ok": true, "app": "home", "mode": "webrtc"}));
    }

    let url = provider_url(&app, &handle).ok_or_else(|| format!("Cannot start {app} call"))?;
    open_url(&url)?;
    hub.log("call", None, &format!("Opened {app} for {name}"));
    crate::wall::notify_wall(
        hub,
        &format!("{} call", app_label(&app)),
        &format!("Opening {name}"),
        "call",
    );
    hub.emit(
        "call_started",
        json!({"app": app, "name": name, "handle": handle, "url": url}),
    );
    Ok(json!({"ok": true, "app": app, "url": url}))
}

pub fn answer_provider(hub: &Hub, app: &str) -> Result<Value, String> {
    let app_name = match app {
        "whatsapp" => "WhatsApp",
        "instagram" => "Instagram",
        "telegram" => "Telegram",
        "facetime" | "facetime-audio" => "FaceTime",
        "messages" => "Messages",
        "zoom" => "zoom.us",
        "meet" => "Google Chrome",
        "phone" => "FaceTime",
        _ => return Err(format!("Unknown provider {app}")),
    };
    open_app(app_name)?;
    crate::wall::notify_wall(hub, "Answered", &format!("Bringing {app_name} to the front"), "call");
    Ok(json!({"ok": true, "app": app}))
}

fn app_label(app: &str) -> &'static str {
    match app {
        "whatsapp" => "WhatsApp",
        "instagram" => "Instagram",
        "telegram" => "Telegram",
        "facetime" => "FaceTime",
        "messages" => "Messages",
        "phone" => "Phone",
        "zoom" => "Zoom",
        "meet" => "Meet",
        "home" => "Home",
        _ => "Call",
    }
}

pub fn providers() -> Value {
    json!([
        {"id": "home", "name": "Home Call", "desc": "Intercom between wall screens"},
        {"id": "facetime", "name": "FaceTime", "desc": "Apple video"},
        {"id": "whatsapp", "name": "WhatsApp", "desc": "Opens WhatsApp Desktop / wa.me"},
        {"id": "instagram", "name": "Instagram", "desc": "Opens Instagram profile / DMs"},
        {"id": "telegram", "name": "Telegram", "desc": "Opens Telegram"},
        {"id": "messages", "name": "Messages", "desc": "iMessage / SMS"},
        {"id": "phone", "name": "Phone", "desc": "Cellular via Continuity"},
        {"id": "zoom", "name": "Zoom", "desc": "Zoom meeting"},
        {"id": "meet", "name": "Google Meet", "desc": "Meet link"},
    ])
}

pub fn contact_call(hub: &Hub, contact_id: &str) -> Result<Value, String> {
    let c: Contact = hub
        .config
        .lock()
        .settings
        .contacts
        .iter()
        .find(|x| x.id == contact_id)
        .cloned()
        .ok_or("Contact not found")?;
    start_call(
        hub,
        &json!({
            "app": c.app,
            "handle": c.handle,
            "name": c.name,
        }),
    )
}

/// Broadcast a WebRTC signaling message to all clients (filtered client-side by to/from).
pub fn signal(hub: &Hub, a: &Value) -> Result<Value, String> {
    let from = a
        .get("from")
        .and_then(|v| v.as_str())
        .ok_or("Missing from")?;
    let kind = a
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or("Missing type")?;
    hub.emit(
        "webrtc",
        json!({
            "from": from,
            "to": a.get("to").cloned().unwrap_or(Value::Null),
            "type": kind,
            "sdp": a.get("sdp").cloned().unwrap_or(Value::Null),
            "candidate": a.get("candidate").cloned().unwrap_or(Value::Null),
            "room": a.get("room").cloned().unwrap_or(Value::Null),
            "name": a.get("name").cloned().unwrap_or(Value::Null),
            "all": a.get("all").and_then(|v| v.as_bool()).unwrap_or(false),
        }),
    );
    // Only invite/ring should surface the answer UI. Skip notify_wall — callers were
    // getting stacked "Incoming Home Call" banners on the same screen that dialed.
    if kind == "invite" {
        let name = a
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("Someone");
        hub.emit(
            "wall_ring",
            json!({
                "from": from,
                "name": name,
                "all": a.get("all").and_then(|v| v.as_bool()).unwrap_or(false),
                "to": a.get("to").cloned().unwrap_or(Value::Null),
            }),
        );
    }
    Ok(json!({"ok": true}))
}

pub fn doorbell_ring(hub: &Hub, device_id: Option<&str>) {
    let name = device_id
        .and_then(|id| hub.devices.lock().get(id).map(|d| d.name.clone()))
        .unwrap_or_else(|| "Doorbell".into());
    hub.emit(
        "doorbell",
        json!({"id": device_id, "name": name, "ts": chrono::Local::now().timestamp_millis()}),
    );
    crate::wall::notify_wall(hub, "Doorbell", &format!("{name} is ringing"), "doorbell");
}
