//! Software animation engine for ordered WiZ bulbs.

use crate::drivers::wiz;
use crate::hub::Hub;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

pub fn hex_to_rgb(hex: &str) -> (u8, u8, u8) {
    let h = hex.trim_start_matches('#');
    if h.len() < 6 {
        return (255, 255, 255);
    }
    let p = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).unwrap_or(255);
    (p(0), p(2), p(4))
}


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct EffectParams {
    pub effect: Option<String>,
    pub duration: f64,
    pub spread: f64,
    pub fade: f64,
    pub trail: f64,
    pub direction: String,
    pub brightness: u8,
    pub color: String,
    pub speed: f64,
    /// "all" | "room:<name>" | "favorites"
    pub scope: String,
}

impl Default for EffectParams {
    fn default() -> Self {
        Self {
            effect: None,
            duration: 4.0,
            spread: 1.4,
            fade: 0.65,
            trail: 0.35,
            direction: "forward".into(),
            brightness: 100,
            color: "#ff7a1a".into(),
            speed: 1.0,
            scope: "all".into(),
        }
    }
}

fn smoothstep(edge0: f64, edge1: f64, x: f64) -> f64 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn falloff(d: f64, spread: f64, fade: f64, trail: f64, behind: bool) -> f64 {
    let width = spread.max(0.35);
    let soft = 0.15 + fade * 1.2;
    let mut x = 1.0 - smoothstep(0.0, width * soft, d);
    if behind && trail > 0.01 {
        let tw = width * (1.0 + trail * 2.5);
        let tail = (1.0 - smoothstep(0.0, tw, d)) * trail;
        x = x.max(tail * 0.85);
    }
    x
}

fn hsv(h: f64, s: f64, v: f64) -> (u8, u8, u8) {
    let h = h.rem_euclid(1.0);
    let i = (h * 6.0).floor();
    let f = h * 6.0 - i;
    let p = v * (1.0 - s);
    let q = v * (1.0 - f * s);
    let t = v * (1.0 - (1.0 - f) * s);
    let (r, g, b) = match i as i32 % 6 {
        0 => (v, t, p),
        1 => (q, v, p),
        2 => (p, v, t),
        3 => (p, q, v),
        4 => (t, p, v),
        _ => (v, p, q),
    };
    ((r * 255.0) as u8, (g * 255.0) as u8, (b * 255.0) as u8)
}

pub fn render(effect: &str, t: f64, n: usize, p: &EffectParams) -> Vec<((u8, u8, u8), u8)> {
    let mx = p.brightness.clamp(10, 100) as f64;
    let base = hex_to_rgb(&p.color);
    let dur = p.duration.max(0.4);
    let spread = p.spread.max(0.35);
    let fade = p.fade.clamp(0.0, 1.0);
    let trail = p.trail.clamp(0.0, 1.0);
    let rev = p.direction == "reverse";
    let dim = |x: f64| -> u8 { (10.0 + (mx - 10.0) * x.clamp(0.0, 1.0)).round() as u8 };

    let mut effect_name = effect;
    if matches!(effect_name, "chase" | "bounce") && n < 2 {
        effect_name = "breathe";
    }

    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let idx = if rev && matches!(effect_name, "chase" | "bounce") {
            n - 1 - i
        } else {
            i
        };
        let (rgb, d) = match effect_name {
            "chase" => {
                let pos = ((t / dur) * n as f64).rem_euclid(n as f64);
                let mut dist = (idx as f64 - pos).abs();
                dist = dist.min(n as f64 - dist);
                let signed = (idx as f64 - pos).rem_euclid(n as f64);
                let behind = signed > 0.0 && signed < n as f64 / 2.0;
                (base, dim(falloff(dist, spread, fade, trail, behind)))
            }
            "bounce" => {
                let cycle = (t / dur).rem_euclid(2.0);
                let x = if cycle > 1.0 { 2.0 - cycle } else { cycle };
                let pos = x * (n.saturating_sub(1) as f64);
                let dist = (idx as f64 - pos).abs();
                let behind = (idx as f64) < pos;
                (base, dim(falloff(dist, spread, fade, trail, behind)))
            }
            "wave" => {
                let phase = t / dur * std::f64::consts::TAU
                    - idx as f64 * std::f64::consts::TAU / n.max(1) as f64;
                let x = 0.5 + 0.5 * phase.sin();
                let soft = x.powf(0.5 + (1.0 - fade));
                (base, dim(soft))
            }
            "rainbow" => {
                let h = t / dur * 0.35 + idx as f64 / n.max(1) as f64;
                (hsv(h, 1.0, 1.0), dim(1.0))
            }
            "breathe" => {
                let x = 0.5 + 0.5 * (t / dur * std::f64::consts::TAU).sin();
                (base, dim(x))
            }
            "candle" => {
                let x = 0.62
                    + 0.22 * (t * 7.0 / dur + idx as f64 * 1.7).sin()
                    + 0.16 * (t * 13.0 / dur + idx as f64 * 3.1).sin();
                ((255, 147, 41), dim(x))
            }
            "party" => {
                let seed = ((t / dur * 2.5).floor() as i64)
                    .wrapping_mul(131)
                    .wrapping_add(idx as i64);
                let mut x = seed.wrapping_mul(1103515245).wrapping_add(12345) as u64;
                x = (x / 65536) % 10000;
                (hsv(x as f64 / 10000.0, 1.0, 1.0), dim(1.0))
            }
            "sunrise" => {
                let k = (t / (300.0 * dur / 4.0)).clamp(0.0, 1.0);
                (
                    (255, (40.0 + k * 170.0) as u8, (k * 110.0) as u8),
                    dim(0.05 + 0.95 * k),
                )
            }
            _ => (base, dim(1.0)),
        };
        out.push((rgb, d));
    }
    if rev && !matches!(effect_name, "chase" | "bounce") {
        out.reverse();
    }
    out
}

