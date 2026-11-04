//! System Now Playing (Spotify, Chrome/YouTube, Music.app, …) plus Music.app AirPlay.
//!
//! Metadata/control use the mediaremote-adapter Perl bridge (works on macOS 15.4+).
//! AirPlay multi-room still goes through Music.app AppleScript.

use media_remote::prelude::*;
use serde_json::{json, Value};
use std::process::Command;
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

static SYSTEM: OnceLock<NowPlayingPerl> = OnceLock::new();
static READY_AT: OnceLock<Instant> = OnceLock::new();

fn system() -> &'static NowPlayingPerl {
    SYSTEM.get_or_init(|| {
        let np = NowPlayingPerl::new();
        READY_AT.get_or_init(|| Instant::now() + Duration::from_millis(700));
        np
    })
}

fn wait_ready() {
    let _ = system();
    if let Some(until) = READY_AT.get() {
        let now = Instant::now();
        if now < *until {
            thread::sleep(*until - now);
        }
    }
}

fn app_label(bundle_id: Option<&str>, bundle_name: Option<&str>) -> String {
    if let Some(name) = bundle_name {
        let clean = name.trim_end_matches(".app");
        if !clean.is_empty() {
            return clean.to_string();
        }
    }
    match bundle_id.unwrap_or("") {
        "com.spotify.client" => "Spotify".into(),
        "com.apple.Music" => "Music".into(),
        "com.google.Chrome" => "Chrome".into(),
        "com.apple.Safari" => "Safari".into(),
        "company.thebrowser.Browser" | "com.brave.Browser" => "Browser".into(),
        "com.apple.TV" => "TV".into(),
        "com.apple.FaceTime" | "com.apple.InCallService" => "FaceTime".into(),
        "net.whatsapp.WhatsApp" | "com.whatsapp.WhatsApp" => "WhatsApp".into(),
        "com.tinyspeck.slackmacgap" => "Slack".into(),
        "us.zoom.xos" => "Zoom".into(),
        other if !other.is_empty() => other
            .rsplit('.')
            .next()
            .unwrap_or(other)
            .to_string(),
        _ => "Mac".into(),
    }
}

fn is_call_bundle(bundle_id: &str) -> bool {
    matches!(
        bundle_id,
        "com.apple.FaceTime"
            | "com.apple.InCallService"
            | "net.whatsapp.WhatsApp"
            | "com.whatsapp.WhatsApp"
            | "us.zoom.xos"
            | "com.tinyspeck.slackmacgap"
            | "com.microsoft.teams2"
            | "com.microsoft.teams"
    ) || bundle_id.to_lowercase().contains("facetime")
        || bundle_id.to_lowercase().contains("whatsapp")
}

/// FaceTime / WhatsApp often don't publish rich Now Playing — detect via windows / frontmost app.
/// Uses CoreGraphics (no Accessibility prompt) via JXA.
fn detect_live_call() -> Option<Value> {
    let script = r#"
ObjC.import('CoreGraphics');
ObjC.import('AppKit');
function hit(provider, app, title, bundle) {
  return provider + '|' + app + '|' + title + '|' + bundle;
}
const apps = $.NSWorkspace.sharedWorkspace.runningApplications.js;
let frontFaceTime = false;
let whatsappRunning = false;
let zoomRunning = false;
for (const a of apps) {
  const bid = a.bundleIdentifier ? a.bundleIdentifier.js : '';
  const name = a.localizedName ? a.localizedName.js : '';
  if (bid === 'com.apple.FaceTime' && a.isActive) frontFaceTime = true;
  if (/whatsapp/i.test(bid + name)) whatsappRunning = true;
  if (/zoom/i.test(bid + name)) zoomRunning = true;
}
const opts = $.kCGWindowListOptionOnScreenOnly;
const info = $.CGWindowListCopyWindowInfo(opts, $.kCGNullWindowID);
const n = info.count;
let faceWin = false, waWin = '', zoomWin = false;
for (let i = 0; i < n; i++) {
  const w = info.objectAtIndex(i);
  const owner = w.objectForKey('kCGWindowOwnerName');
  const o = owner ? owner.js : '';
  const nameObj = w.objectForKey('kCGWindowName');
  const nm = nameObj ? nameObj.js : '';
  if (o === 'FaceTime') faceWin = true;
  if (o === 'WhatsApp' && (/call|voice|video/i.test(nm) || nm === '')) waWin = nm || 'WhatsApp call';
  if (o === 'zoom.us' || o === 'Zoom') zoomWin = true;
}
if (faceWin || frontFaceTime) return hit('facetime', 'FaceTime', 'FaceTime call', 'com.apple.FaceTime');
if (waWin) return hit('whatsapp', 'WhatsApp', waWin, 'net.whatsapp.WhatsApp');
if (zoomWin && zoomRunning) return hit('zoom', 'Zoom', 'Zoom meeting', 'us.zoom.xos');
''
"#;
    let raw = Command::new("osascript")
        .args(["-l", "JavaScript", "-e", script])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        })?;
    if raw.is_empty() {
        return None;
    }
    let parts: Vec<&str> = raw.splitn(4, '|').collect();
    let app_id = parts.first().copied().unwrap_or("call");
    let app = parts.get(1).copied().unwrap_or("Call");
    let title = parts.get(2).copied().unwrap_or("In a call");
    let bundle = parts.get(3).copied().unwrap_or("");
    Some(json!({
        "available": true,
        "playing": true,
        "state": "playing",
        "title": title,
        "artist": "In progress",
        "album": "",
        "volume": 0.5,
        "source": "system",
        "app": app,
        "bundle_id": bundle,
        "kind": "call",
        "provider": app_id,
    }))
}

