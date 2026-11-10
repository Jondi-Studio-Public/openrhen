//! The macOS layer. Every signal here comes from a public API that needs no privacy permission: the front
//! app from NSWorkspace, idle time from CoreGraphics (a timestamp, never an event), lock and unlock from the
//! system's screen-lock notifications, sleep and wake from IOKit, AC or battery from IOKit power sources.
//! Nothing here opens another process, sends it anything, or reads its windows.
//!
//! AppKit needs the main thread, so the main thread runs the app (menu bar item, observers) and the agent
//! loop runs on its own thread, fed through the same channel the Windows layer uses.

use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicI8, AtomicI32, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Mutex, OnceLock};

use block2::RcBlock;
use objc2::rc::{Retained, autoreleasepool};
use objc2::runtime::{AnyObject, NSObject, ProtocolObject, Sel};
use objc2::{MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSImage, NSMenu, NSMenuItem, NSRunningApplication, NSStatusBar, NSStatusItem,
    NSVariableStatusItemLength, NSWorkspace, NSWorkspaceApplicationKey, NSWorkspaceDidActivateApplicationNotification,
    NSWorkspaceScreensDidSleepNotification, NSWorkspaceScreensDidWakeNotification, NSWorkspaceSessionDidBecomeActiveNotification,
    NSWorkspaceSessionDidResignActiveNotification, NSWorkspaceWillPowerOffNotification,
};
use objc2_foundation::{
    NSActivityOptions, NSBundle, NSDictionary, NSDistributedNotificationCenter, NSNotification, NSNumber, NSObjectProtocol, NSProcessInfo,
    NSRunLoop, NSRunLoopCommonModes, NSString, NSTimer, NSURL, ns_string,
};

use super::macos_rules::{PowerDedupe, identity, is_agent_path, pid_from_lock, power_source};
use crate::engine::{Fg, PowerEvt, SessionEvt};
use crate::model::Ms;
use crate::runner::{Control, Raw, Sys};

/// Set by SIGTERM, SIGINT, logout or shutdown, and the menu's Quit.
pub static STOP: AtomicBool = AtomicBool::new(false);
/// Signals lost because the agent loop was behind (the channel was full).
pub static DROPPED: AtomicU64 = AtomicU64::new(0);
/// Bumped by the agent loop each time it has recorded a suspend; the sleep callback waits for it.
pub static SUSPEND_ACK: AtomicU64 = AtomicU64::new(0);
/// The front app's pid, kept by the main thread; read by `current_foreground`. Atomic, so a lost signal never
/// loses the latest value.
static FRONT_PID: AtomicI32 = AtomicI32::new(0);
static SENDER: OnceLock<SyncSender<Raw>> = OnceLock::new();
/// pid -> identity, filled on the main thread when an app comes to the front, so an app that quits a moment
/// later is still named rather than recorded as a refused lookup. Bounded.
static IDENTITIES: Mutex<Option<HashMap<i32, Fg>>> = Mutex::new(None);
/// The lock state last sent to the engine: -1 not yet known, 0 unlocked, 1 locked.
static LAST_LOCKED: AtomicI8 = AtomicI8::new(-1);
/// 0 recording, 1 paused, 2 degraded, 3 not recording (an error); shown in the menu bar.
static UI_STATE: AtomicU32 = AtomicU32::new(0);
static UI_ERROR: Mutex<Option<String>> = Mutex::new(None);
static DATA_DIR: OnceLock<std::path::PathBuf> = OnceLock::new();
/// The agent thread's result, once it has ended: `Some(Ok)` after a clean stop.
static AGENT_DONE: Mutex<Option<Result<(), String>>> = Mutex::new(None);

/// Hand a signal to the agent loop; `false` (and a count in `DROPPED`) when the loop is behind.
fn send(raw: Raw) -> bool {
    match SENDER.get().map(|tx| tx.try_send(raw)) {
        Some(Ok(())) => true,
        _ => {
            DROPPED.fetch_add(1, Ordering::Relaxed);
            false
        }
    }
}

// ---- CoreGraphics, CoreFoundation and IOKit: a few C calls, declared here rather than pulled in as crates.

type CFTypeRef = *const c_void;
type CFRunLoopRef = *mut c_void;
type CFRunLoopSourceRef = *mut c_void;
type IONotificationPortRef = *mut c_void;
type IoObject = u32;
type IoConnect = u32;

