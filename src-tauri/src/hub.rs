//! The Hub: single source of truth for devices, live state, config and events.

use crate::drivers::{self, wiz, Driver};
use crate::effects::{self, Running};
use crate::energy::EnergyStore;
use crate::model::*;
use crate::scenes;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

/// Misses in a row before a device is shown as offline (3 x 2.5 s polls).
pub const MISS_LIMIT: u32 = 3;
/// How long an optimistic command shields live state from stale polls.
pub const OPTIMISTIC_HOLD: Duration = Duration::from_millis(1500);

#[derive(Clone, Debug)]
pub struct Event {
    pub name: String,
    pub data: Value,
}

/// Describe a meaningful change between two live states, for the activity feed.
fn transition(before: &Live, after: &Live) -> Option<(&'static str, &'static str)> {
    if before.seen && !before.online && after.online {
        return Some(("online", "back online"));
    }
    match (before.on, after.on) {
        (Some(false), Some(true)) => Some(("on", "turned on")),
        (Some(true), Some(false)) => Some(("off", "turned off")),
        _ => None,
    }
}

pub struct Hub {
    pub dir: PathBuf,
    pub devices: Mutex<HashMap<String, Device>>,
    pub live: Mutex<HashMap<String, Live>>,
    pub config: Mutex<Config>,
    pub energy: Mutex<EnergyStore>,
    dirty: Mutex<HashSet<String>>,
    pub bus: broadcast::Sender<Event>,
    pub activity: Mutex<VecDeque<Value>>,
    pub drivers: Vec<Box<dyn Driver>>,
    pub effect: Mutex<Option<Running>>,
    pub candidates: Mutex<Vec<Candidate>>,
    pub scanning: AtomicBool,
    pub web: Mutex<Option<crate::web::WebHandle>>,
    devices_dirty: AtomicBool,
    config_dirty: AtomicBool,
}

// ---------- persistence ----------

fn write_atomic(path: &Path, data: &str) {
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, data).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

pub fn is_loopback(ip: &str) -> bool {
    ip.starts_with("127.") || ip == "localhost" || ip.is_empty()
}

/// Parse devices.json in either the old (map keyed by MAC) or new (versioned) format.
pub fn parse_devices(raw: &str) -> Vec<Device> {
    let Ok(v) = serde_json::from_str::<Value>(raw) else {
        return vec![];
    };
    if v.get("version").and_then(|x| x.as_u64()).unwrap_or(0) >= 2 {
        return v
            .get("devices")
            .and_then(|d| serde_json::from_value::<Vec<Device>>(d.clone()).ok())
            .unwrap_or_default();
    }
    // Legacy: { "<mac>": { name, ip, module, fw_version, kind, ... } }
    let mut out = Vec::new();
    if let Some(map) = v.as_object() {
        for (mac, o) in map {
            let s = |k: &str| o.get(k).and_then(|x| x.as_str()).map(String::from);
            let module = s("module");
            let kind = match s("kind").as_deref() {
                Some("plug") => "plug",
                _ => "light",
            };
            let room = match s("room").as_deref() {
                None | Some("") | Some("Living") => "Living Room".to_string(),
                Some(r) => r.to_string(),
            };
            let power = o
                .get("power_supported")
                .and_then(|x| x.as_bool())
                .unwrap_or(false);
            out.push(Device {
                id: format!("wiz:{mac}"),
                driver: "wiz".into(),
                kind: kind.into(),
                name: s("name").unwrap_or_else(|| format!("WiZ {}", &mac[mac.len().saturating_sub(4)..])),
                ip: s("ip").unwrap_or_default(),
                mac: mac.clone(),
                caps: wiz::caps_from_module(module.as_deref().unwrap_or(""), power),
                module,
                fw: s("fw_version"),
                room,
                order: o.get("order").and_then(|x| x.as_i64()).unwrap_or(999) as i32,
                favorite: o.get("favorite").and_then(|x| x.as_bool()).unwrap_or(false),
                note: s("note").unwrap_or_default(),
                power_supported: power,
                energy_wh_lifetime: o
                    .get("energy_wh_lifetime")
                    .and_then(|x| x.as_f64())
                    .unwrap_or(0.0),
                home_id: o.get("home_id").and_then(|x| x.as_u64()),
                room_id: o.get("room_id").and_then(|x| x.as_u64()),
                ..Default::default()
            });
        }
    }
    out
}