fn from_system() -> Option<Value> {
    wait_ready();
    {
        let guard = system().get_info();
        if let Some(info) = guard.as_ref() {
            let mut title = info.title.clone().unwrap_or_default();
            let playing = info.is_playing.unwrap_or(false);
            let bundle_id = info.bundle_id.clone().unwrap_or_default();
            let callish = is_call_bundle(&bundle_id);
            if title.is_empty() && callish {
                title = if bundle_id.to_lowercase().contains("facetime") {
                    "FaceTime call".into()
                } else {
                    format!(
                        "{} call",
                        app_label(Some(&bundle_id), info.bundle_name.as_deref())
                    )
                };
            }
            if !title.is_empty() || playing || callish {
                let artist = info.artist.clone().unwrap_or_default();
                let album = info.album.clone().unwrap_or_default();
                let app = app_label(info.bundle_id.as_deref(), info.bundle_name.as_deref());
                let artist_out = if artist.is_empty() && callish {
                    "In progress".to_string()
                } else {
                    artist
                };
                return Some(json!({
                    "available": true,
                    "playing": playing || callish,
                    "state": if playing || callish { "playing" } else { "paused" },
                    "title": title,
                    "artist": artist_out,
                    "album": album,
                    "volume": app_volume(&bundle_id).unwrap_or(0.5),
                    "source": "system",
                    "app": app,
                    "bundle_id": bundle_id,
                    "kind": if callish { "call" } else { "media" },
                    "elapsed": info.elapsed_time,
                    "duration": info.duration,
                }));
            }
        }
    }
    detect_live_call()
}