const K_CG_EVENT_SOURCE_STATE_HID_SYSTEM_STATE: i32 = 1;
const K_CG_ANY_INPUT_EVENT_TYPE: u32 = !0;
const K_IO_MESSAGE_CAN_SYSTEM_SLEEP: u32 = 0xE000_0270;
const K_IO_MESSAGE_SYSTEM_WILL_SLEEP: u32 = 0xE000_0280;
const K_IO_MESSAGE_SYSTEM_HAS_POWERED_ON: u32 = 0xE000_0300;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    fn CGSessionCopyCurrentDictionary() -> CFTypeRef;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(cf: CFTypeRef);
    fn CFRunLoopGetMain() -> CFRunLoopRef;
    fn CFRunLoopAddSource(rl: CFRunLoopRef, source: CFRunLoopSourceRef, mode: CFTypeRef);
    // Common modes include menu tracking, so sleep and power are still handled while the menu is open.
    static kCFRunLoopCommonModes: CFTypeRef;
}

#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    fn IOPSCopyPowerSourcesInfo() -> CFTypeRef;
    fn IOPSGetProvidingPowerSourceType(snapshot: CFTypeRef) -> CFTypeRef;
    fn IOPSNotificationCreateRunLoopSource(callback: extern "C" fn(*mut c_void), context: *mut c_void) -> CFRunLoopSourceRef;
    fn IORegisterForSystemPower(
        refcon: *mut c_void,
        port: *mut IONotificationPortRef,
        callback: extern "C" fn(*mut c_void, IoObject, u32, *mut c_void),
        notifier: *mut IoObject,
    ) -> IoConnect;
    fn IONotificationPortGetRunLoopSource(port: IONotificationPortRef) -> CFRunLoopSourceRef;
    fn IOAllowPowerChange(kernel_port: IoConnect, notification_id: isize) -> i32;
}

#[link(name = "c")]
unsafe extern "C" {
    fn proc_pidpath(pid: i32, buffer: *mut c_void, size: u32) -> i32;
}

/// The current power source, read now.
fn read_power_source() -> Option<PowerEvt> {
    unsafe {
        let snapshot = IOPSCopyPowerSourcesInfo();
        if snapshot.is_null() {
            return None;
        }
        let kind = IOPSGetProvidingPowerSourceType(snapshot);
        // A CFString is toll-free bridged to NSString; it belongs to the snapshot, so it is read before release.
        let text = (!kind.is_null()).then(|| (*(kind as *const NSString)).to_string());
        CFRelease(snapshot);
        text.as_deref().and_then(power_source)
    }
}

static POWER_DEDUPE: Mutex<PowerDedupe> = Mutex::new(PowerDedupe::new());

extern "C" fn power_source_changed(_ctx: *mut c_void) {
    let now = read_power_source();
    if let Some(evt) = POWER_DEDUPE.lock().map(|mut d| d.changed(now)).unwrap_or(None)
        && !send(Raw::Power(evt))
    {
        // Not delivered: forget it, so the next reading (wake, or the next change) sends it again.
        if let Ok(mut d) = POWER_DEDUPE.lock() {
            *d = PowerDedupe::new();
        }
    }
}

static ROOT_PORT: AtomicU32 = AtomicU32::new(0);

/// System sleep and wake. Before sleep the system waits (up to about 30 s) for this callback to allow it, so
/// the suspend is recorded before the machine stops, not guessed afterwards.
extern "C" fn system_power(_refcon: *mut c_void, _service: IoObject, message: u32, argument: *mut c_void) {
    let port = ROOT_PORT.load(Ordering::SeqCst);
    match message {
        K_IO_MESSAGE_CAN_SYSTEM_SLEEP => unsafe {
            IOAllowPowerChange(port, argument as isize);
        },
        K_IO_MESSAGE_SYSTEM_WILL_SLEEP => {
            let before = SUSPEND_ACK.load(Ordering::SeqCst);
            send(Raw::Power(PowerEvt::Suspend));
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            while SUSPEND_ACK.load(Ordering::SeqCst) == before && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            unsafe {
                IOAllowPowerChange(port, argument as isize);
            }
        }
        K_IO_MESSAGE_SYSTEM_HAS_POWERED_ON => {
            send(Raw::Power(PowerEvt::Resume));
            // A change of power source or lock while asleep may not have been announced.
            power_source_changed(std::ptr::null_mut());
            resync_session();
        }
        _ => {}
    }
}

