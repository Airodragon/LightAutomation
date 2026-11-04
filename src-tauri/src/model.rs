//! Core data model shared by the hub, drivers and the UI.

use crate::effects::EffectParams;
use serde::{Deserialize, Serialize};
use std::time::Instant;

/// A device the hub knows about (persisted).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Device {
    /// Unique id: "wiz:<mac>", "ha:<entity_id>", "net:<mac or ip>".
    pub id: String,
    /// Driver name: "wiz" | "ha" | "net" | "cast".
    pub driver: String,
    /// light | plug | switch | sensor | climate | media | cover | other
    pub kind: String,
    pub name: String,
    pub ip: String,
    /// 0 = driver default.
    pub port: u16,
    pub mac: String,
    pub module: Option<String>,
    pub fw: Option<String>,
    pub room: String,
    pub order: i32,
    pub favorite: bool,
    pub note: String,
    /// onoff, dim, color, temp, scene, power, value, target
    pub caps: Vec<String>,
    pub ha_entity: Option<String>,
    pub power_supported: bool,
    pub energy_wh_lifetime: f64,
    pub energy_wh_session: f64,
    pub home_id: Option<u64>,
    pub room_id: Option<u64>,
}

impl Default for Device {
    fn default() -> Self {
        Self {
            id: String::new(),
            driver: "wiz".into(),
            kind: "light".into(),
            name: "Device".into(),
            ip: String::new(),
            port: 0,
            mac: String::new(),
            module: None,
            fw: None,
            room: "Living Room".into(),
            order: 999,
            favorite: false,
            note: String::new(),
            caps: vec!["onoff".into()],
            ha_entity: None,
            power_supported: false,
            energy_wh_lifetime: 0.0,
            energy_wh_session: 0.0,
            home_id: None,
            room_id: None,
        }
    }
}

impl Device {
    pub fn has_cap(&self, c: &str) -> bool {
        self.caps.iter().any(|x| x == c)
    }
}

/// Last known live state of a device (not persisted).
#[derive(Clone, Debug, Serialize, Default)]
pub struct Live {
    pub on: Option<bool>,
    pub brightness: Option<u8>,
    pub rgb: Option<[u8; 3]>,
    pub temp: Option<u32>,
    pub scene_id: Option<u32>,
    pub watts: Option<f64>,
    pub rssi: Option<i64>,
    /// Free text value (sensor reading, climate mode, media state).
    pub value: Option<String>,
    pub unit: Option<String>,
    pub current: Option<f64>,
    pub target: Option<f64>,
    /// 0.0..=1.0 for media / speakers.
    pub volume: Option<f64>,
    pub media_title: Option<String>,
    pub media_artist: Option<String>,
    pub media_image: Option<String>,
    pub media_app: Option<String>,
    pub online: bool,
    /// True once the device has answered at least once.
    pub seen: bool,
    #[serde(skip)]
    pub misses: u32,
    /// While in the future, poll results must not overwrite on/brightness/color.
    #[serde(skip)]
    pub hold_until: Option<Instant>,
}

impl Live {
    /// Equality over the fields the UI cares about.
    pub fn same(&self, o: &Live) -> bool {
        self.on == o.on
            && self.brightness == o.brightness
            && self.rgb == o.rgb
            && self.temp == o.temp
            && self.scene_id == o.scene_id
            && self.watts == o.watts
            && self.rssi == o.rssi
            && self.value == o.value
            && self.unit == o.unit
            && self.current == o.current
            && self.target == o.target
            && self.volume == o.volume
            && self.media_title == o.media_title
            && self.media_artist == o.media_artist
            && self.media_image == o.media_image
            && self.media_app == o.media_app
            && self.online == o.online
            && self.seen == o.seen
    }

    pub fn held(&self) -> bool {
        self.hold_until.map(|t| t > Instant::now()).unwrap_or(false)
    }
}

/// A command sent to a device.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct Cmd {
    pub on: Option<bool>,
    pub brightness: Option<u8>,
    /// Hex colour like "#ff8800".
    pub color: Option<String>,
    pub rgb: Option<[u8; 3]>,
    pub temp: Option<u32>,
    pub scene_id: Option<u32>,
    pub target: Option<f64>,
    /// 0.0..=1.0
    pub volume: Option<f64>,
    /// play | pause | stop | next | prev
    pub media: Option<String>,
    /// Chromecast / URL load
    pub play_uri: Option<String>,
}

impl Cmd {
    pub fn rgb_value(&self) -> Option<[u8; 3]> {
        if let Some(c) = self.rgb {
            return Some(c);
        }
        let hex = self.color.as_deref()?.trim_start_matches('#');
        if hex.len() < 6 {
            return None;
        }
        let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
        let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
        let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
        Some([r, g, b])
    }

