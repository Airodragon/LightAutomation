//! One entry point for every UI action. Used by the Tauri `call` command and by `POST /api/call/{cmd}`.

use crate::drivers::{cast, ha};
use crate::effects::{self, EffectParams};
use crate::hub::Hub;
use crate::model::*;
use crate::{callcenter, discovery, music, scheduler, wall, weather};
use serde_json::{json, Value};
use std::sync::Arc;

fn s(a: &Value, k: &str) -> Option<String> {
    a.get(k).and_then(|v| v.as_str()).map(String::from)
}

fn need(a: &Value, k: &str) -> Result<String, String> {
    s(a, k).ok_or_else(|| format!("Missing '{k}'"))
}

fn ok() -> Result<Value, String> {
    Ok(json!({"ok": true}))
}

fn snap(hub: &Hub) -> Result<Value, String> {
    hub.notify_snapshot();
    Ok(hub.snapshot())
}

fn ensure_room(hub: &Hub, room: &str) {
    if room.is_empty() {
        return;
    }
    let mut c = hub.config.lock();
    if !c.rooms.iter().any(|r| r == room) {
        c.rooms.push(room.to_string());
        drop(c);
        hub.mark_config();
    }
}

pub fn dispatch(hub: &Arc<Hub>, cmd: &str, a: Value, remote: bool) -> Result<Value, String> {
    match cmd {
        "state" => Ok(hub.snapshot()),

        // ----- control -----
        "set" => {
            let id = need(&a, "id")?;
            let c: Cmd = serde_json::from_value(a.clone()).map_err(|e| e.to_string())?;
            hub.set_device(&id, &c)?;
            ok()
        }
        "set_many" => {
            let ids: Vec<String> = a
                .get("ids")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let c: Cmd = serde_json::from_value(a.clone()).map_err(|e| e.to_string())?;
            let errs = hub.set_many(ids.into_iter().map(|i| (i, c.clone())).collect());
            if errs.is_empty() { ok() } else { Err(errs.join("; ")) }
        }
        "target_set" => {
            // Turn a group on/off: all | lights | plugs | room:X
            let t = need(&a, "target")?;
            let on = a.get("on").and_then(|v| v.as_bool()).unwrap_or(true);
            let items = hub
                .resolve_target(&t)
                .into_iter()
                .map(|d| (d.id, Cmd { on: Some(on), ..Default::default() }))
                .collect();
            let errs = hub.set_many(items);
            if errs.is_empty() { ok() } else { Err(errs.join("; ")) }
        }

        // ----- devices -----
        "device_update" => {
            let id = need(&a, "id")?;
            if let Some(r) = s(&a, "room") {
                ensure_room(hub, &r);
            }
            let found = hub.update_device(&id, |d| {
                if let Some(v) = s(&a, "name") {
                    if !v.trim().is_empty() {
                        d.name = v.trim().to_string();
                    }
                }
                if let Some(v) = s(&a, "room") {
                    d.room = v;
                }
                if let Some(v) = s(&a, "note") {
                    d.note = v;
                }
                if let Some(v) = s(&a, "kind") {
                    d.kind = v;
                }
                if let Some(v) = s(&a, "ip") {
                    d.ip = v;
                }
                if let Some(v) = a.get("port").and_then(|v| v.as_u64()) {
                    d.port = v as u16;
                }
                if let Some(v) = a.get("favorite").and_then(|v| v.as_bool()) {
                    d.favorite = v;
                }
            });
            if !found {
                return Err("Unknown device".into());
            }
            snap(hub)
        }
        "device_remove" => {
            hub.remove_device(&need(&a, "id")?);
            snap(hub)
        }
        "devices_reorder" => {
            let ids: Vec<String> = a
                .get("ids")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            {
                let mut devs = hub.devices.lock();
                for (i, id) in ids.iter().enumerate() {
                    if let Some(d) = devs.get_mut(id) {
                        d.order = i as i32;
                    }
                }
                // anything not listed keeps its relative order after the listed ones
                let mut rest: Vec<(i32, String)> = devs
                    .values()
                    .filter(|d| !ids.contains(&d.id))
                    .map(|d| (d.order, d.id.clone()))
                    .collect();
                rest.sort();
                for (n, (_, id)) in rest.into_iter().enumerate() {
                    if let Some(d) = devs.get_mut(&id) {
                        d.order = (ids.len() + n) as i32;
                    }
                }
            }
            hub.mark_devices();
            snap(hub)
        }
        "prune_offline" => {
            let ids: Vec<String> = {
                let live = hub.live.lock();
                hub.sorted_devices()
                    .into_iter()
                    .filter(|d| live.get(&d.id).map(|l| !l.online).unwrap_or(true))
                    .map(|d| d.id)
                    .collect()
            };
            for id in &ids {
                hub.remove_device(id);
            }
            snap(hub)
        }

        // ----- rooms -----
        "room_add" => {
            let n = need(&a, "name")?.trim().to_string();
            if n.is_empty() {
                return Err("Room name is empty".into());
            }
            ensure_room(hub, &n);
            snap(hub)
        }
        "room_rename" => {
            let from = need(&a, "from")?;
            let to = need(&a, "to")?.trim().to_string();
            if to.is_empty() {
                return Err("Room name is empty".into());
            }
            {
                let mut c = hub.config.lock();
                for r in c.rooms.iter_mut() {
                    if *r == from {
                        *r = to.clone();
                    }
                }
                for sc in c.schedules.iter_mut() {
                    if sc.target == format!("room:{from}") {
                        sc.target = format!("room:{to}");
                    }
                }
                if let Some(meta) = c.settings.room_meta.remove(&from) {
                    c.settings.room_meta.insert(to.clone(), meta);
                }
            }
            for d in hub.devices.lock().values_mut() {
                if d.room == from {
                    d.room = to.clone();
                }
            }
            hub.mark_config();
            hub.mark_devices();
            snap(hub)
        }
        "room_delete" => {
            let n = need(&a, "name")?;
            {
                let mut c = hub.config.lock();
                c.rooms.retain(|r| *r != n);
                c.settings.room_meta.remove(&n);
            }
            for d in hub.devices.lock().values_mut() {
                if d.room == n {
                    d.room = String::new();
                }
            }
            hub.mark_config();
            hub.mark_devices();
            snap(hub)
        }
        "room_reorder" => {
            let names: Vec<String> = a
                .get("names")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            {
                let mut c = hub.config.lock();
                let mut next: Vec<String> = names.into_iter().filter(|n| c.rooms.contains(n)).collect();
                for r in &c.rooms {
                    if !next.contains(r) {
                        next.push(r.clone());
                    }
                }
                c.rooms = next;
            }
            hub.mark_config();
            snap(hub)
        }
        "rooms_apply" => {
            let names: Vec<String> = a
                .get("names")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let names: Vec<String> = names
                .into_iter()
                .map(|n| n.trim().to_string())
                .filter(|n| !n.is_empty())
                .collect();
            if names.is_empty() {
                return Err("Need at least one room".into());
            }
            let layout = s(&a, "layout").unwrap_or_default();
            let meta_in = a.get("room_meta").cloned();
            {
                let mut c = hub.config.lock();
                c.rooms = names.clone();
                if !layout.is_empty() {
                    c.settings.home_layout_id = layout;
                }
                c.settings.home_setup_done = true;
                if let Some(v) = meta_in {
                    if let Ok(m) =
                        serde_json::from_value::<std::collections::HashMap<String, crate::model::RoomMeta>>(v)
                    {
                        c.settings.room_meta = m;
                    }
                } else {
                    c.settings.room_meta.retain(|k, _| names.contains(k));
                }
            }
            for d in hub.devices.lock().values_mut() {
                if !d.room.is_empty() && !names.contains(&d.room) {
                    d.room = String::new();
                }
            }
            hub.mark_config();
            hub.mark_devices();
            snap(hub)
        }

        // ----- discovery -----
        "discover" => {
            let deep = a.get("deep").and_then(|v| v.as_bool()).unwrap_or(true);
            discovery::scan(hub, deep);
            Ok(hub.snapshot())
        }
        "candidate_add" => {
            let ip = need(&a, "ip")?;
            let name = s(&a, "name");
            let hints: Vec<String> = hub
                .candidates
                .lock()
                .iter()
                .find(|c| c.ip == ip)
                .map(|c| c.hints.clone())
                .unwrap_or_default();
            let kind_hint = s(&a, "kind").unwrap_or_default();
            let is_cast = kind_hint == "media"
                || hints.iter().any(|h| {
                    let l = h.to_lowercase();
                    l.contains("cast") || l.contains("chromecast") || l.contains("google cast")
                });
            if is_cast {
                cast::add_cast(hub, &ip, name, 0);
            } else {
                let mut d = discovery::add_by_ip(hub, &ip, 0, name)?;
                if let Some(k) = s(&a, "kind") {
                    if d.driver == "net" {
                        hub.update_device(&d.id, |x| x.kind = k.clone());
                        d.kind = k;
                    }
                }
                let _ = d;
            }
            hub.candidates.lock().retain(|c| c.ip != ip);
            snap(hub)
        }
        "candidate_dismiss" => {
            let ip = need(&a, "ip")?;
            hub.candidates.lock().retain(|c| c.ip != ip);
            snap(hub)
        }
        "device_add_ip" => {
            let ip = need(&a, "ip")?;
            let port = a.get("port").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
            discovery::add_by_ip(hub, ip.trim(), port, s(&a, "name"))?;
            snap(hub)
        }

        // ----- scenes -----
        "scene_save" => {
            let name = need(&a, "name")?.trim().to_string();
            if name.is_empty() {
                return Err("Scene name is empty".into());
            }
            let id = s(&a, "id").unwrap_or_default();
            let items: Vec<SceneItem> = match a.get("items") {
                Some(v) if v.is_array() => serde_json::from_value(v.clone()).map_err(|e| e.to_string())?,
                _ => hub.capture_scene_items(),
            };
            let mut c = hub.config.lock();
            if let Some(sc) = c.scenes.iter_mut().find(|x| x.id == id && !id.is_empty()) {
                sc.name = name;
                if let Some(i) = s(&a, "icon") {
                    sc.icon = i;
                }
                if a.get("items").is_some() || a.get("capture").and_then(|v| v.as_bool()).unwrap_or(false) {
                    sc.items = items;
                }
            } else {
                c.scenes.push(Scene {
                    id: new_id(),
                    name,
                    icon: s(&a, "icon").unwrap_or_else(|| "sparkles".into()),
                    items,
                    ..Default::default()
                });
            }
            drop(c);
            hub.mark_config();
            snap(hub)
        }
        "scene_rename" => {
            let id = need(&a, "id")?;
            let name = need(&a, "name")?;
            if let Some(sc) = hub.config.lock().scenes.iter_mut().find(|x| x.id == id) {
                sc.name = name;
            }
            hub.mark_config();
            snap(hub)
        }
        "scene_delete" => {
            let id = need(&a, "id")?;
            {
                let mut c = hub.config.lock();
                if c.scenes.iter().any(|x| x.id == id && x.builtin) {
                    return Err("Built-in scenes cannot be deleted".into());
                }
                c.scenes.retain(|x| x.id != id);
            }
            hub.mark_config();
            snap(hub)
        }
        "scene_apply" => {
            hub.apply_scene(&need(&a, "id")?)?;
            ok()
        }

        // ----- schedules -----
        "schedule_save" => {
            let mut sc: Schedule = serde_json::from_value(a.clone()).map_err(|e| e.to_string())?;
            if sc.trigger.is_empty() {
                sc.trigger = "time".into();
            }
            if sc.trigger == "time" && (sc.time.len() != 5 || sc.time.as_bytes()[2] != b':') {
                return Err("Time must be HH:MM".into());
            }
            if sc.time.is_empty() {
                sc.time = "07:00".into();
            }
            {
                let mut c = hub.config.lock();
                if sc.id.is_empty() {
                    sc.id = new_id();
                    c.schedules.push(sc);
                } else if let Some(x) = c.schedules.iter_mut().find(|x| x.id == sc.id) {
                    *x = sc;
                } else {
                    c.schedules.push(sc);
                }
            }
            hub.mark_config();
            snap(hub)
        }
        "schedule_delete" => {
            let id = need(&a, "id")?;
            hub.config.lock().schedules.retain(|x| x.id != id);
            hub.mark_config();
            snap(hub)
        }
        "schedule_toggle" => {
            let id = need(&a, "id")?;
            if let Some(x) = hub.config.lock().schedules.iter_mut().find(|x| x.id == id) {
                x.enabled = !x.enabled;
            }
            hub.mark_config();
            snap(hub)
        }
        "schedule_run" => {
            let id = need(&a, "id")?;
            let sc = hub
                .config
                .lock()
                .schedules
                .iter()
                .find(|x| x.id == id)
                .cloned()
                .ok_or("Schedule not found")?;
            scheduler::run(hub, &sc)?;
            ok()
        }

        // ----- effects -----
        "effect_start" => {
            let p: EffectParams = serde_json::from_value(a.clone()).map_err(|e| e.to_string())?;
            effects::start(hub, p);
            ok()
        }
        "effect_stop" => {
            effects::stop(hub);
            ok()
        }

        // ----- energy -----
        "energy" => Ok(hub.energy_report()),
        "activity" => Ok(hub.recent_activity(a.get("limit").and_then(|x| x.as_u64()).unwrap_or(40) as usize)),
        "weather" => {
            let (lat, lon, units) = {
                let c = hub.config.lock();
                (
                    c.settings.lat,
                    c.settings.lon,
                    c.settings.weather_units.clone(),
                )
            };
            weather::fetch(lat, lon, &units)
        }
        "outputs_get" => {
            let ids = hub.config.lock().settings.cast_outputs.clone();
            Ok(json!({ "ids": ids }))
        }
        "outputs_set" => {
            let ids: Vec<String> = a
                .get("ids")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let airplay_names: Vec<String> = a
                .get("airplay")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            {
                let mut c = hub.config.lock();
                c.settings.cast_outputs = ids.clone();
            }
            hub.mark_config();
            // Apply AirPlay multi-room only from the Mac app (not remote web).
            if !remote && !airplay_names.is_empty() {
                let _ = music::airplay_set(&airplay_names);
            } else if !remote && a.get("airplay").is_some() {
                let _ = music::airplay_set(&[]);
            }
            // Nudge HA / Cast targets that were selected: ensure they're "on" if requested
            if a.get("play").and_then(|v| v.as_bool()).unwrap_or(false) {
                for id in &ids {
                    let _ = hub.set_device(
                        id,
                        &Cmd {
                            media: Some("play".into()),
                            on: Some(true),
                            ..Default::default()
                        },
                    );
                }
            }
            hub.log(
                "scene",
                None,
                &format!(
                    "outputs set ({} speaker{})",
                    ids.len(),
                    if ids.len() == 1 { "" } else { "s" }
                ),
            );
            snap(hub)
        }
        "music_now_playing" => {
            if remote {
                return Err("Music controls require the Mac app".into());
            }
            music::now_playing()
        }
        "music_airplay_list" => {
            if remote {
                return Err("AirPlay list requires the Mac app".into());
            }
            music::airplay_list()
        }
        "music_airplay_set" => {
            if remote {
                return Err("AirPlay routing requires the Mac app".into());
            }
            let names: Vec<String> = a
                .get("names")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            music::airplay_set(&names)
        }
        "music_transport" => {
            if remote {
                return Err("Music transport requires the Mac app".into());
            }
            let action = need(&a, "action")?;
            music::transport(&action)
        }
        "music_volume" => {
            if remote {
                return Err("Music volume requires the Mac app".into());
            }
            let level = a
                .get("volume")
                .and_then(|v| v.as_f64())
                .ok_or("Missing volume")?;
            music::set_volume(level)
        }
        "energy_reset" => {
            hub.energy.lock().reset();
            for d in hub.devices.lock().values_mut() {
                d.energy_wh_lifetime = 0.0;
                d.energy_wh_session = 0.0;
            }
            hub.mark_devices();
            Ok(hub.energy_report())
        }

        // ----- settings -----
        "settings_set" => {
            {
                let mut c = hub.config.lock();
                let st = &mut c.settings;
                if let Some(v) = a.get("energy_rate").and_then(|v| v.as_f64()) {
                    st.energy_rate = v.max(0.0);
                }
                if let Some(v) = s(&a, "currency") {
                    st.currency = v;
                }
                if let Some(v) = s(&a, "theme") {
                    if matches!(v.as_str(), "dark" | "light" | "auto") {
                        st.theme = v;
                    }
                }
                if let Some(v) = a.get("idle_dim").and_then(|v| v.as_bool()) {
                    st.idle_dim = v;
                }
                if let Some(v) = a.get("screensaver_secs").and_then(|v| v.as_u64()) {
                    st.screensaver_secs = v.clamp(15, 3600) as u32;
                }
                if let Some(v) = a.get("lat") {
                    st.lat = v.as_f64();
                    weather::clear_cache();
                }
                if let Some(v) = a.get("lon") {
                    st.lon = v.as_f64();
                    weather::clear_cache();
                }
                if let Some(v) = s(&a, "weather_units") {
                    if matches!(v.as_str(), "C" | "F" | "c" | "f") {
                        st.weather_units = v.to_uppercase();
                        weather::clear_cache();
                    }
                }
                if let Some(v) = a.get("cast_outputs").cloned() {
                    if let Ok(ids) = serde_json::from_value::<Vec<String>>(v) {
                        st.cast_outputs = ids;
                    }
                }
                if let Some(v) = s(&a, "presence_mode") {
                    if matches!(v.as_str(), "home" | "away" | "night" | "guest") {
                        st.presence_mode = v;
                    }
                }
                if let Some(v) = a.get("board_notes").cloned() {
                    if let Ok(notes) = serde_json::from_value::<Vec<String>>(v) {
                        st.board_notes = notes;
                    }
                }
                if let Some(v) = a.get("home_setup_done").and_then(|v| v.as_bool()) {
                    st.home_setup_done = v;
                }
                if let Some(v) = s(&a, "home_layout_id") {
                    st.home_layout_id = v;
                }
                if let Some(v) = a.get("room_meta").cloned() {
                    if let Ok(m) =
                        serde_json::from_value::<std::collections::HashMap<String, crate::model::RoomMeta>>(v)
                    {
                        st.room_meta = m;
                    }
                }
                if !remote {
                    if let Some(v) = a.get("web_enabled").and_then(|v| v.as_bool()) {
                        st.web_enabled = v;
                    }
                    if let Some(v) = a.get("web_port").and_then(|v| v.as_u64()) {
                        if v >= 1024 && v <= 65535 {
                            st.web_port = v as u16;
                        }
                    }
                    if let Some(v) = s(&a, "web_pin") {
                        st.web_pin = v;
                    }
                }
            }
            hub.mark_config();
            if !remote {
                crate::web::apply(hub);
            }
            snap(hub)
        }

        // ----- Home Assistant -----
        "ha_connect" => {
            if remote {
                return Err("Connect Home Assistant from the Mac app".into());
            }
            let url = need(&a, "url")?;
            let token = need(&a, "token")?;
            let token = if token.is_empty() {
                hub.config.lock().settings.ha_token.clone()
            } else {
                token
            };
            let states = ha::fetch_states(&url, &token)?;
            {
                let mut c = hub.config.lock();
                c.settings.ha_url = url.trim().to_string();
                c.settings.ha_token = token;
            }
            hub.mark_config();
            let n = states.iter().filter(|e| ha::importable(e)).count();
            hub.notify_snapshot();
            Ok(json!({"ok": true, "entities": n}))
        }
        "ha_disconnect" => {
            {
                let mut c = hub.config.lock();
                c.settings.ha_token.clear();
                c.settings.ha_url.clear();
            }
            hub.mark_config();
            snap(hub)
        }
        "ha_entities" => {
            let (url, token) = {
                let c = hub.config.lock();
                (c.settings.ha_url.clone(), c.settings.ha_token.clone())
            };
            let states = ha::fetch_states(&url, &token)?;
            let have: std::collections::HashSet<String> =
                hub.devices.lock().keys().cloned().collect();
            let mut list: Vec<Value> = states
                .iter()
                .filter(|e| ha::importable(e))
                .filter_map(|e| {
                    let d = ha::to_device(e)?;
                    Some(json!({
                        "entity_id": d.ha_entity,
                        "name": d.name,
                        "kind": d.kind,
                        "state": e.get("state"),
                        "added": have.contains(&d.id),
                    }))
                })
                .collect();
            list.sort_by(|x, y| {
                (x["kind"].as_str(), x["name"].as_str()).cmp(&(y["kind"].as_str(), y["name"].as_str()))
            });
            Ok(json!(list))
        }
        "ha_import" => {
            let (url, token) = {
                let c = hub.config.lock();
                (c.settings.ha_url.clone(), c.settings.ha_token.clone())
            };
            let wanted: Vec<String> = a
                .get("entities")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let states = ha::fetch_states(&url, &token)?;
            let mut n = 0;
            for e in states {
                let Some(id) = e.get("entity_id").and_then(|v| v.as_str()) else { continue };
                if !wanted.iter().any(|w| w == id) {
                    continue;
                }
                if let Some(d) = ha::to_device(&e) {
                    hub.add_device(d);
                    n += 1;
                }
            }
            hub.notify_snapshot();
            Ok(json!({"ok": true, "added": n}))
        }

        // ----- wall hub / presence / call center -----
        "presence_set" => {
            let mode = need(&a, "mode")?;
            wall::set_presence(hub, &mode)?;
            snap(hub)
        }
        "wall_register" => wall::register(hub, &a),
        "wall_heartbeat" => {
            let id = need(&a, "id")?;
            // Drop clients quiet for >3 minutes so ghost "Mac hub" rows disappear.
            wall::prune_stale(hub, 180_000);
            wall::heartbeat(hub, &id)
        }
        "wall_clients" => Ok(wall::list(hub)),
        "wall_remove" => {
            let id = need(&a, "id")?;
            wall::remove(hub, &id)?;
            snap(hub)
        }
        "board_set" => {
            let notes: Vec<String> = a
                .get("notes")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            wall::board_set(hub, notes)?;
            snap(hub)
        }
        "contacts_list" => Ok(wall::contacts_list(hub)),
        "contact_upsert" => {
            wall::contact_upsert(hub, &a)?;
            snap(hub)
        }
        "contact_delete" => {
            let id = need(&a, "id")?;
            wall::contact_delete(hub, &id)?;
            snap(hub)
        }
        "call_providers" => Ok(callcenter::providers()),
        "call_start" => {
            if remote && a.get("app").and_then(|v| v.as_str()) != Some("home") {
                // Wall tablets can start Home Call; Mac apps need the hub Mac for WhatsApp etc.
                // Still allow request — hub Mac opens the app.
            }
            callcenter::start_call(hub, &a)
        }
        "call_answer_provider" => {
            if remote {
                return Err("Answer external apps from the Mac hub display".into());
            }
            let app = need(&a, "app")?;
            callcenter::answer_provider(hub, &app)
        }
        "call_contact" => {
            let id = need(&a, "id")?;
            callcenter::contact_call(hub, &id)
        }
        "webrtc_signal" => callcenter::signal(hub, &a),
        "doorbell_ring" => {
            let id = s(&a, "id");
            callcenter::doorbell_ring(hub, id.as_deref());
            ok()
        }
        "wall_notify" => {
            let title = need(&a, "title")?;
            let body = s(&a, "body").unwrap_or_default();
            let kind = s(&a, "kind").unwrap_or_else(|| "info".into());
            wall::notify_wall(hub, &title, &body, &kind);
            ok()
        }

        other => Err(format!("Unknown command '{other}'")),
    }
}
