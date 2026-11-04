//! Home Assistant bridge: control almost any brand through a long-lived token.

use super::Driver;
use crate::hub::Hub;
use crate::model::{Cmd, Device, Live};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;

fn base(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

pub fn fetch_states(url: &str, token: &str) -> Result<Vec<Value>, String> {
    if url.trim().is_empty() || token.trim().is_empty() {
        return Err("Home Assistant is not connected".into());
    }
    let r = ureq::get(&format!("{}/api/states", base(url)))
        .set("Authorization", &format!("Bearer {}", token.trim()))
        .timeout(Duration::from_secs(4))
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(401, _) => "Home Assistant rejected the token".to_string(),
            ureq::Error::Status(c, _) => format!("Home Assistant returned HTTP {c}"),
            other => format!("Cannot reach Home Assistant: {other}"),
        })?;
    r.into_json::<Vec<Value>>().map_err(|e| e.to_string())
}

pub fn call_service(
    url: &str,
    token: &str,
    domain: &str,
    service: &str,
    body: Value,
) -> Result<(), String> {
    ureq::post(&format!("{}/api/services/{domain}/{service}", base(url)))
        .set("Authorization", &format!("Bearer {}", token.trim()))
        .timeout(Duration::from_secs(4))
        .send_json(body)
        .map_err(|e| format!("Home Assistant: {e}"))?;
    Ok(())
}

fn domain_of(entity: &str) -> &str {
    entity.split('.').next().unwrap_or("")
}

/// Domains we import.
pub fn supported_domain(d: &str) -> bool {
    matches!(
        d,
        "light"
            | "switch"
            | "fan"
            | "climate"
            | "media_player"
            | "cover"
            | "sensor"
            | "input_boolean"
            | "alarm_control_panel"
            | "lock"
            | "camera"
            | "binary_sensor"
    )
}

fn attr<'a>(e: &'a Value, k: &str) -> Option<&'a Value> {
    e.get("attributes").and_then(|a| a.get(k))
}

/// Sensors we care about (power, energy, temperature, humidity).
fn useful_sensor(e: &Value) -> bool {
    matches!(
        attr(e, "device_class").and_then(|v| v.as_str()),
        Some("power" | "energy" | "temperature" | "humidity")
    )
}

fn useful_binary(e: &Value) -> bool {
    matches!(
        attr(e, "device_class").and_then(|v| v.as_str()),
        Some(
            "door"
                | "window"
                | "garage_door"
                | "opening"
                | "motion"
                | "occupancy"
                | "smoke"
                | "moisture"
                | "gas"
                | "safety"
                | "lock"
                | "tamper"
        )
    )
}

pub fn importable(e: &Value) -> bool {
    let id = e.get("entity_id").and_then(|v| v.as_str()).unwrap_or("");
    let d = domain_of(id);
    if !supported_domain(d) {
        return false;
    }
    if d == "sensor" {
        return useful_sensor(e);
    }
    if d == "binary_sensor" {
        return useful_binary(e);
    }
    true
}

pub fn to_device(e: &Value) -> Option<Device> {
    let entity = e.get("entity_id")?.as_str()?.to_string();
    let d = domain_of(&entity);
    let name = attr(e, "friendly_name")
        .and_then(|v| v.as_str())
        .unwrap_or(&entity)
        .to_string();
    let (kind, mut caps): (&str, Vec<&str>) = match d {
        "light" => {
            let modes: Vec<String> = attr(e, "supported_color_modes")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            let mut c = vec!["onoff"];
            if modes.iter().any(|m| m != "onoff") {
                c.push("dim");
            }
            if modes
                .iter()
                .any(|m| matches!(m.as_str(), "hs" | "rgb" | "rgbw" | "rgbww" | "xy"))
            {
                c.push("color");
            }
            if modes
                .iter()
                .any(|m| matches!(m.as_str(), "color_temp" | "rgbww" | "hs" | "xy"))
            {
                c.push("temp");
            }
            ("light", c)
        }
        "switch" | "input_boolean" => {
            let outlet = attr(e, "device_class").and_then(|v| v.as_str()) == Some("outlet");
            (if outlet { "plug" } else { "switch" }, vec!["onoff"])
        }
        "fan" => ("switch", vec!["onoff"]),
        "climate" => ("climate", vec!["onoff", "target"]),
        "media_player" => ("media", vec!["onoff", "volume", "media"]),
        "cover" => ("cover", vec!["onoff"]),
        "alarm_control_panel" => ("alarm", vec!["alarm"]),
        "lock" => ("lock", vec!["lock"]),
        "camera" => {
            let mut c = vec!["camera"];
            if let Some(url) = attr(e, "entity_picture")
                .or_else(|| attr(e, "stream_source"))
                .and_then(|v| v.as_str())
            {
                let _ = url;
                c.push("stream");
            }
            ("camera", c)
        }
        "binary_sensor" => ("sensor", vec!["value", "binary"]),
        "sensor" => {
            let mut c = vec!["value"];
            if attr(e, "device_class").and_then(|v| v.as_str()) == Some("power") {
                c.push("power");
            }
            ("sensor", c)
        }
        _ => return None,
    };
    caps.dedup();
    Some(Device {
        id: format!("ha:{entity}"),
        driver: "ha".into(),
        kind: kind.into(),
        name,
        ha_entity: Some(entity),
        caps: caps.into_iter().map(String::from).collect(),
        ..Default::default()
    })
}

