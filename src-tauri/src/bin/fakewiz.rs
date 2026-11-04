//! Fake WiZ devices for testing: `fakewiz [--base 39001] [--bulbs 4] [--plugs 1] [--drop 0.0]`.
//! Each device listens on 127.0.0.1:<base + n> and speaks the WiZ UDP protocol.
//! `--drop 0.3` randomly ignores 30 % of requests to simulate a flaky Wi-Fi network.

use serde_json::{json, Value};
use std::net::UdpSocket;
use std::sync::{Arc, Mutex};
use std::thread;

struct St {
    on: bool,
    dim: u64,
    rgb: Option<(u64, u64, u64)>,
    temp: Option<u64>,
}

fn main() {
    let mut base: u16 = 39001;
    let mut bulbs = 4u16;
    let mut plugs = 1u16;
    let mut drop_p = 0.0f64;
    let mut a = std::env::args().skip(1);
    while let Some(k) = a.next() {
        let v = a.next().unwrap_or_default();
        match k.as_str() {
            "--base" => base = v.parse().unwrap_or(base),
            "--bulbs" => bulbs = v.parse().unwrap_or(bulbs),
            "--plugs" => plugs = v.parse().unwrap_or(plugs),
            "--drop" => drop_p = v.parse().unwrap_or(0.0),
            _ => {}
        }
    }
    let mut handles = vec![];
    for n in 0..(bulbs + plugs) {
        let port = base + n;
        let plug = n >= bulbs;
        let mac = format!("fa4e0000{:04x}", n + 1);
        let sock = UdpSocket::bind(("127.0.0.1", port)).expect("bind");
        let st = Arc::new(Mutex::new(St {
            on: false,
            dim: 80,
            rgb: None,
            temp: Some(2700),
        }));
        println!("{} {} on 127.0.0.1:{port} mac {mac}", if plug { "plug" } else { "bulb" }, n + 1);
        handles.push(thread::spawn(move || {
            let mut seed: u64 = 0x9E3779B97F4A7C15 ^ (port as u64);
            let mut rnd = move || {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                (seed % 10_000) as f64 / 10_000.0
            };
            let mut buf = [0u8; 2048];
            loop {
                let Ok((len, src)) = sock.recv_from(&mut buf) else { continue };
                let Ok(req) = serde_json::from_slice::<Value>(&buf[..len]) else { continue };
                if drop_p > 0.0 && rnd() < drop_p {
                    continue;
                }
                let method = req["method"].as_str().unwrap_or("");
                let mut s = st.lock().unwrap();
                let resp = match method {
                    "getPilot" => {
                        let mut r = json!({"mac": mac, "rssi": -55, "state": s.on});
                        if plug {
                            // plugs report no dimming or colour
                        } else if let Some((rr, g, b)) = s.rgb {
                            r["r"] = json!(rr);
                            r["g"] = json!(g);
                            r["b"] = json!(b);
                        } else if let Some(t) = s.temp {
                            r["temp"] = json!(t);
                        }
                        if !plug {
                            r["dimming"] = json!(s.dim);
                        }
                        json!({"method": "getPilot", "result": r})
                    }
                    "setPilot" => {
                        let p = &req["params"];
                        if let Some(x) = p["state"].as_bool() {
                            s.on = x;
                        }
                        if let Some(x) = p["dimming"].as_u64() {
                            s.dim = x;
                        }
                        if let (Some(r), Some(g), Some(b)) = (p["r"].as_u64(), p["g"].as_u64(), p["b"].as_u64()) {
                            s.rgb = Some((r, g, b));
                            s.temp = None;
                        }
                        if let Some(t) = p["temp"].as_u64() {
                            s.temp = Some(t);
                            s.rgb = None;
                        }
                        json!({"method": "setPilot", "result": {"success": true}})
                    }
                    "getSystemConfig" => json!({"method": "getSystemConfig", "result": {
                        "mac": mac,
                        "moduleName": if plug { "ESP10_SOCKET_06" } else { "ESP25_SHRGB_01" },
                        "fwVersion": "1.38.0",
                    }}),
                    "getPower" => {
                        if plug {
                            let w = if s.on { 60.0 + rnd() * 2.0 } else { 0.0 };
                            json!({"method": "getPower", "result": {"power": (w * 1000.0) as u64}})
                        } else {
                            json!({"method": "getPower", "error": {"code": -32601, "message": "Method not found"}})
                        }
                    }
                    _ => json!({"error": "unknown"}),
                };
                let _ = sock.send_to(resp.to_string().as_bytes(), src);
            }
        }));
    }
    for h in handles {
        let _ = h.join();
    }
}
