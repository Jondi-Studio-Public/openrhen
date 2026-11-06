//! The pure core: turns raw signals into store operations. No clock, no OS, no database, so every rule
//! here is tested on any machine.
//!
//! Rules it enforces:
//! * an interval is never run on past what was observed: a stall (sleep, a hung machine, a stopped
//!   process) closes everything at the last tick and records the gap as `unknown`;
//! * repeats of the same executable do not split an interval; shell windows do not end one;
//! * while a denylisted game is in front nothing is recorded about it but the fact of suppression;
//! * lock and suspend close the foreground interval and ask the runner to look again afterwards.

use std::collections::HashSet;

use serde_json::{Value, json};

use crate::categories::{Catalogue, is_shell_class};
use crate::model::{Ms, Op, SRC_AGENT, SRC_FOREGROUND, SRC_IDLE, SRC_POWER, SRC_SESSION, attrs};

/// A foreground window as the OS layer resolved it.
#[derive(Debug, Clone, PartialEq)]
pub struct Fg {
    pub class: String,
    /// Lower-cased executable file name; `None` when the OS refused the lookup.
    pub exe: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SessionEvt {
    Lock,
    Unlock,
    Logon,
    Logoff,
    RemoteConnect,
    RemoteDisconnect,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PowerEvt {
    Suspend,
    Resume,
    DisplayOn,
    DisplayOff,
    Ac,
    Battery,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Signal {
    Foreground(Fg),
    /// Milliseconds since the last keyboard or mouse input, as sampled now.
    Idle(u64),
    Session(SessionEvt),
    Power(PowerEvt),
    /// A periodic wake with nothing to report; detects stalls and clock jumps.
    Tick,
}

#[derive(Debug, Clone)]
pub struct Settings {
    pub idle_threshold_ms: u64,
    pub foreground: bool,
    pub idle: bool,
    pub session: bool,
    pub power: bool,
    /// A gap between ticks longer than this is a stall, not a quiet period.
    pub stall_ms: i64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            idle_threshold_ms: 120_000,
            foreground: true,
            idle: true,
            session: true,
            power: true,
            stall_ms: 30_000,
        }
    }
}

#[derive(Debug, Default)]
pub struct Step {
    pub ops: Vec<Op>,
    /// The runner should look up the current foreground window and send it back as a `Signal::Foreground`.
    pub refresh_foreground: bool,
}

#[derive(Debug, Clone)]
struct OpenFg {
    id: String,
    exe: Option<String>,
    suppressed: bool,
}

pub struct Engine {
    settings: Settings,
    catalogue: Catalogue,
    next_id: Box<dyn FnMut() -> String + Send>,
    last_tick: Option<Ms>,
    fg: Option<OpenFg>,
    idle: Option<String>,
    /// Nothing before this instant is known (agent start, end of a stall, end of a lock); idle never backdates past it.
    floor: Ms,
    locked: Option<String>,
    suspended: Option<String>,
    display_off: Option<String>,
    remote: Option<String>,
    /// Lock and suspend each hold the foreground closed; both must clear before it reopens.
    holds: HashSet<&'static str>,
}

impl Engine {
    pub fn new(settings: Settings, catalogue: Catalogue, next_id: Box<dyn FnMut() -> String + Send>) -> Self {
        Self {
            settings,
            catalogue,
            next_id,
            last_tick: None,
            fg: None,
            idle: None,
            floor: Ms::MIN,
            locked: None,
            suspended: None,
            display_off: None,
            remote: None,
            holds: HashSet::new(),
        }
    }

    /// True while a denylisted game is in front: the runner must skip every optional probe.
    pub fn suppressed(&self) -> bool {
        self.fg.as_ref().is_some_and(|f| f.suppressed)
    }

