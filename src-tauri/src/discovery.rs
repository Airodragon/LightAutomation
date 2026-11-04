//! Finding devices: WiZ broadcast (auto add) plus mDNS, SSDP and ARP for everything else.

use crate::drivers::wiz;
use crate::hub::Hub;
use crate::model::{Candidate, Device};
use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::net::{Ipv4Addr, UdpSocket};
use std::process::Command;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

pub fn local_ip() -> Option<Ipv4Addr> {
    // Connecting a UDP socket sends nothing; it only selects the outgoing interface.
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    match s.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(v4) if !v4.is_loopback() => Some(v4),
        _ => None,
    }
}

fn last4(s: &str) -> &str {
    &s[s.len().saturating_sub(4)..]
}

/// Add (or refresh) a WiZ device found at ip:port. Returns the device.
pub fn add_wiz(hub: &Hub, mac: &str, ip: &str, port: u16) -> Device {
    let id = format!("wiz:{mac}");
    if let Some(existing) = hub.device(&id) {
        if existing.ip != ip || (port != 0 && existing.port != port) {
            hub.update_device(&id, |d| {
                d.ip = ip.to_string();
                if port != 0 {
                    d.port = port;
                }
            });
        }
        return existing;
    }
    let mut dev = Device {
        id,
        driver: "wiz".into(),
        mac: mac.to_string(),
        ip: ip.to_string(),
        port,
        ..Default::default()
    };
    dev.power_supported = wiz::get_power(ip, port).is_some();
    if let Some(cfg) = wiz::system_config(ip, port) {
        wiz::enrich(&mut dev, &cfg);
    } else {
        dev.caps = wiz::caps_from_module("", false);
    }
    dev.name = if dev.kind == "plug" {
        format!("Plug {}", last4(mac))
    } else {
        format!("Light {}", last4(mac))
    };
    hub.add_device(dev)
}

/// Add a device by IP. WiZ if it answers on the WiZ port, otherwise a monitored network device.
pub fn add_by_ip(hub: &Hub, ip: &str, port: u16, name: Option<String>) -> Result<Device, String> {
    ip.parse::<std::net::IpAddr>()
        .map_err(|_| format!("'{ip}' is not a valid IP address"))?;
    let pilot = wiz::get_pilot(ip, port)
        .or_else(|| wiz::get_pilot(ip, port))
        .or_else(|| wiz::get_pilot(ip, port));
    if let Some(p) = pilot {
        let mac = p
            .get("mac")
            .and_then(|m| m.as_str())
            .map(String::from)
            .or_else(|| {
                wiz::system_config(ip, port)
                    .and_then(|c| c.get("mac").and_then(|m| m.as_str()).map(String::from))
            })
            .unwrap_or_else(|| ip.replace('.', ""));
        let d = add_wiz(hub, &mac, ip, port);
        if let Some(n) = name.filter(|n| !n.trim().is_empty()) {
            hub.update_device(&d.id, |x| x.name = n.clone());
        }
        return Ok(hub.device(&d.id).unwrap_or(d));
    }
    let dev = Device {
        id: format!("net:{ip}"),
        driver: "net".into(),
        kind: "other".into(),
        name: name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| format!("Device {ip}")),
        ip: ip.to_string(),
        port,
        caps: vec![],
        ..Default::default()
    };
    Ok(hub.add_device(dev))
}

fn norm_mac(m: &str) -> String {
    m.split(':')
        .map(|p| format!("{:0>2}", p.to_lowercase()))
        .collect::<String>()
}

/// ARP table after poking every address in the /24.
fn arp_scan(ip: Ipv4Addr) -> Vec<(String, String)> {
    if let Ok(s) = UdpSocket::bind("0.0.0.0:0") {
        let o = ip.octets();
        for i in 1..255u8 {
            let _ = s.send_to(&[0], format!("{}.{}.{}.{i}:9", o[0], o[1], o[2]));
        }
    }
    std::thread::sleep(Duration::from_millis(1200));
    let out = Command::new("arp").arg("-an").output();
    let mut res = Vec::new();
    if let Ok(o) = out {
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            // ? (192.168.1.1) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]
            let Some(a) = line.find('(') else { continue };
            let Some(b) = line.find(')') else { continue };
            let ipstr = &line[a + 1..b];
            let rest = &line[b + 1..];
            let Some(at) = rest.find(" at ") else { continue };
            let mac = rest[at + 4..].split_whitespace().next().unwrap_or("");
            if mac.contains("incomplete") || mac.len() < 11 {
                continue;
            }
            let mac = norm_mac(mac);
            if mac == "ffffffffffff" || mac.starts_with("01005e") || mac.starts_with("3333") {
                continue;
            }
            if ipstr.ends_with(".255") || ipstr.ends_with(".0") {
                continue;
            }
            res.push((ipstr.to_string(), mac));
        }
    }
    res
}