fn osascript(script: &str) -> Result<String, String> {
    let out = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("osascript: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(if err.trim().is_empty() {
            "AppleScript failed".into()
        } else {
            err.trim().to_string()
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn app_volume(bundle_id: &str) -> Option<f64> {
    let script = match bundle_id {
        "com.spotify.client" => {
            r#"tell application "Spotify" to return sound volume as text"#
        }
        "com.apple.Music" => r#"tell application "Music" to return sound volume as text"#,
        _ => return None,
    };
    osascript(script)
        .ok()
        .and_then(|s| s.parse::<f64>().ok())
        .map(|v| (v / 100.0).clamp(0.0, 1.0))
}

fn music_app_fallback() -> Result<Value, String> {
    let script = r#"
tell application "System Events"
  if not (exists process "Music") then return "OFF||||0|0"
end tell
tell application "Music"
  if player state is stopped then return "stopped||||0|" & (sound volume as text)
  set t to ""
  set a to ""
  set al to ""
  try
    set t to name of current track
    set a to artist of current track
    set al to album of current track
  end try
  set st to (player state as text)
  set vol to sound volume
  return st & "|" & t & "|" & a & "|" & al & "|" & vol & "|"
end tell
"#;
    let raw = osascript(script)?;
    if raw == "OFF||||0|0" {
        return Ok(json!({
            "available": false,
            "playing": false,
            "state": "off",
            "title": "",
            "artist": "",
            "album": "",
            "volume": 0.0,
            "source": "music",
            "app": "Music",
        }));
    }
    let parts: Vec<&str> = raw.splitn(6, '|').collect();
    let state = parts.first().copied().unwrap_or("stopped");
    let title = parts.get(1).copied().unwrap_or("");
    let artist = parts.get(2).copied().unwrap_or("");
    let album = parts.get(3).copied().unwrap_or("");
    let vol: f64 = parts
        .get(4)
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0)
        / 100.0;
    Ok(json!({
        "available": true,
        "playing": state == "playing",
        "state": state,
        "title": title,
        "artist": artist,
        "album": album,
        "volume": vol,
        "source": "music",
        "app": "Music",
        "bundle_id": "com.apple.Music",
    }))
}

pub fn now_playing() -> Result<Value, String> {
    // Prefer an active FaceTime / WhatsApp / Zoom call over paused music.
    if let Some(call) = detect_live_call() {
        return Ok(call);
    }
    if let Some(v) = from_system() {
        return Ok(v);
    }
    music_app_fallback()
}

pub fn airplay_list() -> Result<Value, String> {
    let script = r#"
tell application "Music"
  set out to {}
  repeat with d in AirPlay devices
    set end of out to (name of d) & tab & (selected of d as text) & tab & (kind of d as text)
  end repeat
  set AppleScript's text item delimiters to linefeed
  return out as text
end tell
"#;
    let raw = match osascript(script) {
        Ok(s) => s,
        Err(_) => return Ok(json!([])),
    };
    let mut list = Vec::new();
    for line in raw.lines() {
        let p: Vec<&str> = line.split('\t').collect();
        if p.is_empty() || p[0].is_empty() {
            continue;
        }
        list.push(json!({
            "name": p[0],
            "selected": p.get(1).map(|s| *s == "true").unwrap_or(false),
            "kind": p.get(2).copied().unwrap_or(""),
        }));
    }
    Ok(Value::Array(list))
}

pub fn airplay_set(names: &[String]) -> Result<Value, String> {
    if names.is_empty() {
        let script = r#"
tell application "Music"
  set computerDevice to first AirPlay device whose kind is computer
  set current AirPlay devices to {computerDevice}
end tell
"#;
        osascript(script)?;
        return Ok(json!({"ok": true, "names": []}));
    }
    let list = names
        .iter()
        .map(|n| format!("AirPlay device \"{}\"", n.replace('"', "")))
        .collect::<Vec<_>>()
        .join(", ");
    let script = format!(
        r#"
tell application "Music"
  set current AirPlay devices to {{{list}}}
end tell
"#
    );
    osascript(&script)?;
    Ok(json!({"ok": true, "names": names}))
}

pub fn transport(action: &str) -> Result<Value, String> {
    wait_ready();
    let np = system();
    let ok = match action {
        "play" => np.play(),
        "pause" => np.pause(),
        "playpause" => np.toggle(),
        "next" => np.next(),
        "prev" | "previous" => np.previous(),
        "stop" => np.pause(),
        _ => return Err(format!("Unknown music action {action}")),
    };
    if !ok {
        // Fall back to Music.app for older sessions
        let cmd = match action {
            "play" => "play",
            "pause" | "stop" => "pause",
            "playpause" => "playpause",
            "next" => "next track",
            "prev" | "previous" => "previous track",
            _ => return Err(format!("Unknown music action {action}")),
        };
        let _ = osascript(&format!("tell application \"Music\" to {cmd}"));
    }
    thread::sleep(Duration::from_millis(250));
    now_playing()
}

pub fn set_volume(level: f64) -> Result<Value, String> {
    let pct = (level.clamp(0.0, 1.0) * 100.0).round() as i32;
    let bundle = from_system()
        .and_then(|v| v.get("bundle_id").and_then(|b| b.as_str()).map(|s| s.to_string()))
        .unwrap_or_default();
    match bundle.as_str() {
        "com.spotify.client" => {
            osascript(&format!(
                "tell application \"Spotify\" to set sound volume to {pct}"
            ))?;
        }
        "com.apple.Music" | "" => {
            osascript(&format!(
                "tell application \"Music\" to set sound volume to {pct}"
            ))?;
        }
        _ => {
            // Browsers / others: nudge system output volume
            osascript(&format!("set volume output volume {pct}"))?;
        }
    }
    thread::sleep(Duration::from_millis(120));
    now_playing()
}