/// Main thread: an app came to the front. The agent's own process never counts (it never activates itself,
/// but a click on its menu must not end the real app's interval either).
fn front_changed(pid: i32) {
    if pid <= 0 || pid == std::process::id() as i32 {
        return;
    }
    remember(pid);
    FRONT_PID.store(pid, Ordering::SeqCst);
    send(Raw::Foreground(pid as usize));
}

// ---- The OS seam the runner uses.

pub struct MacSys;

fn resolve_pid(pid: i32) -> Fg {
    if let Some(fg) = IDENTITIES.lock().ok().and_then(|m| m.as_ref().and_then(|m| m.get(&pid).cloned()))
        && fg.exe.is_some()
    {
        return fg;
    }
    lookup_pid(pid)
}

fn remember(pid: i32) {
    let fg = lookup_pid(pid);
    if let Ok(mut m) = IDENTITIES.lock() {
        let m = m.get_or_insert_with(HashMap::new);
        if m.len() > 512 {
            m.clear();
        }
        m.insert(pid, fg);
    }
}

fn lookup_pid(pid: i32) -> Fg {
    autoreleasepool(|_| {
        let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid);
        let bundle = app.as_ref().and_then(|a| a.bundleIdentifier()).map(|s| s.to_string());
        let exe = app
            .as_ref()
            .and_then(|a| a.executableURL())
            .and_then(|u| u.path())
            .map(|s| s.to_string());
        // The category the app declares in its own Info.plist; most App Store apps and many others set one.
        let declared = app
            .as_ref()
            .and_then(|a| a.bundleURL())
            .and_then(|u| NSBundle::bundleWithURL(&u))
            .and_then(|b| b.objectForInfoDictionaryKey(ns_string!("LSApplicationCategoryType")))
            .and_then(|v| v.downcast::<NSString>().ok())
            .map(|s| s.to_string())
            .filter(|s| !s.trim().is_empty());
        Fg {
            class: String::new(),
            exe: identity(bundle.as_deref(), exe.as_deref()),
            declared,
        }
    })
}

impl Sys for MacSys {
    fn now_ms(&self) -> Ms {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as Ms)
            .unwrap_or(0)
    }

    fn mono_ms(&self) -> Ms {
        // `Instant` is mach_absolute_time on macOS, which stops while the machine sleeps. The meter's stall limit
        // and its wall-versus-monotonic check discard a slot either way.
        static START: OnceLock<std::time::Instant> = OnceLock::new();
        START.get_or_init(std::time::Instant::now).elapsed().as_millis() as Ms
    }

    fn idle_ms(&self) -> Option<u64> {
        let secs = unsafe { CGEventSourceSecondsSinceLastEventType(K_CG_EVENT_SOURCE_STATE_HID_SYSTEM_STATE, K_CG_ANY_INPUT_EVENT_TYPE) };
        (secs.is_finite() && secs >= 0.0).then_some((secs * 1000.0) as u64)
    }

    fn resolve(&self, pid: usize) -> Fg {
        resolve_pid(pid as i32)
    }

    fn current_foreground(&self) -> Option<Fg> {
        let pid = FRONT_PID.load(Ordering::SeqCst);
        (pid > 0).then(|| resolve_pid(pid))
    }

    fn proc_stats(&self) -> (i64, i64) {
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        let cpu = if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) } == 0 {
            let ms = |t: libc::timeval| t.tv_sec * 1000 + i64::from(t.tv_usec) / 1000;
            ms(usage.ru_utime) + ms(usage.ru_stime)
        } else {
            0
        };
        let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_taskinfo>() as i32;
        let got = unsafe {
            libc::proc_pidinfo(
                std::process::id() as i32,
                libc::PROC_PIDTASKINFO,
                0,
                (&mut info as *mut libc::proc_taskinfo).cast(),
                size,
            )
        };
        let rss = if got == size { info.pti_resident_size as i64 } else { 0 };
        (cpu, rss)
    }

    fn session_state(&self) -> (Option<bool>, bool) {
        session_state()
    }
}

/// Tell the engine the screen is locked or not, only when that changes.
fn set_locked(locked: bool) {
    let v = i8::from(locked);
    if LAST_LOCKED.swap(v, Ordering::SeqCst) != v && !send(Raw::Session(if locked { SessionEvt::Lock } else { SessionEvt::Unlock })) {
        // Not delivered: mark it unknown, so the 5 s check sends it again.
        LAST_LOCKED.store(-1, Ordering::SeqCst);
    }
}

