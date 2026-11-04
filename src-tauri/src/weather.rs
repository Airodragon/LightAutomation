//! Weather via Open-Meteo (no API key). Cached on the hub.

use chrono::Timelike;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

struct Cache {
    at: Instant,
    data: Value,
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);
const TTL: Duration = Duration::from_secs(10 * 60);

fn wmo_label(code: i64) -> &'static str {
    match code {
        0 => "Clear",
        1 | 2 => "Partly cloudy",
        3 => "Overcast",
        45 | 48 => "Fog",
        51 | 53 | 55 | 56 | 57 => "Drizzle",
        61 | 63 | 65 | 66 | 67 => "Rain",
        71 | 73 | 75 | 77 => "Snow",
        80 | 81 | 82 => "Showers",
        85 | 86 => "Snow showers",
        95 | 96 | 99 => "Thunderstorm",
        _ => "Unknown",
    }
}

fn period_for(hour: u32, sunrise_h: u32, sunset_h: u32) -> &'static str {
    if hour + 1 >= sunrise_h && hour < sunrise_h + 1 {
        "dawn"
    } else if hour + 1 >= sunset_h && hour < sunset_h + 1 {
        "dusk"
    } else if hour >= sunrise_h && hour < sunset_h {
        "day"
    } else {
        "night"
    }
}

/// Resolve lat/lon: settings first, else IP geolocation, else a sensible default.
pub fn resolve_coords(lat: Option<f64>, lon: Option<f64>) -> (f64, f64) {
    if let (Some(la), Some(lo)) = (lat, lon) {
        return (la, lo);
    }
    if let Ok(r) = ureq::get("https://ipapi.co/json/")
        .timeout(Duration::from_secs(3))
        .call()
    {
        if let Ok(v) = r.into_json::<Value>() {
            if let (Some(la), Some(lo)) = (
                v.get("latitude").and_then(|x| x.as_f64()),
                v.get("longitude").and_then(|x| x.as_f64()),
            ) {
                return (la, lo);
            }
        }
    }
    (28.6139, 77.2090) // New Delhi fallback
}

pub fn fetch(lat: Option<f64>, lon: Option<f64>, units: &str) -> Result<Value, String> {
    {
        let c = CACHE.lock();
        if let Some(hit) = c.as_ref() {
            if hit.at.elapsed() < TTL {
                return Ok(hit.data.clone());
            }
        }
    }
    let (lat, lon) = resolve_coords(lat, lon);
    let temp_unit = if units.eq_ignore_ascii_case("F") {
        "fahrenheit"
    } else {
        "celsius"
    };
    let url = format!(
        "https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m,weather_code,is_day,relative_humidity_2m,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset&timezone=auto&temperature_unit={temp_unit}&forecast_days=1"
    );
    let r = ureq::get(&url)
        .timeout(Duration::from_secs(5))
        .call()
        .map_err(|e| format!("Weather: {e}"))?;
    let v: Value = r.into_json().map_err(|e| e.to_string())?;
    let cur = v.get("current").cloned().unwrap_or(Value::Null);
    let daily = v.get("daily").cloned().unwrap_or(Value::Null);
    let code = cur.get("weather_code").and_then(|c| c.as_i64()).unwrap_or(-1);
    let sunrise = daily
        .get("sunrise")
        .and_then(|a| a.as_array())
        .and_then(|a| a.first())
        .and_then(|s| s.as_str())
        .unwrap_or("");
    let sunset = daily
        .get("sunset")
        .and_then(|a| a.as_array())
        .and_then(|a| a.first())
        .and_then(|s| s.as_str())
        .unwrap_or("");
    let parse_h = |iso: &str| -> u32 {
        iso.split('T')
            .nth(1)
            .and_then(|t| t.get(0..2))
            .and_then(|h| h.parse().ok())
            .unwrap_or(6)
    };
    let now_h = chrono::Local::now().hour();
    let period = period_for(now_h, parse_h(sunrise), parse_h(sunset));
    let high = daily
        .get("temperature_2m_max")
        .and_then(|a| a.as_array())
        .and_then(|a| a.first())
        .and_then(|x| x.as_f64());
    let low = daily
        .get("temperature_2m_min")
        .and_then(|a| a.as_array())
        .and_then(|a| a.first())
        .and_then(|x| x.as_f64());
    let out = json!({
        "lat": lat,
        "lon": lon,
        "temp": cur.get("temperature_2m"),
        "humidity": cur.get("relative_humidity_2m"),
        "wind": cur.get("wind_speed_10m"),
        "code": code,
        "label": wmo_label(code),
        "is_day": cur.get("is_day").and_then(|v| v.as_i64()).unwrap_or(1) == 1,
        "high": high,
        "low": low,
        "sunrise": sunrise,
        "sunset": sunset,
        "period": period,
        "units": if units.eq_ignore_ascii_case("F") { "F" } else { "C" },
        "fetched_at": chrono::Local::now().timestamp_millis(),
    });
    *CACHE.lock() = Some(Cache {
        at: Instant::now(),
        data: out.clone(),
    });
    Ok(out)
}

pub fn clear_cache() {
    *CACHE.lock() = None;
}
