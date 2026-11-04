//! Automations: time, sunrise/sunset, presence mode, and device-state triggers.

use crate::effects;
use crate::hub::Hub;
use crate::model::{Cmd, Schedule};
use chrono::{Datelike, Local, Timelike};
use std::collections::HashMap;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// Should this schedule fire at the given weekday (0 = Monday) and "HH:MM"?
pub fn due(s: &Schedule, weekday: u8, hhmm: &str) -> bool {
    let trigger = if s.trigger.is_empty() {
        "time"
    } else {
        s.trigger.as_str()
    };
    if trigger != "time" {
        return false;
    }
    s.enabled && s.time == hhmm && (s.days.is_empty() || s.days.contains(&weekday))
}

pub fn run(hub: &Arc<Hub>, s: &Schedule) -> Result<(), String> {
    match s.action.as_str() {
        "scene" => hub.apply_scene(&s.scene_id),
        "on" | "off" => {
            let on = s.action == "on";
            let items = hub
                .resolve_target(&s.target)
                .into_iter()
                .map(|d| {
                    (
                        d.id,
                        Cmd {
                            on: Some(on),
                            ..Default::default()
                        },
                    )
                })
                .collect();
            let errs = hub.set_many(items);
            if errs.is_empty() {
                Ok(())
            } else {
                Err(errs.join("; "))
            }
        }
        "presence" => {
            let mode = if s.presence_mode.is_empty() {
                "home"
            } else {
                s.presence_mode.as_str()
            };
            crate::wall::set_presence_inner(hub, mode, false).map(|_| ())
        }
        "wake" => {
            let devs = hub.resolve_target(&s.target);
            let first: Vec<_> = devs
                .iter()
                .map(|d| {
                    (
                        d.id.clone(),
                        Cmd {
                            on: Some(true),
                            brightness: Some(10),
                            temp: Some(2200),
                            ..Default::default()
                        },
                    )
                })
                .collect();
            hub.set_many(first);
            let hub2 = hub.clone();
            thread::spawn(move || {
                for step in 1..=6u8 {
                    thread::sleep(Duration::from_secs(10));
                    let b = (10 + step as u32 * 15).min(100) as u8;
                    let t = 2200 + step as u32 * 500;
                    let items = devs
                        .iter()
                        .map(|d| {
                            (
                                d.id.clone(),
                                Cmd {
                                    brightness: Some(b),
                                    temp: Some(t),
                                    ..Default::default()
                                },
                            )
                        })
                        .collect();
                    hub2.set_many(items);
                }
            });
            Ok(())
        }
        "effect" => {
            if let Some(p) = s.effect.clone() {
                effects::start(hub, p);
            }
            Ok(())
        }
        other => Err(format!("Unknown action {other}")),
    }
}

fn sun_hhmm(hub: &Hub, which: &str) -> Option<String> {
    let (lat, lon, units) = {
        let c = hub.config.lock();
        (
            c.settings.lat,
            c.settings.lon,
            c.settings.weather_units.clone(),
        )
    };
    let w = crate::weather::fetch(lat, lon, &units).ok()?;
    let key = if which == "sunrise" {
        "sunrise"
    } else {
        "sunset"
    };
    let iso = w.get(key)?.as_str()?;
    let t = iso.split('T').nth(1)?;
    Some(t.chars().take(5).collect())
}

/// Called from wall::set_presence when presence mode changes.
pub fn fire_presence(hub: &Hub, mode: &str) {
    // Collect matching schedules and run scene/on/off inline (no Arc available here).
    let list: Vec<Schedule> = hub
        .config
        .lock()
        .schedules
        .iter()
        .filter(|s| {
            s.enabled
                && s.trigger == "presence"
                && (s.presence_mode.is_empty() || s.presence_mode == mode)
        })
        .cloned()
        .collect();
    for s in list {
        match s.action.as_str() {
            "scene" => {
                let _ = hub.apply_scene(&s.scene_id);
            }
            "on" | "off" => {
                let on = s.action == "on";
                let items = hub
                    .resolve_target(&s.target)
                    .into_iter()
                    .map(|d| {
                        (
                            d.id,
                            Cmd {
                                on: Some(on),
                                ..Default::default()
                            },
                        )
                    })
                    .collect();
                let _ = hub.set_many(items);
            }
            _ => {}
        }
    }
}