/// After an unlock or a user switching back, unlock only if the session dictionary agrees that this user is
/// on the screen and it is not locked; a lock notification is believed as it is.
fn resync_session() {
    if let Some(locked) = locked_now() {
        set_locked(locked);
    }
}

/// (locked, remote) now, from the window server's session dictionary; locked is `None` if it would not say.
/// A session that is not on the console (another user switched in) counts as locked: this user's screen is
/// gone. There is no remote session on macOS in the Windows sense, so remote is always false.
pub fn session_state() -> (Option<bool>, bool) {
    (locked_now(), false)
}

fn locked_now() -> Option<bool> {
    autoreleasepool(|_| unsafe {
        let dict = CGSessionCopyCurrentDictionary();
        if dict.is_null() {
            return None;
        }
        let d = &*(dict as *const NSDictionary<NSString, AnyObject>);
        let flag = |key: &NSString| {
            d.objectForKey(key)
                .and_then(|v| v.downcast::<NSNumber>().ok())
                .map(|n| n.boolValue())
        };
        let locked = flag(ns_string!("CGSSessionScreenIsLocked")).unwrap_or(false);
        let on_console = flag(ns_string!("kCGSSessionOnConsoleKey")).unwrap_or(true);
        CFRelease(dict);
        Some(locked || !on_console)
    })
}

/// Minutes east of UTC at a UTC instant, from the system's zone rules.
fn offset_at(utc: Ms) -> i32 {
    let t: libc::time_t = utc.div_euclid(1000) as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // `localtime_r` does not re-read the zone; without this a change of time zone mid-run (travel) is missed.
    unsafe extern "C" {
        fn tzset();
    }
    unsafe { tzset() };
    if unsafe { libc::localtime_r(&t, &mut tm) }.is_null() {
        return 0;
    }
    (tm.tm_gmtoff / 60) as i32
}

pub fn local_tz() -> crate::tz::TzOffset {
    crate::tz::TzOffset::from_fn(offset_at)
}

/// Only this user may read the data folder.
pub fn restrict_dir(dir: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())
}

pub fn is_root() -> bool {
    unsafe { libc::geteuid() == 0 }
}

/// Write this process's id into the held `run.lock`, so `stop` can find it.
pub fn write_pid(lock: &mut std::fs::File) -> Result<(), String> {
    use std::io::{Seek, Write};
    lock.set_len(0).map_err(|e| e.to_string())?;
    lock.seek(std::io::SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    write!(lock, "{}", std::process::id()).map_err(|e| e.to_string())?;
    lock.flush().map_err(|e| e.to_string())
}

fn path_of(pid: i32) -> Option<String> {
    let mut buf = vec![0u8; 4096];
    let n = unsafe { proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    buf.truncate(n as usize);
    String::from_utf8(buf).ok()
}

/// `rhen-watch stop`: SIGTERM to the agent whose pid is in `run.lock`, only if that pid is a rhen-watch binary.
pub fn signal_stop(dir: &std::path::Path) -> Result<i32, String> {
    let text = std::fs::read_to_string(dir.join("run.lock")).unwrap_or_default();
    let Some(pid) = pid_from_lock(&text) else {
        return Err("no running agent found (run.lock has no process id)".into());
    };
    if !crate::cli::agent_running(dir) {
        return Err("no running agent found".into());
    }
    match path_of(pid) {
        Some(p) if is_agent_path(&p) => {}
        Some(p) => return Err(format!("process {pid} is {p}, not rhen-watch; refusing to signal it")),
        None => return Err(format!("process {pid} is not running or is not yours")),
    }
    if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
        return Err(format!("could not signal process {pid}: {}", std::io::Error::last_os_error()));
    }
    Ok(pid)
}

extern "C" fn on_terminate(_sig: libc::c_int) {
    STOP.store(true, Ordering::SeqCst);
}

/// A closed pipe ends a reporting command silently (the default Unix behaviour Rust turns off).
pub fn default_sigpipe() {
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
}

/// SIGTERM (launchd at logout, `stop`) and SIGINT (Ctrl+C) end the agent cleanly.
pub fn install_signal_handlers() {
    unsafe {
        libc::signal(libc::SIGTERM, on_terminate as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, on_terminate as *const () as libc::sighandler_t);
    }
}

pub fn set_state(state: &str) {
    let code = match state {
        "paused" => 1,
        "degraded" => 2,
        _ => 0,
    };
    UI_STATE.store(code, Ordering::SeqCst);
}

// ---- The menu bar item.

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "RhenWatchMenuTarget"]
    #[ivars = ()]
    struct MenuTarget;

    impl MenuTarget {
        #[unsafe(method(toggle:))]
        fn toggle(&self, _sender: Option<&AnyObject>) {
            let paused = UI_STATE.load(Ordering::SeqCst) == 1;
            send(Raw::Control(if paused { Control::Resume } else { Control::Pause }));
            // Lock changes while paused are not recorded, so after a pause or resume the 5 s check tells the
            // engine the lock state again.
            LAST_LOCKED.store(-1, Ordering::SeqCst);
        }

        #[unsafe(method(openFolder:))]
        fn open_folder(&self, _sender: Option<&AnyObject>) {
            // Opens our own data folder in Finder, because the person asked; no other app is touched.
            if let Some(dir) = DATA_DIR.get() {
                let url = NSURL::fileURLWithPath(&NSString::from_str(&dir.to_string_lossy()));
                NSWorkspace::sharedWorkspace().openURL(&url);
            }
        }

        #[unsafe(method(quit:))]
        fn quit(&self, _sender: Option<&AnyObject>) {
            STOP.store(true, Ordering::SeqCst);
            if AGENT_DONE.lock().map(|d| d.is_some()).unwrap_or(false) {
                std::process::exit(0);
            }
        }
    }
);

