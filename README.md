# Lights Studio

A home hub for your lights, plugs and more. Native Mac app (Tauri 2 + Rust) with an embedded web server, so the same UI also runs on a wall tablet or phone on your Wi-Fi.

## What it does

- **Devices**: WiZ lights and plugs are found and added automatically (local UDP, no cloud). Anything else on the network (Chromecast, AirPlay, HomeKit, UPnP, printers) shows up under *Add device > Scan network*. Add anything by IP, or connect **Home Assistant** to control Hue, Zigbee, Matter, TVs, thermostats and more.
- **Stable state**: devices are marked offline only after three missed polls, last known state is kept, commands apply instantly and are reconciled on the next poll. No more flicker.
- **Home dashboard**: weather hero, **Now Playing**, at-a-glance stats, an auto-generated **floor plan**, **climate dials**, and a live **activity feed**.
- **Music / multi-room**: Chromecast speakers on the LAN, Home Assistant media players, and AirPlay multi-room via Music.app on the Mac. Pick outputs from Home or the Music page.
- **Auto theme**: follows local sunrise/sunset (or Dark / Light).
- **Command palette**: ⌘K (or `/`) to jump to a page, toggle any device or apply a scene.
- **Rooms**, drag and drop (mouse and touch) to reorder devices or move them between rooms.
- **Scenes** (Relax, Focus, Movie, Night, All off, plus your own), **Automations** (time, weekdays, scene / on / off / gentle wake-up / effect).
- **Energy**: live watts, daily and hourly history, cost per device.
- **Light Studio**: ordered animations (chase, bounce, wave, rainbow, breathe, candle, party, sunrise) with distance fade, trail, spread and speed.
- **Screen mode**: full-screen dashboard with big clock, optional idle dim. In the app press ⇧⌘F; in a browser open `http://<mac-ip>:8765/?kiosk`.

## Wall screen / tablet

1. Open Settings, turn on *Wall screen & other devices* (optionally set a PIN).
2. Open the shown address on the tablet. Add it to the home screen for a full-screen app.

## Build

```bash
npm install
npm run build        # DMG in src-tauri/target/release/bundle/dmg
npm run dev          # run with hot reload of src/
```

## Test

```bash
cd src-tauri
cargo test                                   # unit tests + fake WiZ end-to-end test
cargo run --bin fakewiz -- --drop 0.3        # 4 fake bulbs + 1 plug on 127.0.0.1:39001+, 30 % packet loss
HUB_NO_SCAN=1 HUB_STATIC_DIR=../src cargo run --bin hubd -- --port 8799
# then add the fakes: POST /api/call/device_add_ip {"ip":"127.0.0.1","port":39001}
```

`hubd` is the same hub without a window, handy for a home server.

## Data

`~/Library/Application Support/com.airodragon.lights-studio/`: `devices.json`, `config.json` (rooms, scenes, automations, settings), `energy.json`. The previous format is migrated automatically and backed up as `devices.v1.bak`.