pub fn start(hub: Arc<Hub>) {
    // Device-state edge detector
    let hub_dev = hub.clone();
    thread::spawn(move || {
        let mut prev: HashMap<String, String> = HashMap::new();
        loop {
            thread::sleep(Duration::from_secs(2));
            let schedules: Vec<Schedule> = hub_dev
                .config
                .lock()
                .schedules
                .iter()
                .filter(|s| s.enabled && s.trigger == "device" && !s.trigger_device.is_empty())
                .cloned()
                .collect();
            if schedules.is_empty() {
                continue;
            }
            let live = hub_dev.live.lock().clone();
            for s in schedules {
                let Some(l) = live.get(&s.trigger_device) else {
                    continue;
                };
                let cur = match s.trigger_state.as_str() {
                    "on" => {
                        if l.on == Some(true) {
                            "on"
                        } else {
                            "off"
                        }
                    }
                    "off" => {
                        if l.on == Some(false) {
                            "off"
                        } else {
                            "on"
                        }
                    }
                    "online" => {
                        if l.online {
                            "online"
                        } else {
                            "offline"
                        }
                    }
                    "offline" => {
                        if !l.online {
                            "offline"
                        } else {
                            "online"
                        }
                    }
                    "locked" => {
                        if l.value.as_deref() == Some("locked") || l.on == Some(true) {
                            "locked"
                        } else {
                            "unlocked"
                        }
                    }
                    "unlocked" => {
                        if l.value.as_deref() == Some("unlocked") || l.on == Some(false) {
                            "unlocked"
                        } else {
                            "locked"
                        }
                    }
                    "ringing" => {
                        // binary motion/doorbell style
                        if l.on == Some(true) {
                            "ringing"
                        } else {
                            "idle"
                        }
                    }
                    other => other,
                };
                let key = format!("{}:{}", s.id, s.trigger_state);
                let was = prev.get(&key).cloned();
                prev.insert(key.clone(), cur.to_string());
                let edge = match s.trigger_state.as_str() {
                    "on" | "online" | "locked" | "unlocked" | "ringing" => {
                        cur == s.trigger_state && was.as_deref() != Some(cur)
                    }
                    "off" | "offline" => cur == s.trigger_state && was.as_deref() != Some(cur),
                    _ => false,
                };
                if edge {
                    if s.trigger_state == "ringing" {
                        crate::callcenter::doorbell_ring(&hub_dev, Some(&s.trigger_device));
                    }
                    let hub = hub_dev.clone();
                    let sched = s.clone();
                    thread::spawn(move || {
                        let _ = run(&hub, &sched);
                    });
                }
            }
        }
    });

    thread::spawn(move || {
        let mut last = String::new();
        let mut last_sun = String::new();
        loop {
            thread::sleep(Duration::from_secs(10));
            let now = Local::now();
            let hhmm = format!("{:02}:{:02}", now.hour(), now.minute());
            let key = format!("{}-{}", now.ordinal(), hhmm);
            if key == last {
                // still check sun once per minute key change only
            } else {
                last = key.clone();
                let wd = now.weekday().num_days_from_monday() as u8;
                let due_list: Vec<Schedule> = hub
                    .config
                    .lock()
                    .schedules
                    .iter()
                    .filter(|s| due(s, wd, &hhmm))
                    .cloned()
                    .collect();
                for s in due_list {
                    let hub = hub.clone();
                    thread::spawn(move || {
                        let _ = run(&hub, &s);
                    });
                }
            }

            // Sunrise / sunset (once per minute)
            if key != last_sun {
                last_sun = key;
                for which in ["sunrise", "sunset"] {
                    if let Some(sun) = sun_hhmm(&hub, which) {
                        if sun == hhmm {
                            let list: Vec<Schedule> = hub
                                .config
                                .lock()
                                .schedules
                                .iter()
                                .filter(|s| s.enabled && s.trigger == which)
                                .cloned()
                                .collect();
                            for s in list {
                                let hub = hub.clone();
                                thread::spawn(move || {
                                    let _ = run(&hub, &s);
                                });
                            }
                        }
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn due_matching() {
        let mut s = Schedule {
            time: "07:30".into(),
            ..Default::default()
        };
        assert!(due(&s, 3, "07:30"));
        assert!(!due(&s, 3, "07:31"));
        s.days = vec![0, 1];
        assert!(!due(&s, 3, "07:30"));
        assert!(due(&s, 1, "07:30"));
        s.enabled = false;
        assert!(!due(&s, 1, "07:30"));
    }
}