impl MenuTarget {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

struct Ui {
    item: Retained<NSStatusItem>,
    status: Retained<NSMenuItem>,
    toggle: Retained<NSMenuItem>,
    shown: Option<(u32, Option<String>)>,
}

fn menu_item(mtm: MainThreadMarker, title: &str, action: Option<Sel>, target: Option<&MenuTarget>) -> Retained<NSMenuItem> {
    let item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(NSMenuItem::alloc(mtm), &NSString::from_str(title), action, ns_string!(""))
    };
    if let Some(t) = target {
        unsafe { item.setTarget(Some(t)) };
    }
    item.setEnabled(action.is_some());
    item
}

fn build_ui(mtm: MainThreadMarker, target: &MenuTarget) -> Result<Ui, String> {
    use crate::tray::{ID_FOLDER, ID_QUIT, ID_TOGGLE};
    let item = NSStatusBar::systemStatusBar().statusItemWithLength(NSVariableStatusItemLength);
    let menu = NSMenu::new(mtm);
    menu.setAutoenablesItems(false);
    let status = menu_item(mtm, "rhen-watch: starting", None, None);
    let toggle = menu_item(mtm, "Pause", Some(sel!(toggle:)), Some(target));
    toggle.setTag(ID_TOGGLE as isize);
    let folder = menu_item(mtm, "Open data folder", Some(sel!(openFolder:)), Some(target));
    folder.setTag(ID_FOLDER as isize);
    let quit = menu_item(mtm, "Quit rhen-watch", Some(sel!(quit:)), Some(target));
    quit.setTag(ID_QUIT as isize);
    menu.addItem(&status);
    menu.addItem(&NSMenuItem::separatorItem(mtm));
    menu.addItem(&toggle);
    menu.addItem(&folder);
    menu.addItem(&NSMenuItem::separatorItem(mtm));
    menu.addItem(&quit);
    item.setMenu(Some(&menu));
    if item.button(mtm).is_none() {
        return Err("the menu bar item could not be created".into());
    }
    let mut ui = Ui {
        item,
        status,
        toggle,
        shown: None,
    };
    refresh_ui(mtm, &mut ui);
    Ok(ui)
}