    pub fn is_empty(&self) -> bool {
        self.on.is_none()
            && self.brightness.is_none()
            && self.rgb_value().is_none()
            && self.temp.is_none()
            && self.scene_id.is_none()
            && self.target.is_none()
            && self.volume.is_none()
            && self.media.is_none()
            && self.play_uri.is_none()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub web_enabled: bool,
    pub web_port: u16,
    pub web_pin: String,
    pub energy_rate: f64,
    pub currency: String,
    /// "auto" | "dark" | "light"
    pub theme: String,
    /// Show the ambient screensaver after idle in screen mode.
    pub idle_dim: bool,
    /// Seconds of idle before the screensaver (screen mode). Default 60.
    pub screensaver_secs: u32,
    pub ha_url: String,
    pub ha_token: String,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    /// "C" | "F"
    pub weather_units: String,
    /// Selected speaker / media device ids for multi-room output.
    pub cast_outputs: Vec<String>,
    /// home | away | night | guest
    pub presence_mode: String,
    /// Sticky notes / family board lines.
    pub board_notes: Vec<String>,
    /// Household contacts for Call Center.
    pub contacts: Vec<Contact>,
    /// Named wall screens enrolled with the hub.
    pub wall_clients: Vec<WallClient>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            web_enabled: false,
            web_port: 8765,
            web_pin: String::new(),
            energy_rate: 0.15,
            currency: "$".into(),
            theme: "auto".into(),
            idle_dim: true,
            screensaver_secs: 60,
            ha_url: String::new(),
            ha_token: String::new(),
            lat: None,
            lon: None,
            weather_units: "C".into(),
            cast_outputs: vec![],
            presence_mode: "home".into(),
            board_notes: vec![],
            contacts: vec![],
            wall_clients: vec![],
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Contact {
    pub id: String,
    pub name: String,
    pub favorite: bool,
    /// Preferred app: facetime | whatsapp | instagram | telegram | phone | messages | zoom | meet | home
    pub app: String,
    /// Phone, handle, email, or wa.me id depending on app.
    pub handle: String,
    pub note: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WallClient {
    pub id: String,
    pub name: String,
    pub room: String,
    pub last_seen: i64,
    pub has_cam: bool,
    pub has_mic: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SceneState {
    pub on: Option<bool>,
    pub brightness: Option<u8>,
    pub rgb: Option<[u8; 3]>,
    pub temp: Option<u32>,
}

impl SceneState {
    pub fn to_cmd(&self) -> Cmd {
        Cmd {
            on: self.on,
            brightness: self.brightness,
            rgb: self.rgb,
            temp: self.temp,
            ..Default::default()
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SceneItem {
    pub id: String,
    pub state: SceneState,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Scene {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub builtin: bool,
    /// Applied to every light when set (built-in scenes).
    pub global: Option<SceneState>,
    /// "all" turns everything off (the All off scene).
    pub all_off: bool,
    pub items: Vec<SceneItem>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Schedule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    /// "HH:MM" 24h local time (used when trigger = time).
    pub time: String,
    /// 0 = Monday .. 6 = Sunday. Empty = every day.
    pub days: Vec<u8>,
    /// scene | on | off | effect | wake | presence
    pub action: String,
    pub scene_id: String,
    /// all | lights | plugs | room:<name> | device:<id>
    pub target: String,
    pub effect: Option<EffectParams>,
    /// time | sunrise | sunset | presence | device
    pub trigger: String,
    /// When trigger=presence: home|away|night|guest
    pub presence_mode: String,
    /// When trigger=device: device id
    pub trigger_device: String,
    /// When trigger=device: on|off|online|offline|unlocked|locked|ringing
    pub trigger_state: String,
}

impl Default for Schedule {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "Schedule".into(),
            enabled: true,
            time: "07:00".into(),
            days: vec![],
            action: "on".into(),
            scene_id: String::new(),
            target: "lights".into(),
            effect: None,
            trigger: "time".into(),
            presence_mode: String::new(),
            trigger_device: String::new(),
            trigger_state: String::new(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub settings: Settings,
    pub rooms: Vec<String>,
    pub scenes: Vec<Scene>,
    pub schedules: Vec<Schedule>,
}

/// A device found on the network that has not been added yet.
#[derive(Clone, Debug, Serialize)]
pub struct Candidate {
    pub ip: String,
    pub mac: String,
    pub name: String,
    pub kind: String,
    pub hints: Vec<String>,
    pub port: u16,
}

pub fn new_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", n)
}