/// Translate a Home Assistant state object into live state.
pub fn apply_state(l: &mut Live, e: &Value, dev: &Device) {
    let entity = dev.ha_entity.as_deref().unwrap_or("");
    let d = domain_of(entity);
    let state = e.get("state").and_then(|v| v.as_str()).unwrap_or("");
    match d {
        "light" | "switch" | "fan" | "input_boolean" => {
            l.on = Some(state == "on");
            if let Some(b) = attr(e, "brightness").and_then(|v| v.as_f64()) {
                l.brightness = Some(((b / 255.0) * 100.0).round().clamp(1.0, 100.0) as u8);
            }
            if let Some(a) = attr(e, "rgb_color").and_then(|v| v.as_array()) {
                if a.len() == 3 {
                    let g = |i: usize| a[i].as_u64().unwrap_or(0).min(255) as u8;
                    l.rgb = Some([g(0), g(1), g(2)]);
                }
            } else if state != "on" {
                // keep the last colour while off
            } else {
                l.rgb = None;
            }
            l.temp = attr(e, "color_temp_kelvin")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);
        }
        "cover" => l.on = Some(matches!(state, "open" | "opening")),
        "media_player" => {
            l.on = Some(!matches!(state, "off" | "standby" | "unavailable" | "idle"));
            if matches!(state, "playing" | "paused" | "buffering" | "idle" | "on" | "off" | "standby") {
                l.value = Some(state.to_string());
            }
            l.volume = attr(e, "volume_level").and_then(|v| v.as_f64());
            l.media_title = attr(e, "media_title")
                .or_else(|| attr(e, "media_content_id"))
                .and_then(|v| v.as_str())
                .map(String::from);
            l.media_artist = attr(e, "media_artist")
                .or_else(|| attr(e, "media_series_title"))
                .and_then(|v| v.as_str())
                .map(String::from);
            if let Some(pic) = attr(e, "entity_picture").and_then(|v| v.as_str()) {
                l.media_image = Some(pic.to_string());
            }
            l.media_app = attr(e, "app_name").and_then(|v| v.as_str()).map(String::from);
        }
        "climate" => {
            l.on = Some(state != "off");
            l.value = Some(state.to_string());
            l.current = attr(e, "current_temperature").and_then(|v| v.as_f64());
            l.target = attr(e, "temperature").and_then(|v| v.as_f64());
            l.unit = Some("°".into());
        }
        "sensor" => {
            l.value = Some(state.to_string());
            l.unit = attr(e, "unit_of_measurement")
                .and_then(|v| v.as_str())
                .map(String::from);
            if attr(e, "device_class").and_then(|v| v.as_str()) == Some("power") {
                if let Ok(n) = state.parse::<f64>() {
                    let kw = l.unit.as_deref() == Some("kW");
                    l.watts = Some(if kw { n * 1000.0 } else { n });
                }
            }
        }
        "binary_sensor" => {
            let on = state == "on";
            l.on = Some(on);
            l.value = Some(state.to_string());
            l.unit = attr(e, "device_class")
                .and_then(|v| v.as_str())
                .map(String::from);
        }
        "alarm_control_panel" => {
            l.value = Some(state.to_string());
            l.on = Some(!matches!(state, "disarmed" | "unavailable" | "unknown"));
        }
        "lock" => {
            l.on = Some(state == "locked");
            l.value = Some(state.to_string());
        }
        "camera" => {
            l.on = Some(state == "streaming" || state == "idle" || state == "recording" || state == "on");
            l.value = Some(state.to_string());
            if let Some(pic) = attr(e, "entity_picture").and_then(|v| v.as_str()) {
                l.media_image = Some(pic.to_string());
            }
        }
        _ => {}
    }
}

pub struct HaDriver;