fn refresh_ui(mtm: MainThreadMarker, ui: &mut Ui) {
    let state = UI_STATE.load(Ordering::SeqCst);
    let error = UI_ERROR.lock().ok().and_then(|e| e.clone());
    let key = (state, error.clone());
    if ui.shown.as_ref() == Some(&key) {
        return;
    }
    let (symbol, line) = match (state, &error) {
        (3, Some(e)) => ("exclamationmark.triangle", format!("Not recording: {e}")),
        (1, _) => ("pause.circle", "rhen-watch: paused".to_string()),
        (2, _) => (
            "exclamationmark.triangle",
            "rhen-watch: recording, but writes are failing".to_string(),
        ),
        _ => ("record.circle", "rhen-watch: recording".to_string()),
    };
    if let Some(button) = ui.item.button(mtm) {
        let image =
            NSImage::imageWithSystemSymbolName_accessibilityDescription(&NSString::from_str(symbol), Some(&NSString::from_str(&line)));
        if let Some(img) = &image {
            img.setTemplate(true);
        }
        button.setImage(image.as_deref());
        if image.is_none() {
            button.setTitle(ns_string!("rw"));
        }
        button.setToolTip(Some(&NSString::from_str(&line)));
    }
    ui.status.setTitle(&NSString::from_str(&line));
    ui.toggle
        .setTitle(if state == 1 { ns_string!("Resume") } else { ns_string!("Pause") });
    ui.toggle.setEnabled(state != 3);
    ui.shown = Some(key);
}

/// The agent loop's result; when it failed without a stop being asked for, the menu bar shows why and the app
/// stays until Quit, so a failure is never silent.
pub fn agent_finished(result: Result<(), String>) {
    if let Err(e) = &result {
        if let Ok(mut slot) = UI_ERROR.lock() {
            *slot = Some(e.clone());
        }
        UI_STATE.store(3, Ordering::SeqCst);
    }
    if let Ok(mut slot) = AGENT_DONE.lock() {
        *slot = Some(result);
    }
}

fn observe(
    center: &objc2_foundation::NSNotificationCenter,
    name: &NSString,
    f: impl Fn(&NSNotification) + 'static,
) -> Retained<ProtocolObject<dyn NSObjectProtocol>> {
    let block = RcBlock::new(move |n: NonNull<NSNotification>| f(unsafe { n.as_ref() }));
    unsafe { center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block) }
}

/// Which collectors to register; the same switches as `config.toml`.
pub struct Wanted {
    pub foreground: bool,
    pub session: bool,
    pub power: bool,
}