/// A running animation.
pub struct Running {
    pub stop: Arc<AtomicBool>,
    pub params: EffectParams,
}

fn in_scope(scope: &str, d: &crate::model::Device) -> bool {
    if let Some(room) = scope.strip_prefix("room:") {
        return d.room == room;
    }
    match scope {
        "favorites" => d.favorite,
        _ => true,
    }
}

/// Start (or replace) the running effect. Frames are written into the hub's live
/// state, so the UI and the poller see exactly what the lights are doing.
pub fn start(hub: &Arc<Hub>, mut p: EffectParams) {
    if p.effect.as_deref() == Some("stop") || p.effect.is_none() {
        stop(hub);
        return;
    }
    if (p.duration - 4.0).abs() < 0.01 && (p.speed - 1.0).abs() > 0.01 {
        p.duration = (2.5 / p.speed.max(0.2)).clamp(0.5, 30.0);
    }
    stop(hub);
    let flag = Arc::new(AtomicBool::new(false));
    *hub.effect.lock() = Some(Running {
        stop: flag.clone(),
        params: p.clone(),
    });
    hub.notify_snapshot();

    let hub = hub.clone();
    thread::spawn(move || {
        let eff = p.effect.clone().unwrap_or_default();
        let origin = Instant::now();
        while !flag.load(Ordering::SeqCst) {
            let tick = Instant::now();
            let mut devs: Vec<_> = hub
                .devices
                .lock()
                .values()
                .filter(|d| d.driver == "wiz" && d.kind == "light" && in_scope(&p.scope, d))
                .cloned()
                .collect();
            devs.sort_by_key(|d| (d.order, d.name.clone()));
            if !devs.is_empty() {
                let t = origin.elapsed().as_secs_f64();
                let frames = render(&eff, t, devs.len(), &p);
                for (d, ((r, g, b), lvl)) in devs.iter().zip(frames) {
                    if d.has_cap("color") {
                        wiz::fire(
                            &d.ip,
                            d.port,
                            json!({"state": true, "r": r, "g": g, "b": b, "dimming": lvl}),
                        );
                    } else {
                        wiz::fire(&d.ip, d.port, json!({"state": true, "dimming": lvl}));
                    }
                    hub.write_live(&d.id, Duration::from_millis(700), |l| {
                        l.on = Some(true);
                        l.brightness = Some(lvl);
                        l.rgb = if d.has_cap("color") { Some([r, g, b]) } else { None };
                        l.temp = None;
                        l.scene_id = None;
                    });
                }
            }
            let wait = (0.12 - tick.elapsed().as_secs_f64()).max(0.0);
            thread::sleep(Duration::from_secs_f64(wait));
        }
    });
}

/// Signal the worker to stop; never blocks.
pub fn stop(hub: &Hub) {
    let prev = hub.effect.lock().take();
    if let Some(r) = prev {
        r.stop.store(true, Ordering::SeqCst);
        hub.notify_snapshot();
    }
}
