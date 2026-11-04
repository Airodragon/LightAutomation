//! Built-in scenes, WiZ dynamic scenes and software effects catalogue.

use crate::model::{Config, Scene, SceneState};

pub const WIZ_SCENES: &[(u32, &str)] = &[
    (1, "Ocean"),
    (2, "Romance"),
    (3, "Sunset"),
    (4, "Party"),
    (5, "Fireplace"),
    (6, "Cozy"),
    (7, "Forest"),
    (8, "Pastel colors"),
    (9, "Wake up"),
    (10, "Bedtime"),
    (11, "Warm white"),
    (12, "Daylight"),
    (13, "Cool white"),
    (14, "Night light"),
    (15, "Focus"),
    (16, "Relax"),
    (17, "True colors"),
    (18, "TV time"),
    (19, "Plantgrowth"),
    (20, "Spring"),
    (21, "Summer"),
    (22, "Fall"),
    (23, "Deep dive"),
    (24, "Jungle"),
    (25, "Mojito"),
    (26, "Club"),
    (27, "Christmas"),
    (28, "Halloween"),
    (29, "Candlelight"),
    (30, "Golden white"),
    (31, "Pulse"),
    (32, "Steampunk"),
];

pub const EFFECTS: &[(&str, &str, &str)] = &[
    ("solid", "Solid", "One steady look across every light"),
    ("chase", "Chase", "A pulse of light runs through the ordered lights"),
    ("bounce", "Bounce", "The pulse runs to the end and back"),
    ("wave", "Wave", "A smooth sine wave of brightness"),
    ("rainbow", "Rainbow", "Colours drift across the room"),
    ("breathe", "Breathe", "All lights slowly fade in and out"),
    ("candle", "Candle", "Warm flicker, each light on its own"),
    ("party", "Party", "Random bright colours"),
    ("sunrise", "Sunrise", "A slow five minute wake-up ramp"),
];

fn st(on: bool, b: u8, temp: u32) -> SceneState {
    SceneState {
        on: Some(on),
        brightness: Some(b),
        rgb: None,
        temp: Some(temp),
    }
}

pub fn builtin() -> Vec<Scene> {
    let mk = |id: &str, name: &str, icon: &str, g: Option<SceneState>, off: bool| Scene {
        id: id.into(),
        name: name.into(),
        icon: icon.into(),
        builtin: true,
        global: g,
        all_off: off,
        items: vec![],
    };
    vec![
        mk("builtin-relax", "Relax", "sofa", Some(st(true, 55, 2700)), false),
        mk("builtin-focus", "Focus", "target", Some(st(true, 100, 5000)), false),
        mk("builtin-movie", "Movie", "film", Some(st(true, 20, 2200)), false),
        mk("builtin-night", "Night", "moon", Some(st(true, 10, 2200)), false),
        mk("builtin-alloff", "All off", "power", None, true),
    ]
}

/// Make sure every built-in scene exists (user scenes are kept untouched).
pub fn ensure_builtin(cfg: &mut Config) {
    for b in builtin() {
        match cfg.scenes.iter_mut().find(|s| s.id == b.id) {
            Some(existing) => {
                // keep user renames, refresh behaviour
                existing.builtin = true;
                existing.global = b.global.clone();
                existing.all_off = b.all_off;
                if existing.icon.is_empty() {
                    existing.icon = b.icon.clone();
                }
            }
            None => cfg.scenes.push(b),
        }
    }
}