/// Runs the app on the main thread with the menu bar item and the observers, and `agent` on its own thread.
/// Returns when the agent has stopped cleanly; when it failed, the error stays on the menu bar until Quit if
/// `stay_on_error`, else it is returned.
pub fn run_app(
    tx: SyncSender<Raw>,
    data_dir: &std::path::Path,
    wanted: Wanted,
    stay_on_error: bool,
    agent: impl FnOnce(Vec<String>) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("rhen-watch must run on the main thread")?;
    let _ = SENDER.set(tx);
    let _ = DATA_DIR.set(data_dir.to_path_buf());
    let app = NSApplication::sharedApplication(mtm);
    // An accessory app: no Dock icon, no menu of its own, and it never makes itself the active app.
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    // Without this, App Nap could delay the once-a-second tick by minutes and the engine would read a stall.
    let _activity = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
        NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
        ns_string!("recording activity"),
    );
    let target = MenuTarget::new(mtm);
    let ui = std::cell::RefCell::new(build_ui(mtm, &target)?);
    let mut missing = Vec::new();
    let mut observers = Vec::new();
    let workspace = NSWorkspace::sharedWorkspace();
    let center = workspace.notificationCenter();
    if wanted.foreground {
        if let Some(front) = workspace.frontmostApplication() {
            let pid = front.processIdentifier();
            remember(pid);
            FRONT_PID.store(pid, Ordering::SeqCst);
        }
        observers.push(observe(&center, unsafe { NSWorkspaceDidActivateApplicationNotification }, |n| {
            let app = n
                .userInfo()
                .and_then(|info| info.objectForKey(unsafe { NSWorkspaceApplicationKey }))
                .and_then(|a| a.downcast::<NSRunningApplication>().ok());
            if let Some(app) = app {
                front_changed(app.processIdentifier());
            }
        }));
    }
    observers.push(observe(&center, unsafe { NSWorkspaceWillPowerOffNotification }, |_| {
        STOP.store(true, Ordering::SeqCst);
    }));
    if wanted.session {
        let distributed = NSDistributedNotificationCenter::defaultCenter();
        // Lock and fast user switching share one state: this user's screen is gone. The notifications are
        // undocumented but long-standing; the session dictionary is re-read every 5 s as well, so a missed one
        // heals within seconds.
        if locked_now() == Some(true) {
            set_locked(true);
        } else if locked_now() == Some(false) {
            LAST_LOCKED.store(0, Ordering::SeqCst);
        }
        observers.push(observe(&distributed, ns_string!("com.apple.screenIsLocked"), |_| set_locked(true)));
        observers.push(observe(&distributed, ns_string!("com.apple.screenIsUnlocked"), |_| {
            resync_session()
        }));
        observers.push(observe(&center, unsafe { NSWorkspaceSessionDidResignActiveNotification }, |_| {
            set_locked(true)
        }));
        observers.push(observe(&center, unsafe { NSWorkspaceSessionDidBecomeActiveNotification }, |_| {
            resync_session()
        }));
    }
    if wanted.power {
        observers.push(observe(&center, unsafe { NSWorkspaceScreensDidSleepNotification }, |_| {
            send(Raw::Power(PowerEvt::DisplayOff));
        }));
        observers.push(observe(&center, unsafe { NSWorkspaceScreensDidWakeNotification }, |_| {
            send(Raw::Power(PowerEvt::DisplayOn));
        }));
        unsafe {
            let source = IOPSNotificationCreateRunLoopSource(power_source_changed, std::ptr::null_mut());
            if source.is_null() {
                missing.push("power source".to_string());
            } else {
                CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
            }
            let mut port: IONotificationPortRef = std::ptr::null_mut();
            let mut notifier: IoObject = 0;
            let root = IORegisterForSystemPower(std::ptr::null_mut(), &mut port, system_power, &mut notifier);
            if root == 0 || port.is_null() {
                missing.push("sleep and wake".to_string());
            } else {
                ROOT_PORT.store(root, Ordering::SeqCst);
                CFRunLoopAddSource(CFRunLoopGetMain(), IONotificationPortGetRunLoopSource(port), kCFRunLoopCommonModes);
            }
        }
        // The value at start, so a day starts with a known power source.
        power_source_changed(std::ptr::null_mut());
    }

    let worker = std::thread::Builder::new()
        .name("rhen-watch agent".into())
        .spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| agent(missing)))
                .unwrap_or_else(|_| Err("internal error (panic)".into()));
            agent_finished(result);
        })
        .map_err(|e| e.to_string())?;
    let worker = std::cell::RefCell::new(Some(worker));

    // Twice a second on the main thread: show the state, and end the app once the agent has finished.
    let ticks = std::cell::Cell::new(0u32);
    let last_read = std::cell::Cell::new(None::<bool>);
    let session = wanted.session;
    let foreground = wanted.foreground;
    let timer_block = RcBlock::new(move |_t: NonNull<NSTimer>| {
        let mtm = MainThreadMarker::new().expect("timers run on the main thread");
        refresh_ui(mtm, &mut ui.borrow_mut());
        ticks.set(ticks.get().wrapping_add(1));
        if ticks.get().is_multiple_of(10) {
            // Every 5 s: heal a missed notification. The lock state must read the same twice in a row before it
            // overrides what the notifications said, so a dictionary that lags a notification cannot flap it.
            if session {
                let now = locked_now();
                if now.is_some() && now == last_read.get() {
                    set_locked(now == Some(true));
                }
                last_read.set(now);
            }
            if foreground && let Some(front) = NSWorkspace::sharedWorkspace().frontmostApplication() {
                let pid = front.processIdentifier();
                if pid != FRONT_PID.load(Ordering::SeqCst) {
                    front_changed(pid);
                }
            }
        }
        let done = AGENT_DONE.lock().ok().and_then(|d| d.clone());
        match done {
            Some(Ok(())) => {
                if let Some(w) = worker.borrow_mut().take() {
                    let _ = w.join();
                }
                std::process::exit(0);
            }
            // Asked to stop while showing an error: that is a clean exit, so launchd does not restart it.
            Some(Err(_)) if STOP.load(Ordering::SeqCst) => std::process::exit(0),
            Some(Err(e)) if !stay_on_error => {
                if let Some(w) = worker.borrow_mut().take() {
                    let _ = w.join();
                }
                crate::log::error(&e);
                std::process::exit(1);
            }
            _ => {}
        }
    });
    // In the common modes, so it keeps running (stop, the 5 s checks) while the menu is open.
    let timer = unsafe { NSTimer::timerWithTimeInterval_repeats_block(0.5, true, &timer_block) };
    unsafe { NSRunLoop::mainRunLoop().addTimer_forMode(&timer, NSRunLoopCommonModes) };
    app.run();
    drop(observers);
    Ok(())
}
