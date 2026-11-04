//! Generic network devices: tracked for reachability only.

use super::Driver;
use crate::hub::Hub;
use crate::model::{Cmd, Device};
use std::net::{SocketAddr, TcpStream};
use std::process::{Command, Stdio};
use std::time::Duration;

const PORTS: &[u16] = &[80, 443, 8009, 8008, 7000, 8080, 554, 22, 5000, 49152];

fn tcp_ok(ip: &str, port: u16) -> bool {
    let Ok(addr) = format!("{ip}:{port}").parse::<SocketAddr>() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(350)).is_ok()
}

fn ping_ok(ip: &str) -> bool {
    Command::new("ping")
        .args(["-c", "1", "-W", "900", ip])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn reachable(d: &Device) -> bool {
    if d.port != 0 && tcp_ok(&d.ip, d.port) {
        return true;
    }
    if PORTS.iter().any(|p| tcp_ok(&d.ip, *p)) {
        return true;
    }
    ping_ok(&d.ip)
}

pub struct NetDriver;

impl Driver for NetDriver {
    fn name(&self) -> &'static str {
        "net"
    }

    fn every(&self) -> u64 {
        4
    }

    fn poll(&self, hub: &Hub, devices: &[Device]) {
        std::thread::scope(|s| {
            for d in devices {
                s.spawn(move || {
                    if reachable(d) {
                        hub.report_ok(&d.id, |_| {});
                    } else {
                        hub.report_miss(&d.id);
                    }
                });
            }
        });
    }

    fn command(&self, _hub: &Hub, dev: &Device, _cmd: &Cmd) -> Result<(), String> {
        Err(format!(
            "{} is monitored only. Connect it through Home Assistant to control it.",
            dev.name
        ))
    }
}