    pub fn step(&mut self, now: Ms, signal: Signal) -> Step {
        let mut out = Step::default();
        if self.last_tick.is_none() {
            self.floor = now;
        }
        self.check_stall(now, &mut out);
        match signal {
            Signal::Tick => {}
            Signal::Foreground(fg) => self.on_foreground(now, fg, &mut out),
            Signal::Idle(idle_ms) => self.on_idle(now, idle_ms, &mut out),
            Signal::Session(evt) => self.on_session(now, evt, &mut out),
            Signal::Power(evt) => self.on_power(now, evt, &mut out),
        }
        self.last_tick = Some(now);
        out
    }

    /// Close every open interval at `now` (a clean shutdown).
    pub fn finish(&mut self, now: Ms) -> Vec<Op> {
        let mut ops = Vec::new();
        self.close_all(now, &mut ops);
        ops
    }

    fn check_stall(&mut self, now: Ms, out: &mut Step) {
        let Some(last) = self.last_tick else { return };
        let gap = now - last;
        if gap > self.settings.stall_ms {
            // Sleep, hibernate or a frozen machine: what happened in between is not known.
            self.close_all(last, &mut out.ops);
            out.ops.push(Op::Instant {
                source: SRC_AGENT,
                kind: "unknown".into(),
                ts: last,
                end: Some(now),
                attrs: attrs([("reason", json!("stall"))]),
            });
            self.holds.clear();
            self.floor = now;
            out.refresh_foreground = true;
        } else if gap < -2_000 {
            // The wall clock moved backwards. Close at the old time and start again; do not invent time.
            self.close_all(last.min(now), &mut out.ops);
            out.ops.push(Op::Instant {
                source: SRC_AGENT,
                kind: "clock_jump".into(),
                ts: now,
                end: None,
                attrs: attrs([("delta_ms", json!(gap))]),
            });
            self.holds.clear();
            self.floor = now;
            out.refresh_foreground = true;
        }
    }

    fn close_all(&mut self, at: Ms, ops: &mut Vec<Op>) {
        if let Some(fg) = self.fg.take() {
            ops.push(Op::Close { id: fg.id, ts: at });
        }
        for slot in [
            &mut self.idle,
            &mut self.locked,
            &mut self.suspended,
            &mut self.display_off,
            &mut self.remote,
        ] {
            if let Some(id) = slot.take() {
                ops.push(Op::Close { id, ts: at });
            }
        }
    }

    fn open(&mut self, source: &'static str, kind: &str, ts: Ms, a: serde_json::Map<String, Value>, ops: &mut Vec<Op>) -> String {
        let id = (self.next_id)();
        ops.push(Op::Open {
            id: id.clone(),
            source,
            kind: kind.into(),
            ts,
            attrs: a,
        });
        id
    }

    fn on_foreground(&mut self, now: Ms, fg: Fg, out: &mut Step) {
        if !self.settings.foreground {
            return;
        }
        if !self.holds.is_empty() {
            // Locked or suspended: the interval reopens when the hold clears.
            return;
        }
        if is_shell_class(&fg.class) {
            return;
        }
        let suppressed = fg.exe.as_deref().is_some_and(|e| self.catalogue.is_game(e));
        if let Some(open) = &self.fg {
            // The same app again, or the same unreadable window again, changes nothing.
            if open.exe == fg.exe && open.suppressed == suppressed {
                return;
            }
        }
        if let Some(prev) = self.fg.take() {
            out.ops.push(Op::Close { id: prev.id, ts: now });
        }
        let id = if suppressed {
            // Nothing about the game is written, not even its name.
            self.open(
                SRC_FOREGROUND,
                "suppressed",
                now,
                attrs([("reason", json!("denylist"))]),
                &mut out.ops,
            )
        } else if let Some(exe) = &fg.exe {
            let category = self.catalogue.category(exe).to_string();
            self.open(
                SRC_FOREGROUND,
                "app",
                now,
                attrs([("exe", json!(exe)), ("category", json!(category))]),
                &mut out.ops,
            )
        } else {
            self.open(
                SRC_FOREGROUND,
                "unknown",
                now,
                attrs([("reason", json!("exe lookup refused"))]),
                &mut out.ops,
            )
        };
        self.fg = Some(OpenFg {
            id,
            exe: fg.exe,
            suppressed,
        });
    }

