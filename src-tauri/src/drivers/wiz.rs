//! Philips WiZ local UDP protocol (default port 38899).

use super::Driver;
use crate::hub::Hub;
use crate::model::{Cmd, Device, Live};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{SocketAddr, UdpSocket};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

pub const DEFAULT_PORT: u16 = 38899;

pub fn port_of(p: u16) -> u16 {
    if p == 0 {
        DEFAULT_PORT
    } else {
        p
    }
}

fn addr(ip: &str, port: u16) -> Option<SocketAddr> {
    format!("{ip}:{}", port_of(port)).parse().ok()
}

fn sock(timeout: Duration) -> Option<UdpSocket> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.set_read_timeout(Some(timeout)).ok()?;
    s.set_write_timeout(Some(timeout)).ok()?;
    Some(s)
}

/// Send JSON, wait for a reply, retry on loss.
pub fn request(
    ip: &str,
    port: u16,
    method: &str,
    params: Value,
    tries: u32,
    timeout_ms: u64,
) -> Option<Value> {
    let payload = json!({"method": method, "params": params}).to_string();
    let to = addr(ip, port)?;
    let timeout = Duration::from_millis(timeout_ms);
    for _ in 0..tries {
        let Some(s) = sock(timeout) else { continue };
        if s.send_to(payload.as_bytes(), to).is_err() {
            continue;
        }
        let mut buf = [0u8; 4096];
        if let Ok((n, _)) = s.recv_from(&mut buf) {
            if let Ok(v) = serde_json::from_slice::<Value>(&buf[..n]) {
                return Some(v);
            }
        }
    }
    None
}

static FIRE: OnceLock<UdpSocket> = OnceLock::new();

/// Fire-and-forget setPilot (animations). A lost frame is replaced by the next.
pub fn fire(ip: &str, port: u16, params: Value) {
    let s = FIRE.get_or_init(|| UdpSocket::bind("0.0.0.0:0").expect("udp socket"));
    if let Some(to) = addr(ip, port) {
        let payload = json!({"method": "setPilot", "params": params}).to_string();
        let _ = s.send_to(payload.as_bytes(), to);
    }
}

pub fn get_pilot(ip: &str, port: u16) -> Option<Value> {
    let r = request(ip, port, "getPilot", json!({}), 2, 400)?;
    r.get("result").cloned()
}

pub fn set_pilot(ip: &str, port: u16, params: Value) -> bool {
    request(ip, port, "setPilot", params, 4, 450)
        .and_then(|v| v.get("result")?.get("success")?.as_bool())
        .unwrap_or(false)
}

pub fn system_config(ip: &str, port: u16) -> Option<Value> {
    let r = request(ip, port, "getSystemConfig", json!({}), 4, 450)?;
    r.get("result").cloned()
}

/// Instantaneous watts when the module meters power.
pub fn get_power(ip: &str, port: u16) -> Option<f64> {
    let r = request(ip, port, "getPower", json!({}), 2, 350)?;
    if r.get("error").is_some() {
        return None;
    }
    let res = r.get("result")?;
    // WiZ reports milliwatts.
    let mw = res
        .as_f64()
        .or_else(|| res.get("power").and_then(|v| v.as_f64()))
        .or_else(|| res.get("value").and_then(|v| v.as_f64()))
        .or_else(|| res.as_object()?.values().find_map(|v| v.as_f64()))?;
    Some(mw / 1000.0)
}

/// Broadcast discovery: mac to ip.
pub fn discover(wait_secs: f64) -> HashMap<String, String> {
    let mut found = HashMap::new();
    let Ok(s) = UdpSocket::bind("0.0.0.0:0") else {
        return found;
    };
    let _ = s.set_broadcast(true);
    let _ = s.set_read_timeout(Some(Duration::from_millis(200)));
    let payload = json!({"method": "getPilot", "params": {}}).to_string();
    let mut targets = vec![format!("255.255.255.255:{DEFAULT_PORT}")];
    if let Some(ip) = crate::discovery::local_ip() {
        let o = ip.octets();
        targets.push(format!("{}.{}.{}.255:{DEFAULT_PORT}", o[0], o[1], o[2]));
    }
    let end = Instant::now() + Duration::from_secs_f64(wait_secs);
    let mut last = Instant::now() - Duration::from_secs(2);
    while Instant::now() < end {
        if last.elapsed() > Duration::from_millis(700) {
            for t in &targets {
                let _ = s.send_to(payload.as_bytes(), t);
            }
            last = Instant::now();
        }
        let mut buf = [0u8; 4096];
        if let Ok((n, src)) = s.recv_from(&mut buf) {
            if let Ok(v) = serde_json::from_slice::<Value>(&buf[..n]) {
                if let Some(mac) = v
                    .get("result")
                    .and_then(|r| r.get("mac"))
                    .and_then(|m| m.as_str())
                {
                    found.insert(mac.to_string(), src.ip().to_string());
                }
            }
        }
    }
    found
}

pub fn kind_from_module(module: &str) -> &'static str {
    let u = module.to_uppercase();
    if u.contains("SOCKET") || u.contains("PLUG") || u.contains("OUTLET") {
        "plug"
    } else {
        "light"
    }
}