impl Hub {
    pub fn new(dir: &Path) -> Arc<Hub> {
        let _ = std::fs::create_dir_all(dir);
        if let Ok(raw) = std::fs::read_to_string(dir.join("devices.json")) {
            if !raw.contains("\"version\"") && !dir.join("devices.v1.bak").exists() {
                let _ = std::fs::write(dir.join("devices.v1.bak"), raw);
            }
        }
        let mut devs: Vec<Device> = std::fs::read_to_string(dir.join("devices.json"))
            .map(|s| parse_devices(&s))
            .unwrap_or_default();
        // Remove leftovers of the old demo setup (loopback fake bulbs).
        devs.retain(|d| d.driver != "wiz" || !is_loopback(&d.ip) || d.port != 0);
        let mut config: Config = std::fs::read_to_string(dir.join("config.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        scenes::ensure_builtin(&mut config);
        if config.rooms.is_empty() {
            config.rooms = vec!["Living Room".into(), "Bedroom".into(), "Kitchen".into()];
        }
        for d in &devs {
            if !d.room.is_empty() && !config.rooms.contains(&d.room) {
                config.rooms.push(d.room.clone());
            }
        }
        let (tx, _) = broadcast::channel(256);
        let hub = Hub {
            dir: dir.to_path_buf(),
            devices: Mutex::new(devs.into_iter().map(|d| (d.id.clone(), d)).collect()),
            live: Mutex::new(HashMap::new()),
            config: Mutex::new(config),
            energy: Mutex::new(EnergyStore::load(dir)),
            dirty: Mutex::new(HashSet::new()),
            bus: tx,
            activity: Mutex::new(VecDeque::new()),
            drivers: drivers::all(),
            effect: Mutex::new(None),
            candidates: Mutex::new(vec![]),
            scanning: AtomicBool::new(false),
            web: Mutex::new(None),
            devices_dirty: AtomicBool::new(true),
            config_dirty: AtomicBool::new(true),
        };
        hub.save_all();
        Arc::new(hub)
    }

    pub fn save_all(&self) {
        if self.devices_dirty.swap(false, Ordering::SeqCst) {
            let mut list: Vec<Device> = self.devices.lock().values().cloned().collect();
            list.sort_by(|a, b| (a.order, &a.name).cmp(&(b.order, &b.name)));
            let s = serde_json::to_string_pretty(&json!({"version": 2, "devices": list}));
            if let Ok(s) = s {
                write_atomic(&self.dir.join("devices.json"), &s);
            }
        }
        if self.config_dirty.swap(false, Ordering::SeqCst) {
            if let Ok(s) = serde_json::to_string_pretty(&*self.config.lock()) {
                write_atomic(&self.dir.join("config.json"), &s);
            }
        }
    }

    pub fn mark_devices(&self) {
        self.devices_dirty.store(true, Ordering::SeqCst);
    }
    pub fn mark_config(&self) {
        self.config_dirty.store(true, Ordering::SeqCst);
    }

    /// Spawn the poller, event flusher, saver and scheduler threads.
    pub fn start(self: &Arc<Self>) {
        // Poller
        let hub = self.clone();
        thread::spawn(move || {
            let mut tick: u64 = 0;
            loop {
                let started = Instant::now();
                let devs: Vec<Device> = hub.devices.lock().values().cloned().collect();
                thread::scope(|s| {
                    for drv in &hub.drivers {
                        if tick % drv.every() != 0 {
                            continue;
                        }
                        let mine: Vec<Device> = devs
                            .iter()
                            .filter(|d| d.driver == drv.name())
                            .cloned()
                            .collect();
                        if mine.is_empty() {
                            continue;
                        }
                        let hub = &hub;
                        let drv = drv.as_ref();
                        s.spawn(move || drv.poll(hub, &mine));
                    }
                });
                tick += 1;
                let spent = started.elapsed();
                thread::sleep(Duration::from_millis(2500).saturating_sub(spent));
            }
        });
        // Event flusher: throttled state deltas (~10 Hz).
        let hub = self.clone();
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(100));
            hub.flush_events();
        });
        // Saver
        let hub = self.clone();
        thread::spawn(move || {
            let mut n = 0u32;
            loop {
                thread::sleep(Duration::from_secs(3));
                hub.save_all();
                n += 1;
                if n % 20 == 0 {
                    hub.energy.lock().save(&hub.dir);
                }
            }
        });
        crate::scheduler::start(self.clone());
        // Quietly find WiZ bulbs on the network, then re-check while any WiZ device is offline
        // (its IP may have changed).
        if std::env::var_os("HUB_NO_SCAN").is_some() {
            return;
        }
        let hub = self.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(600));
            crate::discovery::scan(&hub, false);
            loop {
                thread::sleep(Duration::from_secs(45));
                let offline = {
                    let devs = hub.devices.lock();
                    let live = hub.live.lock();
                    devs.values().any(|d| {
                        d.driver == "wiz" && d.port == 0 && live.get(&d.id).map(|l| !l.online).unwrap_or(false)
                    })
                };
                if offline {
                    crate::discovery::scan(&hub, false);
                }
            }
        });
    }

    pub fn shutdown(&self) {
        self.save_all();
        self.energy.lock().save(&self.dir);
    }

    // ---------- events ----------

    pub fn emit(&self, name: &str, data: Value) {
        let _ = self.bus.send(Event {
            name: name.to_string(),
            data,
        });
    }

    fn mark_live(&self, id: &str) {
        self.dirty.lock().insert(id.to_string());
    }

    pub fn flush_events(&self) {
        let ids: Vec<String> = {
            let mut d = self.dirty.lock();
            if d.is_empty() {
                return;
            }
            d.drain().collect()
        };
        let live = self.live.lock();
        let mut out = serde_json::Map::new();
        for id in ids {
            if let Some(l) = live.get(&id) {
                out.insert(id, serde_json::to_value(l).unwrap_or(Value::Null));
            }
        }
        drop(live);
        if !out.is_empty() {
            self.emit("live", Value::Object(out));
        }
    }

    /// Structure changed (devices, rooms, scenes, ...): push a full snapshot.
    pub fn notify_snapshot(&self) {
        self.emit("snapshot", self.snapshot());
    }

    // ---------- poller reports ----------

    pub fn report_ok(&self, id: &str, f: impl FnOnce(&mut Live)) {
        let mut live = self.live.lock();
        let l = live.entry(id.to_string()).or_default();
        let before = l.clone();
        if l.held() {
            // A command is in flight: accept only fields that cannot fight the UI.
            let mut scratch = l.clone();
            f(&mut scratch);
            l.rssi = scratch.rssi;
            l.value = scratch.value;
            l.unit = scratch.unit;
            l.current = scratch.current;
            l.watts = scratch.watts.or(l.watts);
        } else {
            f(l);
        }
        l.online = true;
        l.seen = true;
        l.misses = 0;
        let ev = transition(&before, l);
        let changed = !before.same(l);
        drop(live);
        if changed {
            self.mark_live(id);
        }
        if let Some((kind, text)) = ev {
            self.log(kind, Some(id), text);
        }
    }

    pub fn report_miss(&self, id: &str) {
        let mut live = self.live.lock();
        let l = live.entry(id.to_string()).or_default();
        l.misses += 1;
        if l.misses >= MISS_LIMIT && l.online {
            l.online = false;
            drop(live);
            self.mark_live(id);
            self.log("offline", Some(id), "went offline");
        } else if !l.seen && l.misses >= MISS_LIMIT {
            // never seen: stays offline, but make sure the UI has an entry
            drop(live);
            self.mark_live(id);
        }
    }

    pub fn report_power(&self, id: &str, watts: f64) {
        {
            let mut live = self.live.lock();
            let l = live.entry(id.to_string()).or_default();
            if l.watts != Some(watts) {
                l.watts = Some(watts);
                drop(live);
                self.mark_live(id);
            }
        }
        let wh = self.energy.lock().sample(id, watts, Instant::now());
        if wh > 0.0 {
            if let Some(d) = self.devices.lock().get_mut(id) {
                d.energy_wh_lifetime += wh;
                d.energy_wh_session += wh;
            }
        }
    }

    /// Write live state directly (effects, optimistic updates) and hold polls off.
    pub fn write_live(&self, id: &str, hold: Duration, f: impl FnOnce(&mut Live)) {
        let mut live = self.live.lock();
        let l = live.entry(id.to_string()).or_default();
        let before = l.clone();
        f(l);
        l.hold_until = if hold.is_zero() {
            None
        } else {
            Some(Instant::now() + hold)
        };
        let ev = transition(&before, l);
        let changed = !before.same(l);
        drop(live);
        if changed {
            self.mark_live(id);
        }
        if let Some((kind, text)) = ev {
            self.log(kind, Some(id), text);
        }
    }

    /// Append to the in-memory activity feed (newest last, capped).
    pub fn log(&self, kind: &str, id: Option<&str>, text: &str) {
        let name = id.and_then(|i| self.devices.lock().get(i).map(|d| d.name.clone()));
        let entry = json!({
            "ts": chrono::Local::now().timestamp_millis(),
            "kind": kind,
            "id": id,
            "name": name,
            "text": text,
        });
        let mut q = self.activity.lock();
        // collapse rapid duplicates (e.g. a poll echoing our own command)
        if let Some(last) = q.back() {
            if last["id"] == entry["id"]
                && last["text"] == entry["text"]
                && entry["ts"].as_i64().unwrap_or(0) - last["ts"].as_i64().unwrap_or(0) < 4000
            {
                return;
            }
        }
        q.push_back(entry);
        while q.len() > 200 {
            q.pop_front();
        }
    }

    pub fn recent_activity(&self, limit: usize) -> Value {
        let q = self.activity.lock();
        let v: Vec<Value> = q.iter().rev().take(limit).cloned().collect();
        Value::Array(v)
    }

    // ---------- devices ----------

    pub fn update_device(&self, id: &str, f: impl FnOnce(&mut Device)) -> bool {
        let found = {
            let mut devs = self.devices.lock();
            match devs.get_mut(id) {
                Some(d) => {
                    f(d);
                    true
                }
                None => false,
            }
        };
        if found {
            self.mark_devices();
        }
        found
    }

    pub fn add_device(&self, mut d: Device) -> Device {
        {
            let mut devs = self.devices.lock();
            if let Some(existing) = devs.get_mut(&d.id) {
                // refresh network location of a known device
                existing.ip = d.ip.clone();
                if d.port != 0 {
                    existing.port = d.port;
                }
                return existing.clone();
            }
            let max = devs.values().map(|x| x.order).filter(|o| *o < 900).max().unwrap_or(-1);
            d.order = max + 1;
            devs.insert(d.id.clone(), d.clone());
        }
        {
            let mut cfg = self.config.lock();
            if !d.room.is_empty() && !cfg.rooms.contains(&d.room) {
                cfg.rooms.push(d.room.clone());
            }
        }
        self.mark_devices();
        self.mark_config();
        d
    }

    pub fn remove_device(&self, id: &str) {
        self.devices.lock().remove(id);
        self.live.lock().remove(id);
        self.energy.lock().forget(id);
        self.mark_devices();
    }

    pub fn device(&self, id: &str) -> Option<Device> {
        self.devices.lock().get(id).cloned()
    }

    pub fn driver(&self, name: &str) -> Option<&dyn Driver> {
        self.drivers.iter().find(|d| d.name() == name).map(|d| d.as_ref())
    }

    pub fn sorted_devices(&self) -> Vec<Device> {
        let mut v: Vec<Device> = self.devices.lock().values().cloned().collect();
        v.sort_by(|a, b| (a.order, &a.name).cmp(&(b.order, &b.name)));
        v
    }

    // ---------- commands ----------

    fn optimistic(&self, dev: &Device, cmd: &Cmd) {
        self.write_live(&dev.id, OPTIMISTIC_HOLD, |l| {
            if let Some(b) = cmd.brightness {
                if b == 0 {
                    l.on = Some(false);
                } else {
                    l.brightness = Some(b.clamp(1, 100));
                    l.on = Some(true);
                }
            }
            if let Some(rgb) = cmd.rgb_value() {
                l.rgb = Some(rgb);
                l.temp = None;
                l.scene_id = None;
                l.on = Some(true);
            }
            if let Some(t) = cmd.temp {
                l.temp = Some(t);
                l.rgb = None;
                l.scene_id = None;
                l.on = Some(true);
            }
            if let Some(s) = cmd.scene_id {
                l.scene_id = Some(s);
                l.on = Some(true);
            }
            if let Some(o) = cmd.on {
                l.on = Some(o);
            }
            if let Some(t) = cmd.target {
                l.target = Some(t);
            }
            if let Some(v) = cmd.volume {
                l.volume = Some(v.clamp(0.0, 1.0));
            }
            if let Some(m) = cmd.media.as_deref() {
                match m {
                    "play" => {
                        l.on = Some(true);
                        l.value = Some("playing".into());
                    }
                    "pause" => l.value = Some("paused".into()),
                    "stop" => {
                        l.on = Some(false);
                        l.value = Some("idle".into());
                    }
                    _ => {}
                }
            }
        });
    }

    /// Optimistic update, send to the driver, reconcile on the next poll.
    pub fn set_device(&self, id: &str, cmd: &Cmd) -> Result<(), String> {
        if cmd.is_empty() {
            return Ok(());
        }
        let dev = self.device(id).ok_or_else(|| format!("Unknown device {id}"))?;
        if dev.kind == "light" && self.effect.lock().is_some() {
            effects::stop(self);
        }
        self.optimistic(&dev, cmd);
        let drv = self
            .driver(&dev.driver)
            .ok_or_else(|| format!("No driver {}", dev.driver))?;
        match drv.command(self, &dev, cmd) {
            Ok(()) => {
                self.write_live(id, Duration::from_millis(1000), |l| {
                    l.online = true;
                    l.seen = true;
                    l.misses = 0;
                });
                Ok(())
            }
            Err(e) => {
                // release the hold so the next poll shows the truth
                self.write_live(id, Duration::ZERO, |_| {});
                Err(e)
            }
        }
    }

    /// Run several commands concurrently.
    pub fn set_many(&self, items: Vec<(String, Cmd)>) -> Vec<String> {
        let errors = Mutex::new(Vec::new());
        thread::scope(|s| {
            for (id, cmd) in &items {
                let errors = &errors;
                s.spawn(move || {
                    if let Err(e) = self.set_device(id, cmd) {
                        errors.lock().push(e);
                    }
                });
            }
        });
        errors.into_inner()
    }

    /// Resolve a target string ("all", "lights", "plugs", "room:X", "device:ID").
    pub fn resolve_target(&self, target: &str) -> Vec<Device> {
        self.sorted_devices()
            .into_iter()
            .filter(|d| match target {
                "all" => matches!(d.kind.as_str(), "light" | "plug" | "switch"),
                "lights" => d.kind == "light",
                "plugs" => d.kind == "plug" || d.kind == "switch",
                t => {
                    if let Some(r) = t.strip_prefix("room:") {
                        d.room == r && d.has_cap("onoff")
                    } else if let Some(i) = t.strip_prefix("device:") {
                        d.id == i
                    } else {
                        false
                    }
                }
            })
            .collect()
    }

    pub fn apply_scene(&self, scene_id: &str) -> Result<(), String> {
        let scene = self
            .config
            .lock()
            .scenes
            .iter()
            .find(|s| s.id == scene_id)
            .cloned()
            .ok_or("Scene not found")?;
        self.log("scene", None, &format!("scene {} applied", scene.name));
        let mut items: Vec<(String, Cmd)> = Vec::new();
        if scene.all_off {
            for d in self.resolve_target("all") {
                items.push((d.id, Cmd { on: Some(false), ..Default::default() }));
            }
        } else if let Some(g) = &scene.global {
            for d in self.resolve_target("lights") {
                items.push((d.id, g.to_cmd()));
            }
        }
        for it in &scene.items {
            items.retain(|(id, _)| *id != it.id);
            if self.device(&it.id).is_some() {
                items.push((it.id.clone(), it.state.to_cmd()));
            }
        }
        if items.iter().any(|(id, _)| self.device(id).map(|d| d.kind == "light").unwrap_or(false)) {
            effects::stop(self);
        }
        let errs = self.set_many(items);
        if errs.is_empty() {
            Ok(())
        } else {
            Err(errs.join("; "))
        }
    }

    /// Snapshot of the current state of every light, as a scene.
    pub fn capture_scene_items(&self) -> Vec<SceneItem> {
        let live = self.live.lock().clone();
        self.sorted_devices()
            .into_iter()
            .filter(|d| matches!(d.kind.as_str(), "light" | "plug" | "switch"))
            .filter_map(|d| {
                let l = live.get(&d.id)?;
                Some(SceneItem {
                    id: d.id.clone(),
                    state: SceneState {
                        on: l.on,
                        brightness: l.brightness,
                        rgb: l.rgb,
                        temp: l.temp,
                    },
                })
            })
            .collect()
    }

    // ---------- snapshot ----------

    pub fn snapshot(&self) -> Value {
        let devices = self.sorted_devices();
        let live = self.live.lock().clone();
        let mut live_map = serde_json::Map::new();
        for d in &devices {
            let l = live.get(&d.id).cloned().unwrap_or_default();
            live_map.insert(d.id.clone(), serde_json::to_value(&l).unwrap_or(Value::Null));
        }
        let cfg = self.config.lock().clone();
        let s = &cfg.settings;
        let effect = self.effect.lock().as_ref().map(|r| r.params.clone());
        json!({
            "devices": devices,
            "live": live_map,
            "rooms": cfg.rooms,
            "scenes": cfg.scenes,
            "schedules": cfg.schedules,
            "settings": {
                "web_enabled": s.web_enabled,
                "web_port": s.web_port,
                "web_pin_set": !s.web_pin.is_empty(),
                "energy_rate": s.energy_rate,
                "currency": s.currency,
                "theme": s.theme,
                "idle_dim": s.idle_dim,
                "screensaver_secs": s.screensaver_secs,
                "ha_url": s.ha_url,
                "ha_connected": !s.ha_token.is_empty() && !s.ha_url.is_empty(),
                "lat": s.lat,
                "lon": s.lon,
                "weather_units": s.weather_units,
                "cast_outputs": s.cast_outputs,
                "presence_mode": s.presence_mode,
                "board_notes": s.board_notes,
                "contacts": s.contacts,
                "wall_clients": s.wall_clients,
                "home_setup_done": s.home_setup_done,
                "home_layout_id": s.home_layout_id,
                "room_meta": s.room_meta,
            },
            "effect": effect,
            "web": crate::web::status(self),
            "scanning": self.scanning.load(Ordering::SeqCst),
            "candidates": *self.candidates.lock(),
            "wiz_scenes": scenes::WIZ_SCENES.iter().map(|(i,n)| json!({"id": i, "name": n})).collect::<Vec<_>>(),
            "effects": scenes::EFFECTS.iter().map(|(i,n,d)| json!({"id": i, "name": n, "desc": d})).collect::<Vec<_>>(),
            "call_providers": crate::callcenter::providers(),
            "now": chrono::Local::now().timestamp_millis(),
        })
    }

    pub fn energy_report(&self) -> Value {
        let devs = self.sorted_devices();
        let names: HashMap<String, String> =
            devs.iter().map(|d| (d.id.clone(), d.name.clone())).collect();
        let watts: HashMap<String, f64> = {
            let live = self.live.lock();
            devs.iter()
                .filter_map(|d| {
                    let l = live.get(&d.id)?;
                    if !l.online {
                        return None;
                    }
                    Some((d.id.clone(), l.watts?))
                })
                .collect()
        };
        let (rate, cur) = {
            let c = self.config.lock();
            (c.settings.energy_rate, c.settings.currency.clone())
        };
        self.energy.lock().report(&names, &watts, rate, &cur)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let p = std::env::temp_dir().join(format!("hub-test-{}", new_id()));
        let _ = std::fs::create_dir_all(&p);
        p
    }

    #[test]
    fn activity_feed_logs_transitions_and_dedupes() {
        let hub = Hub::new(&tmp());
        let mut a = Live::default();
        a.on = Some(false);
        a.online = true;
        a.seen = true;
        let mut b = a.clone();
        b.on = Some(true);
        assert_eq!(transition(&a, &b), Some(("on", "turned on")));
        assert_eq!(transition(&b, &a), Some(("off", "turned off")));
        // first sighting (unknown -> on) is not an event
        assert_eq!(transition(&Live::default(), &b), None);
        let mut off = b.clone();
        off.online = false;
        assert_eq!(transition(&off, &b), Some(("online", "back online")));

        hub.log("on", Some("x"), "turned on");
        hub.log("on", Some("x"), "turned on"); // echo within 4 s: dropped
        hub.log("scene", None, "scene Relax applied");
        let v = hub.recent_activity(10);
        assert_eq!(v.as_array().unwrap().len(), 2);
        assert_eq!(v[0]["kind"], "scene"); // newest first
    }

    #[test]
    fn migrates_legacy_devices() {
        let raw = r#"{"a8bb50123456":{"name":"Desk","ip":"192.168.1.4","module":"ESP25_SHRGB_01","fw_version":"1.38.0","kind":"bulb","order":2,"favorite":true,"room":"Living","note":"","energy_wh_lifetime":3.5}}"#;
        let d = parse_devices(raw);
        assert_eq!(d.len(), 1);
        let d = &d[0];
        assert_eq!(d.id, "wiz:a8bb50123456");
        assert_eq!(d.kind, "light");
        assert_eq!(d.room, "Living Room");
        assert!(d.has_cap("color"));
        assert_eq!(d.fw.as_deref(), Some("1.38.0"));
        assert!(d.favorite);
    }

    #[test]
    fn miss_threshold_and_retain() {
        let hub = Hub::new(&tmp());
        hub.report_ok("x", |l| {
            l.on = Some(true);
            l.brightness = Some(70);
        });
        hub.report_miss("x");
        hub.report_miss("x");
        assert!(hub.live.lock()["x"].online, "two misses must not flip offline");
        hub.report_miss("x");
        let l = hub.live.lock()["x"].clone();
        assert!(!l.online);
        assert_eq!(l.on, Some(true), "state retained while offline");
        assert_eq!(l.brightness, Some(70));
        hub.report_ok("x", |l| l.on = Some(false));
        assert!(hub.live.lock()["x"].online);
    }

    #[test]
    fn hold_blocks_stale_poll() {
        let hub = Hub::new(&tmp());
        hub.report_ok("x", |l| l.on = Some(false));
        hub.write_live("x", Duration::from_secs(5), |l| l.on = Some(true));
        // stale poll says off
        hub.report_ok("x", |l| l.on = Some(false));
        assert_eq!(hub.live.lock()["x"].on, Some(true));
        // hold released
        hub.write_live("x", Duration::ZERO, |_| {});
        hub.report_ok("x", |l| l.on = Some(false));
        assert_eq!(hub.live.lock()["x"].on, Some(false));
    }
}