    fn on_idle(&mut self, now: Ms, idle_ms: u64, out: &mut Step) {
        if !self.settings.idle || self.suppressed() || !self.holds.is_empty() {
            return;
        }
        let idle = idle_ms as i64;
        if idle_ms >= self.settings.idle_threshold_ms {
            if self.idle.is_none() {
                // Idleness began when the last input happened, not when the threshold was noticed.
                let started = (now - idle).max(self.floor);
                let id = self.open(SRC_IDLE, "idle", started, Default::default(), &mut out.ops);
                self.idle = Some(id);
            }
        } else if let Some(id) = self.idle.take() {
            let ended = (now - idle).max(0);
            out.ops.push(Op::Close { id, ts: ended });
        }
    }

    fn on_session(&mut self, now: Ms, evt: SessionEvt, out: &mut Step) {
        if !self.settings.session {
            return;
        }
        match evt {
            SessionEvt::Lock => {
                if self.locked.is_none() {
                    let id = self.open(SRC_SESSION, "locked", now, Default::default(), &mut out.ops);
                    self.locked = Some(id);
                }
                self.hold("lock", now, out);
            }
            SessionEvt::Unlock => {
                if let Some(id) = self.locked.take() {
                    out.ops.push(Op::Close { id, ts: now });
                }
                self.release("lock", now, out);
            }
            SessionEvt::RemoteConnect => {
                if self.remote.is_none() {
                    let id = self.open(SRC_SESSION, "remote", now, Default::default(), &mut out.ops);
                    self.remote = Some(id);
                }
            }
            SessionEvt::RemoteDisconnect => {
                if let Some(id) = self.remote.take() {
                    out.ops.push(Op::Close { id, ts: now });
                }
            }
            SessionEvt::Logon => self.instant(SRC_SESSION, "logon", now, out),
            SessionEvt::Logoff => self.instant(SRC_SESSION, "logoff", now, out),
        }
    }

    fn on_power(&mut self, now: Ms, evt: PowerEvt, out: &mut Step) {
        if !self.settings.power {
            return;
        }
        match evt {
            PowerEvt::Suspend => {
                if self.suspended.is_none() {
                    let id = self.open(SRC_POWER, "suspended", now, Default::default(), &mut out.ops);
                    self.suspended = Some(id);
                }
                self.hold("suspend", now, out);
            }
            PowerEvt::Resume => {
                if let Some(id) = self.suspended.take() {
                    out.ops.push(Op::Close { id, ts: now });
                }
                self.release("suspend", now, out);
            }
            PowerEvt::DisplayOff => {
                if self.display_off.is_none() {
                    let id = self.open(SRC_POWER, "display_off", now, Default::default(), &mut out.ops);
                    self.display_off = Some(id);
                }
            }
            PowerEvt::DisplayOn => {
                if let Some(id) = self.display_off.take() {
                    out.ops.push(Op::Close { id, ts: now });
                }
            }
            PowerEvt::Ac => self.instant(SRC_POWER, "ac", now, out),
            PowerEvt::Battery => self.instant(SRC_POWER, "battery", now, out),
        }
    }

    fn instant(&mut self, source: &'static str, kind: &str, ts: Ms, out: &mut Step) {
        out.ops.push(Op::Instant {
            source,
            kind: kind.into(),
            ts,
            end: None,
            attrs: Default::default(),
        });
    }

    fn hold(&mut self, reason: &'static str, now: Ms, out: &mut Step) {
        self.holds.insert(reason);
        if let Some(fg) = self.fg.take() {
            out.ops.push(Op::Close { id: fg.id, ts: now });
        }
        if let Some(id) = self.idle.take() {
            out.ops.push(Op::Close { id, ts: now });
        }
    }

    fn release(&mut self, reason: &'static str, now: Ms, out: &mut Step) {
        self.holds.remove(reason);
        if self.holds.is_empty() {
            self.floor = self.floor.max(now);
            // Whatever was in front when the hold began may be gone; ask the OS rather than guess.
            out.refresh_foreground = true;
        }
    }
}
