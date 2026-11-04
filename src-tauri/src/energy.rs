//! Energy accounting: trapezoid integration of watt samples, daily rollups, series.

use chrono::{Duration as CDuration, Local, Timelike};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::time::Instant;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DayRec {
    pub total_wh: f64,
    pub devices: HashMap<String, f64>,
    pub hours: Vec<f64>,
}

#[derive(Default)]
pub struct EnergyStore {
    pub days: BTreeMap<String, DayRec>,
    last: HashMap<String, (Instant, f64)>,
}

fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

impl EnergyStore {
    pub fn load(dir: &Path) -> Self {
        let days = std::fs::read_to_string(dir.join("energy.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            days,
            last: HashMap::new(),
        }
    }

    pub fn save(&self, dir: &Path) {
        if let Ok(s) = serde_json::to_string(&self.days) {
            let tmp = dir.join("energy.json.tmp");
            if std::fs::write(&tmp, s).is_ok() {
                let _ = std::fs::rename(tmp, dir.join("energy.json"));
            }
        }
    }

    /// Record a watt sample; returns the Wh added since the previous sample.
    pub fn sample(&mut self, id: &str, watts: f64, now: Instant) -> f64 {
        let mut add = 0.0;
        if let Some((t0, w0)) = self.last.get(id).copied() {
            let dt = now.duration_since(t0).as_secs_f64();
            if dt > 0.0 && dt <= 30.0 {
                add = ((w0 + watts) / 2.0) * dt / 3600.0;
            }
        }
        self.last.insert(id.to_string(), (now, watts));
        if add > 0.0 {
            let key = today();
            let hour = Local::now().hour() as usize;
            let rec = self.days.entry(key).or_default();
            if rec.hours.len() != 24 {
                rec.hours = vec![0.0; 24];
            }
            rec.total_wh += add;
            rec.hours[hour] += add;
            *rec.devices.entry(id.to_string()).or_insert(0.0) += add;
            if self.days.len() > 400 {
                if let Some(first) = self.days.keys().next().cloned() {
                    self.days.remove(&first);
                }
            }
        }
        add
    }

    pub fn forget(&mut self, id: &str) {
        self.last.remove(id);
    }

    pub fn reset(&mut self) {
        self.days.clear();
        self.last.clear();
    }

    /// Series for the energy view.
    pub fn report(
        &self,
        names: &HashMap<String, String>,
        live_watts: &HashMap<String, f64>,
        rate: f64,
        currency: &str,
    ) -> Value {
        let now = Local::now();
        let mut series = Vec::new();
        for i in (0..30).rev() {
            let d = (now - CDuration::days(i)).format("%Y-%m-%d").to_string();
            let wh = self.days.get(&d).map(|r| r.total_wh).unwrap_or(0.0);
            series.push(json!({"date": d, "wh": wh}));
        }
        let sum_last = |n: i64| -> f64 {
            (0..n)
                .map(|i| {
                    let d = (now - CDuration::days(i)).format("%Y-%m-%d").to_string();
                    self.days.get(&d).map(|r| r.total_wh).unwrap_or(0.0)
                })
                .sum()
        };
        let today_rec = self.days.get(&today()).cloned().unwrap_or_default();
        let hours = if today_rec.hours.len() == 24 {
            today_rec.hours.clone()
        } else {
            vec![0.0; 24]
        };
        let mut by_dev: HashMap<String, f64> = HashMap::new();
        for i in 0..30 {
            let d = (now - CDuration::days(i)).format("%Y-%m-%d").to_string();
            if let Some(r) = self.days.get(&d) {
                for (k, v) in &r.devices {
                    *by_dev.entry(k.clone()).or_insert(0.0) += v;
                }
            }
        }
        let mut devices: Vec<Value> = names
            .iter()
            .filter(|(id, _)| by_dev.contains_key(*id) || live_watts.contains_key(*id))
            .map(|(id, name)| {
                json!({
                    "id": id,
                    "name": name,
                    "wh_today": today_rec.devices.get(id).copied().unwrap_or(0.0),
                    "wh_30d": by_dev.get(id).copied().unwrap_or(0.0),
                    "watts": live_watts.get(id).copied(),
                })
            })
            .collect();
        devices.sort_by(|a, b| {
            b["wh_30d"]
                .as_f64()
                .partial_cmp(&a["wh_30d"].as_f64())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let wh_today = today_rec.total_wh;
        let wh_week = sum_last(7);
        let wh_month = sum_last(30);
        let cost = |wh: f64| wh / 1000.0 * rate;
        json!({
            "series": series,
            "hours": hours,
            "devices": devices,
            "live_watts": live_watts.values().sum::<f64>(),
            "wh_today": wh_today,
            "wh_week": wh_week,
            "wh_month": wh_month,
            "cost_today": cost(wh_today),
            "cost_week": cost(wh_week),
            "cost_month": cost(wh_month),
            "rate": rate,
            "currency": currency,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn integrates_trapezoid() {
        let mut e = EnergyStore::default();
        let t0 = Instant::now();
        e.sample("a", 100.0, t0);
        let wh = e.sample("a", 100.0, t0 + Duration::from_secs(18));
        assert!((wh - 0.5).abs() < 1e-6, "{wh}");
        assert!((e.days[&today()].total_wh - 0.5).abs() < 1e-6);
    }

    #[test]
    fn ignores_large_gaps() {
        let mut e = EnergyStore::default();
        let t0 = Instant::now();
        e.sample("a", 100.0, t0);
        assert_eq!(e.sample("a", 100.0, t0 + Duration::from_secs(120)), 0.0);
    }
}
