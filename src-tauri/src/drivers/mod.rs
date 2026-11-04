//! Device drivers. Each driver knows how to poll and control one family of devices.

pub mod cast;
pub mod ha;
pub mod net;
pub mod wiz;

use crate::hub::Hub;
use crate::model::{Cmd, Device};

pub trait Driver: Send + Sync {
    fn name(&self) -> &'static str;
    /// How many poller ticks (about 2.5 s each) between polls.
    fn every(&self) -> u64 {
        1
    }
    /// Poll every device of this driver and report results through the hub.
    fn poll(&self, hub: &Hub, devices: &[Device]);
    /// Send a command to one device.
    fn command(&self, hub: &Hub, dev: &Device, cmd: &Cmd) -> Result<(), String>;
}

pub fn all() -> Vec<Box<dyn Driver>> {
    vec![
        Box::new(wiz::WizDriver),
        Box::new(ha::HaDriver),
        Box::new(cast::CastDriver::default()),
        Box::new(net::NetDriver),
    ]
}
