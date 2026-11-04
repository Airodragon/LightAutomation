//! End-to-end: hub + WiZ driver against an in-process fake bulb on a custom port.

use lights_studio_lib::discovery::add_by_ip;
use lights_studio_lib::hub::Hub;
use lights_studio_lib::model::Cmd;
use serde_json::{json, Value};
use std::net::UdpSocket;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

fn spawn_fake(port: u16, up: Arc<AtomicBool>) {
    let sock = UdpSocket::bind(("127.0.0.1", port)).unwrap();
    let state = Arc::new(Mutex::new((false, 50u64)));
    thread::spawn(move || {
        let mut buf = [0u8; 2048];
        loop {
            let Ok((n, src)) = sock.recv_from(&mut buf) else { continue };
            if !up.load(Ordering::SeqCst) {
                continue;
            }
            let req: Value = serde_json::from_slice(&buf[..n]).unwrap();
            let mut s = state.lock().unwrap();
            let resp = match req["method"].as_str().unwrap() {
                "getPilot" => json!({"result": {"mac": "aabbccddeeff", "state": s.0, "dimming": s.1, "temp": 2700, "rssi": -50}}),
                "setPilot" => {
                    if let Some(o) = req["params"]["state"].as_bool() { s.0 = o; }
                    if let Some(d) = req["params"]["dimming"].as_u64() { s.1 = d; }
                    json!({"result": {"success": true}})
                }
                "getSystemConfig" => json!({"result": {"mac": "aabbccddeeff", "moduleName": "ESP25_SHRGB_01", "fwVersion": "1.0"}}),
                _ => json!({"error": {"code": -1}}),
            };
            let _ = sock.send_to(resp.to_string().as_bytes(), src);
        }
    });
}

fn poll(hub: &Hub) {
    let devs: Vec<_> = hub.devices.lock().values().cloned().collect();
    hub.driver("wiz").unwrap().poll(hub, &devs);
}

#[test]
fn control_poll_and_offline_hysteresis() {
    let up = Arc::new(AtomicBool::new(true));
    spawn_fake(39871, up.clone());
    let dir = std::env::temp_dir().join(format!("hub-e2e-{}", std::process::id()));
    let hub = Hub::new(&dir);

    let d = add_by_ip(&hub, "127.0.0.1", 39871, Some("Test bulb".into())).unwrap();
    assert_eq!(d.id, "wiz:aabbccddeeff");
    assert_eq!(d.kind, "light");

    poll(&hub);
    let l = hub.live.lock()[&d.id].clone();
    assert!(l.online && l.seen);
    assert_eq!(l.on, Some(false));

    hub.set_device(&d.id, &Cmd { on: Some(true), brightness: Some(80), ..Default::default() }).unwrap();
    // optimistic state is immediate and survives a poll right after the command
    assert_eq!(hub.live.lock()[&d.id].on, Some(true));
    poll(&hub);
    let l = hub.live.lock()[&d.id].clone();
    assert_eq!(l.on, Some(true));
    assert_eq!(l.brightness, Some(80));

    // device goes silent: stays "online" with last state for two misses, offline on the third
    up.store(false, Ordering::SeqCst);
    poll(&hub);
    poll(&hub);
    assert!(hub.live.lock()[&d.id].online, "two missed polls must not mark it offline");
    assert_eq!(hub.live.lock()[&d.id].on, Some(true));
    poll(&hub);
    assert!(!hub.live.lock()[&d.id].online);
    assert_eq!(hub.live.lock()[&d.id].brightness, Some(80), "last state retained");

    // and recovers
    up.store(true, Ordering::SeqCst);
    poll(&hub);
    assert!(hub.live.lock()[&d.id].online);
}
