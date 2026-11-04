//! Headless hub for testing and for running on a home server: `hubd [--dir DIR] [--port 8765] [--pin 1234]`.

use lights_studio_lib::hub::Hub;
use lights_studio_lib::web;
use std::path::PathBuf;

fn main() {
    let mut dir = std::env::temp_dir().join("lights-studio-hubd");
    let mut port: u16 = 8765;
    let mut pin = String::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--dir" => dir = PathBuf::from(args.next().unwrap_or_default()),
            "--port" => port = args.next().and_then(|p| p.parse().ok()).unwrap_or(8765),
            "--pin" => pin = args.next().unwrap_or_default(),
            _ => {}
        }
    }
    let hub = Hub::new(&dir);
    {
        let mut c = hub.config.lock();
        c.settings.web_enabled = true;
        c.settings.web_port = port;
        c.settings.web_pin = pin;
    }
    hub.start();
    web::apply(&hub);
    if let Some(e) = web::status(&hub)["error"].as_str() {
        eprintln!("hubd: {e}");
        std::process::exit(1);
    }
    println!("hubd listening on http://0.0.0.0:{port} (data: {})", dir.display());
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}