impl Driver for HaDriver {
    fn name(&self) -> &'static str {
        "ha"
    }

    fn poll(&self, hub: &Hub, devices: &[Device]) {
        let (url, token) = {
            let c = hub.config.lock();
            (c.settings.ha_url.clone(), c.settings.ha_token.clone())
        };
        match fetch_states(&url, &token) {
            Ok(states) => {
                let map: HashMap<&str, &Value> = states
                    .iter()
                    .filter_map(|s| Some((s.get("entity_id")?.as_str()?, s)))
                    .collect();
                for d in devices {
                    let Some(entity) = d.ha_entity.as_deref() else { continue };
                    match map.get(entity) {
                        Some(e) if e.get("state").and_then(|v| v.as_str()) != Some("unavailable") => {
                            hub.report_ok(&d.id, |l| apply_state(l, e, d));
                            if d.has_cap("power") {
                                let w = hub.live.lock().get(&d.id).and_then(|l| l.watts);
                                if let Some(w) = w {
                                    hub.report_power(&d.id, w);
                                }
                            }
                        }
                        _ => hub.report_miss(&d.id),
                    }
                }
            }
            Err(_) => {
                for d in devices {
                    hub.report_miss(&d.id);
                }
            }
        }
    }

    fn command(&self, hub: &Hub, dev: &Device, cmd: &Cmd) -> Result<(), String> {
        let entity = dev.ha_entity.clone().ok_or("missing entity")?;
        let d = domain_of(&entity).to_string();
        let (url, token) = {
            let c = hub.config.lock();
            (c.settings.ha_url.clone(), c.settings.ha_token.clone())
        };
        if let Some(t) = cmd.target {
            if d == "climate" {
                return call_service(
                    &url,
                    &token,
                    "climate",
                    "set_temperature",
                    json!({"entity_id": entity, "temperature": t}),
                );
            }
        }
        if d == "alarm_control_panel" {
            if let Some(m) = cmd.media.as_deref() {
                let svc = match m {
                    "arm_home" | "arm_away" | "arm_night" | "disarm" => m,
                    "arm" => "alarm_arm_away",
                    "disarm_alarm" => "alarm_disarm",
                    _ => return Err(format!("Unknown alarm action {m}")),
                };
                let svc = if svc.starts_with("alarm_") {
                    svc
                } else {
                    match svc {
                        "arm_home" => "alarm_arm_home",
                        "arm_away" => "alarm_arm_away",
                        "arm_night" => "alarm_arm_night",
                        "disarm" => "alarm_disarm",
                        other => other,
                    }
                };
                return call_service(
                    &url,
                    &token,
                    "alarm_control_panel",
                    svc,
                    json!({"entity_id": entity}),
                );
            }
        }
        if d == "lock" {
            if let Some(on) = cmd.on {
                return call_service(
                    &url,
                    &token,
                    "lock",
                    if on { "lock" } else { "unlock" },
                    json!({"entity_id": entity}),
                );
            }
        }
        if d == "media_player" {
            if let Some(v) = cmd.volume {
                call_service(
                    &url,
                    &token,
                    "media_player",
                    "volume_set",
                    json!({"entity_id": entity, "volume_level": v.clamp(0.0, 1.0)}),
                )?;
            }
            if let Some(m) = cmd.media.as_deref() {
                let svc = match m {
                    "play" => "media_play",
                    "pause" => "media_pause",
                    "stop" => "media_stop",
                    "next" => "media_next_track",
                    "prev" => "media_previous_track",
                    _ => return Err(format!("Unknown media action {m}")),
                };
                call_service(&url, &token, "media_player", svc, json!({"entity_id": entity}))?;
            }
            if cmd.volume.is_some() || cmd.media.is_some() {
                // still allow on/off below if also set
                if cmd.on.is_none() && cmd.brightness.is_none() {
                    return Ok(());
                }
            }
        }
        let want_on = cmd.on.or_else(|| {
            if cmd.brightness.map(|b| b > 0).unwrap_or(false)
                || cmd.rgb_value().is_some()
                || cmd.temp.is_some()
            {
                Some(true)
            } else {
                None
            }
        });
        if want_on == Some(false) || cmd.brightness == Some(0) {
            let (dom, svc) = match d.as_str() {
                "cover" => ("cover", "close_cover"),
                other => (other, "turn_off"),
            };
            return call_service(&url, &token, dom, svc, json!({"entity_id": entity}));
        }
        if want_on == Some(true) {
            let (dom, svc) = match d.as_str() {
                "cover" => ("cover", "open_cover"),
                other => (other, "turn_on"),
            };
            let mut body = serde_json::Map::new();
            body.insert("entity_id".into(), json!(entity));
            if d == "light" {
                if let Some(b) = cmd.brightness {
                    body.insert("brightness_pct".into(), json!(b.clamp(1, 100)));
                }
                if let Some(rgb) = cmd.rgb_value() {
                    body.insert("rgb_color".into(), json!(rgb));
                }
                if let Some(t) = cmd.temp {
                    body.insert("color_temp_kelvin".into(), json!(t));
                }
            }
            return call_service(&url, &token, dom, svc, Value::Object(body));
        }
        Ok(())
    }
}
