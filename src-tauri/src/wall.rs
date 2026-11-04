//! Wall screen client enrollment and household presence helpers.

use crate::hub::Hub;
use crate::model::{Contact, WallClient, new_id};
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn register(hub: &Hub, a: &Value) -> Result<Value, String> {
    let id = a
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(new_id);
    let name = a
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Wall screen")
        .trim()
        .to_string();
    let room = a
        .get("room")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let has_cam = a.get("has_cam").and_then(|v| v.as_bool()).unwrap_or(false);
    let has_mic = a.get("has_mic").and_then(|v| v.as_bool()).unwrap_or(false);
    let client = WallClient {
        id: id.clone(),
        name: if name.is_empty() {
            "Wall screen".into()
        } else {
            name
        },
        room,
        last_seen: now_ms(),
        has_cam,
        has_mic,
    };
    {
        let mut c = hub.config.lock();
        if let Some(existing) = c.settings.wall_clients.iter_mut().find(|x| x.id == id) {
            *existing = client.clone();
        } else {
            c.settings.wall_clients.push(client.clone());
        }
    }
    hub.mark_config();
    hub.emit(
        "wall_clients",
        json!(hub.config.lock().settings.wall_clients.clone()),
    );
    Ok(json!(client))
}

pub fn heartbeat(hub: &Hub, id: &str) -> Result<Value, String> {
    let mut found = false;
    {
        let mut c = hub.config.lock();
        if let Some(w) = c.settings.wall_clients.iter_mut().find(|x| x.id == id) {
            w.last_seen = now_ms();
            found = true;
        }
    }
    if found {
        hub.mark_config();
    }
    Ok(json!({"ok": true, "found": found}))
}

pub fn list(hub: &Hub) -> Value {
    json!(hub.config.lock().settings.wall_clients.clone())
}

pub fn remove(hub: &Hub, id: &str) -> Result<Value, String> {
    {
        let mut c = hub.config.lock();
        c.settings.wall_clients.retain(|w| w.id != id);
    }
    hub.mark_config();
    Ok(json!({"ok": true}))
}

pub fn set_presence(hub: &Hub, mode: &str) -> Result<Value, String> {
    set_presence_inner(hub, mode, true)
}

/// `run_hooks`: when false, only store mode (used by presence-triggered schedules to avoid loops).
pub fn set_presence_inner(hub: &Hub, mode: &str, run_hooks: bool) -> Result<Value, String> {
    let mode = match mode {
        "home" | "away" | "night" | "guest" => mode,
        _ => return Err("Presence must be home, away, night, or guest".into()),
    };
    let prev = hub.config.lock().settings.presence_mode.clone();
    if prev == mode {
        return Ok(json!({"ok": true, "mode": mode, "unchanged": true}));
    }
    {
        hub.config.lock().settings.presence_mode = mode.into();
    }
    hub.mark_config();
    hub.emit("presence", json!({"mode": mode, "prev": prev}));
    hub.log("presence", None, &format!("Home set to {mode}"));
    if run_hooks {
        crate::scheduler::fire_presence(hub, mode);
        if matches!(mode, "away" | "night") {
            let want = if mode == "night" { "Night" } else { "All off" };
            let scene_id = hub
                .config
                .lock()
                .scenes
                .iter()
                .find(|s| s.name.eq_ignore_ascii_case(want) || (mode == "away" && s.all_off))
                .map(|s| s.id.clone());
            if let Some(id) = scene_id {
                let _ = hub.apply_scene(&id);
            }
        }
    }
    Ok(json!({"ok": true, "mode": mode}))
}

pub fn notify_wall(hub: &Hub, title: &str, body: &str, kind: &str) {
    hub.emit(
        "wall_notify",
        json!({
            "title": title,
            "body": body,
            "kind": kind,
            "ts": now_ms(),
        }),
    );
}

/// Drop wall clients that have not heartbeated recently (ghost "Mac hub" rows).
pub fn prune_stale(hub: &Hub, max_age_ms: i64) {
    let cutoff = now_ms() - max_age_ms;
    let mut changed = false;
    {
        let mut c = hub.config.lock();
        let before = c.settings.wall_clients.len();
        c.settings.wall_clients.retain(|w| w.last_seen >= cutoff);
        changed = c.settings.wall_clients.len() != before;
    }
    if changed {
        hub.mark_config();
        hub.emit(
            "wall_clients",
            json!(hub.config.lock().settings.wall_clients.clone()),
        );
    }
}

pub fn contacts_list(hub: &Hub) -> Value {
    json!(hub.config.lock().settings.contacts.clone())
}

pub fn contact_upsert(hub: &Hub, a: &Value) -> Result<Value, String> {
    let id = a
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(new_id);
    let name = a
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or("Missing name")?
        .trim()
        .to_string();
    if name.is_empty() {
        return Err("Name required".into());
    }
    let contact = Contact {
        id: id.clone(),
        name,
        favorite: a.get("favorite").and_then(|v| v.as_bool()).unwrap_or(false),
        app: a
            .get("app")
            .and_then(|v| v.as_str())
            .unwrap_or("facetime")
            .to_string(),
        handle: a
            .get("handle")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        note: a
            .get("note")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    };
    {
        let mut c = hub.config.lock();
        if let Some(existing) = c.settings.contacts.iter_mut().find(|x| x.id == id) {
            *existing = contact.clone();
        } else {
            c.settings.contacts.push(contact.clone());
        }
    }
    hub.mark_config();
    Ok(json!(contact))
}

pub fn contact_delete(hub: &Hub, id: &str) -> Result<Value, String> {
    {
        let mut c = hub.config.lock();
        c.settings.contacts.retain(|x| x.id != id);
    }
    hub.mark_config();
    Ok(json!({"ok": true}))
}

pub fn board_set(hub: &Hub, notes: Vec<String>) -> Result<Value, String> {
    {
        hub.config.lock().settings.board_notes = notes
            .into_iter()
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .take(20)
            .collect();
    }
    hub.mark_config();
    Ok(json!(hub.config.lock().settings.board_notes.clone()))
}