pub fn caps_from_module(module: &str, power: bool) -> Vec<String> {
    let u = module.to_uppercase();
    let kind = kind_from_module(module);
    let mut caps: Vec<&str> = vec!["onoff"];
    if kind == "plug" {
        if power {
            caps.push("power");
        }
    } else {
        caps.push("dim");
        if u.is_empty() || u.contains("RGB") {
            caps.push("color");
            caps.push("temp");
        } else if u.contains("TW") {
            caps.push("temp");
        }
        caps.push("scene");
    }
    caps.into_iter().map(String::from).collect()
}

/// Fill a device from a getSystemConfig result.
pub fn enrich(dev: &mut Device, cfg: &Value) {
    if let Some(m) = cfg.get("moduleName").and_then(|v| v.as_str()) {
        dev.module = Some(m.to_string());
        dev.kind = kind_from_module(m).to_string();
        dev.caps = caps_from_module(m, dev.power_supported);
    }
    if let Some(fw) = cfg.get("fwVersion").and_then(|v| v.as_str()) {
        dev.fw = Some(fw.to_string());
    }
    if let Some(h) = cfg.get("homeId").and_then(|v| v.as_u64()) {
        dev.home_id = Some(h);
    }
    if let Some(r) = cfg.get("roomId").and_then(|v| v.as_u64()) {
        dev.room_id = Some(r);
    }
}

/// Translate a getPilot result into live state.
pub fn apply_pilot(l: &mut Live, p: &Value) {
    l.on = p.get("state").and_then(|v| v.as_bool());
    l.brightness = p
        .get("dimming")
        .and_then(|v| v.as_u64())
        .map(|v| v.min(100) as u8);
    l.temp = p.get("temp").and_then(|v| v.as_u64()).map(|v| v as u32);
    let ch = |k: &str| p.get(k).and_then(|v| v.as_u64()).map(|v| v.min(255) as u8);
    l.rgb = match (ch("r"), ch("g"), ch("b")) {
        (Some(r), Some(g), Some(b)) if l.temp.is_none() && (r > 0 || g > 0 || b > 0) => {
            Some([r, g, b])
        }
        _ => None,
    };
    l.scene_id = p
        .get("sceneId")
        .and_then(|v| v.as_u64())
        .filter(|v| *v > 0)
        .map(|v| v as u32);
    l.rssi = p.get("rssi").and_then(|v| v.as_i64());
}

pub struct WizDriver;

impl WizDriver {
    fn poll_one(hub: &Hub, d: &Device) {
        match get_pilot(&d.ip, d.port) {
            Some(p) => {
                hub.report_ok(&d.id, |l| apply_pilot(l, &p));
                if d.kind == "plug" {
                    if let Some(w) = get_power(&d.ip, d.port) {
                        if !d.power_supported {
                            hub.update_device(&d.id, |dev| {
                                dev.power_supported = true;
                                if !dev.has_cap("power") {
                                    dev.caps.push("power".into());
                                }
                            });
                        }
                        hub.report_power(&d.id, w);
                    }
                }
                if d.module.is_none() {
                    if let Some(cfg) = system_config(&d.ip, d.port) {
                        hub.update_device(&d.id, |dev| {
                            enrich(dev, &cfg);
                            // A default name chosen before we knew what it was.
                            if dev.kind == "plug" && dev.name.starts_with("Light ") {
                                dev.name = dev.name.replacen("Light ", "Plug ", 1);
                            }
                        });
                    }
                }
            }
            None => hub.report_miss(&d.id),
        }
    }
}

impl Driver for WizDriver {
    fn name(&self) -> &'static str {
        "wiz"
    }

    fn poll(&self, hub: &Hub, devices: &[Device]) {
        std::thread::scope(|s| {
            for d in devices {
                s.spawn(move || WizDriver::poll_one(hub, d));
            }
        });
    }

    fn command(&self, _hub: &Hub, dev: &Device, cmd: &Cmd) -> Result<(), String> {
        let mut p = serde_json::Map::new();
        let plug = dev.kind == "plug";
        let mut turn_on = false;

        if let Some(b) = cmd.brightness {
            if !plug {
                if b == 0 {
                    p.insert("state".into(), json!(false));
                } else {
                    p.insert("dimming".into(), json!(b.clamp(10, 100)));
                    turn_on = true;
                }
            }
        }
        if !plug {
            if let Some([r, g, b]) = cmd.rgb_value() {
                if dev.has_cap("color") {
                    p.insert("r".into(), json!(r));
                    p.insert("g".into(), json!(g));
                    p.insert("b".into(), json!(b));
                    turn_on = true;
                }
            }
            if let Some(t) = cmd.temp {
                if dev.has_cap("temp") {
                    p.insert("temp".into(), json!(t.clamp(2200, 6500)));
                    turn_on = true;
                }
            }
            if let Some(s) = cmd.scene_id {
                p.insert("sceneId".into(), json!(s));
                turn_on = true;
            }
        }
        match cmd.on {
            Some(o) => {
                p.insert("state".into(), json!(o));
            }
            None => {
                if turn_on && !p.contains_key("state") {
                    p.insert("state".into(), json!(true));
                }
            }
        }
        if p.is_empty() {
            return Ok(());
        }
        if set_pilot(&dev.ip, dev.port, Value::Object(p)) {
            Ok(())
        } else {
            Err(format!("{} did not reply", dev.name))
        }
    }
}