const MDNS: &[(&str, &str, &str)] = &[
    ("_googlecast._tcp.local.", "media", "Google Cast"),
    ("_airplay._tcp.local.", "media", "AirPlay"),
    ("_raop._tcp.local.", "media", "AirPlay audio"),
    ("_spotify-connect._tcp.local.", "media", "Spotify Connect"),
    ("_hap._tcp.local.", "other", "HomeKit"),
    ("_hue._tcp.local.", "other", "Philips Hue bridge"),
    ("_matter._tcp.local.", "other", "Matter"),
    ("_esphomelib._tcp.local.", "other", "ESPHome"),
    ("_home-assistant._tcp.local.", "other", "Home Assistant"),
    ("_ipp._tcp.local.", "other", "Printer"),
];

fn mdns_scan(secs: f64) -> Vec<(String, String, String, String, u16)> {
    // (ip, name, kind, hint, port)
    let mut out = Vec::new();
    let Ok(daemon) = ServiceDaemon::new() else {
        return out;
    };
    let mut recvs = Vec::new();
    for (ty, kind, hint) in MDNS {
        if let Ok(r) = daemon.browse(ty) {
            recvs.push((r, *kind, *hint));
        }
    }
    let end = Instant::now() + Duration::from_secs_f64(secs);
    while Instant::now() < end {
        for (r, kind, hint) in &recvs {
            while let Ok(ev) = r.try_recv() {
                if let ServiceEvent::ServiceResolved(info) = ev {
                    let name = info
                        .get_property_val_str("fn")
                        .or_else(|| info.get_property_val_str("md"))
                        .map(String::from)
                        .unwrap_or_else(|| {
                            info.get_fullname()
                                .split('.')
                                .next()
                                .unwrap_or("Device")
                                .to_string()
                        });
                    for a in info.get_addresses() {
                        if let std::net::IpAddr::V4(v4) = a {
                            out.push((
                                v4.to_string(),
                                name.clone(),
                                kind.to_string(),
                                hint.to_string(),
                                info.get_port(),
                            ));
                        }
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = daemon.shutdown();
    out
}

fn ssdp_scan(secs: f64) -> Vec<(String, String)> {
    // (ip, friendly name)
    let mut found: HashMap<String, String> = HashMap::new();
    let Ok(s) = UdpSocket::bind("0.0.0.0:0") else {
        return vec![];
    };
    let _ = s.set_read_timeout(Some(Duration::from_millis(250)));
    let msg = "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n";
    let _ = s.send_to(msg.as_bytes(), "239.255.255.250:1900");
    let end = Instant::now() + Duration::from_secs_f64(secs);
    let mut locations: HashMap<String, String> = HashMap::new();
    let mut resent = false;
    while Instant::now() < end {
        if !resent && end.saturating_duration_since(Instant::now()).as_secs_f64() < secs / 2.0 {
            let _ = s.send_to(msg.as_bytes(), "239.255.255.250:1900");
            resent = true;
        }
        let mut buf = [0u8; 2048];
        if let Ok((n, src)) = s.recv_from(&mut buf) {
            let text = String::from_utf8_lossy(&buf[..n]).to_string();
            for line in text.lines() {
                if line.to_lowercase().starts_with("location:") {
                    locations
                        .entry(src.ip().to_string())
                        .or_insert_with(|| line[9..].trim().to_string());
                }
            }
        }
    }
    for (ip, url) in locations {
        let name = ureq::get(&url)
            .timeout(Duration::from_millis(900))
            .call()
            .ok()
            .and_then(|r| r.into_string().ok())
            .and_then(|body| {
                let a = body.find("<friendlyName>")? + 14;
                let b = body[a..].find("</friendlyName>")? + a;
                Some(body[a..b].to_string())
            })
            .unwrap_or_default();
        found.insert(ip, name);
    }
    found.into_iter().collect()
}

/// Scan the network. WiZ devices are added automatically; with `deep` everything
/// else that answers is listed as a candidate.
pub fn scan(hub: &Hub, deep: bool) {
    if hub.scanning.swap(true, Ordering::SeqCst) {
        return;
    }
    hub.emit("scanning", json!(true));
    let wiz_found = wiz::discover(if deep { 3.0 } else { 2.5 });
    let mut changed = false;
    let mut wiz_ips: HashSet<String> = HashSet::new();
    for (mac, ip) in &wiz_found {
        wiz_ips.insert(ip.clone());
        let before = hub.device(&format!("wiz:{mac}")).map(|d| d.ip);
        add_wiz(hub, mac, ip, 0);
        if before.as_deref() != Some(ip.as_str()) {
            changed = true;
        }
    }

    if deep {
        let me = local_ip();
        let mdns_handle = std::thread::spawn(|| mdns_scan(3.5));
        let ssdp_handle = std::thread::spawn(|| ssdp_scan(3.0));
        let arp = me.map(arp_scan).unwrap_or_default();
        let mdns = mdns_handle.join().unwrap_or_default();
        let ssdp = ssdp_handle.join().unwrap_or_default();

        let known_ips: HashSet<String> = hub.devices.lock().values().map(|d| d.ip.clone()).collect();
        let known_macs: HashSet<String> = hub
            .devices
            .lock()
            .values()
            .flat_map(|d| [d.mac.clone(), d.id.trim_start_matches("net:").to_string()])
            .collect();
        let mut map: HashMap<String, Candidate> = HashMap::new();
        let get = |ip: &str| -> bool {
            !(known_ips.contains(ip) || wiz_ips.contains(ip) || Some(ip) == me.map(|m| m.to_string()).as_deref())
        };
        for (ip, mac) in &arp {
            if !get(ip) || known_macs.contains(mac) {
                continue;
            }
            map.entry(ip.clone()).or_insert_with(|| Candidate {
                ip: ip.clone(),
                mac: mac.clone(),
                name: format!("Device {ip}"),
                kind: "other".into(),
                hints: vec![],
                port: 0,
            });
        }
        for (ip, friendly) in ssdp {
            if !get(&ip) {
                continue;
            }
            let c = map.entry(ip.clone()).or_insert_with(|| Candidate {
                ip: ip.clone(),
                mac: String::new(),
                name: format!("Device {ip}"),
                kind: "other".into(),
                hints: vec![],
                port: 0,
            });
            if !friendly.is_empty() {
                c.name = friendly;
            }
            if !c.hints.iter().any(|h| h == "UPnP") {
                c.hints.push("UPnP".into());
            }
        }
        for (ip, name, kind, hint, port) in mdns {
            if !get(&ip) {
                continue;
            }
            let c = map.entry(ip.clone()).or_insert_with(|| Candidate {
                ip: ip.clone(),
                mac: String::new(),
                name: name.clone(),
                kind: kind.clone(),
                hints: vec![],
                port: 0,
            });
            c.name = name;
            if c.kind == "other" || kind == "media" {
                c.kind = kind;
            }
            if hint == "Home Assistant" {
                c.port = if port == 0 { 8123 } else { port };
            }
            if !c.hints.contains(&hint) {
                c.hints.push(hint);
            }
        }
        let mut list: Vec<Candidate> = map.into_values().collect();
        list.sort_by(|a, b| {
            let ka = (a.hints.is_empty(), a.ip.split('.').last().and_then(|x| x.parse::<u32>().ok()));
            let kb = (b.hints.is_empty(), b.ip.split('.').last().and_then(|x| x.parse::<u32>().ok()));
            ka.cmp(&kb)
        });
        *hub.candidates.lock() = list;
        changed = true;
    }
    hub.scanning.store(false, Ordering::SeqCst);
    let _ = changed;
    hub.notify_snapshot();
}
