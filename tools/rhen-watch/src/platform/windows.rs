//! The Windows layer. Everything here only reads. It registers one foreground WinEvent hook and a hidden
//! top-level window for session and power messages, on one thread with a message loop. The callbacks do
//! no work beyond sending a small value down a bounded channel; a full channel counts a drop, which the
//! runner turns into an `unknown` marker.
//!
//! These calls are written from the Win32 documentation and checked by compiling on windows-latest in CI;
//! their behaviour is confirmed by the manual run in `tools/rhen-watch/README.md`.

#![allow(clippy::missing_safety_doc)]

use std::ptr::{null, null_mut};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::SyncSender;
use std::thread::JoinHandle;

use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::System::Console::*;
use windows_sys::Win32::System::Diagnostics::ToolHelp::*;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Power::*;
use windows_sys::Win32::System::ProcessStatus::*;
use windows_sys::Win32::System::Registry::*;
use windows_sys::Win32::System::RemoteDesktop::*;
use windows_sys::Win32::System::SystemInformation::*;
use windows_sys::Win32::System::Threading::*;
use windows_sys::Win32::System::Time::*;
use windows_sys::Win32::UI::Accessibility::*;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
use windows_sys::Win32::UI::Shell::{NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY, NOTIFYICONDATAW, Shell_NotifyIconW};
use windows_sys::Win32::UI::WindowsAndMessaging::*;
use windows_sys::core::{BOOL, GUID};

use crate::engine::{Fg, PowerEvt, SessionEvt};
use crate::model::Ms;
use crate::runner::{Control, Raw, Sys};
use crate::tray::{ID_FOLDER, ID_QUIT, ID_SETTINGS, ID_STATUS, ID_TOGGLE, TrayAction, action_for};

/// Keeps helper programs from flashing a console when the no-console build starts them.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub static STOP: AtomicBool = AtomicBool::new(false);
/// Set by `main` once open intervals are closed and flushed; the console handler and WM_ENDSESSION wait for it.
pub static STOPPED: AtomicBool = AtomicBool::new(false);

fn wait_for_clean_stop() {
    // Windows ends the process when these handlers return, or after about five seconds.
    for _ in 0..80 {
        if STOPPED.load(Ordering::SeqCst) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}
pub static DROPPED: AtomicU64 = AtomicU64::new(0);
const GUID_CONSOLE_DISPLAY_STATE: GUID = GUID {
    data1: 0x6fe69556,
    data2: 0x704a,
    data3: 0x47a0,
    data4: [0x8f, 0x24, 0xc2, 0x8d, 0x93, 0x6f, 0xda, 0x47],
};
const GUID_ACDC_POWER_SOURCE: GUID = GUID {
    data1: 0x5d3e9a59,
    data2: 0xe9d5,
    data3: 0x4b00,
    data4: [0xa6, 0xbd, 0xff, 0x34, 0xff, 0x51, 0x65, 0x48],
};
static SENDER: OnceLock<SyncSender<Raw>> = OnceLock::new();

const STOP_EVENT_NAME: &str = "Local\\rhen-watch-stop";

fn guid_eq(a: &GUID, b: &GUID) -> bool {
    a.data1 == b.data1 && a.data2 == b.data2 && a.data3 == b.data3 && a.data4 == b.data4
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn send(raw: Raw) {
    if let Some(tx) = SENDER.get()
        && tx.try_send(raw).is_err()
    {
        DROPPED.fetch_add(1, Ordering::Relaxed);
    }
}

// ---- Sys implementation ----

pub struct WinSys;

impl WinSys {
    fn pid_of(hwnd: HWND) -> u32 {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        pid
    }

    fn class_of(hwnd: HWND) -> String {
        let mut buf = [0u16; 256];
        let n = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    /// Executable file name of a process id from a process snapshot. No handle is opened on the target
    /// process, which matters for anti-cheat protected games.
    fn exe_of(pid: u32) -> Option<String> {
        if pid == 0 {
            return None;
        }
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return None;
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut found = None;
            let mut ok = Process32FirstW(snap, &mut entry);
            while ok != 0 {
                if entry.th32ProcessID == pid {
                    let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                    found = Some(String::from_utf16_lossy(&entry.szExeFile[..len]).to_ascii_lowercase());
                    break;
                }
                ok = Process32NextW(snap, &mut entry);
            }
            CloseHandle(snap);
            found
        }
    }

    /// For a UWP frame window, the pid of the real app's child window, when it has appeared.
    fn uwp_child_pid(hwnd: HWND, host_pid: u32) -> Option<u32> {
        unsafe extern "system" fn each(child: HWND, lparam: LPARAM) -> BOOL {
            let (host, out) = unsafe { &mut *(lparam as *mut (u32, Option<u32>)) };
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(child, &mut pid) };
            if pid != 0 && pid != *host {
                *out = Some(pid);
                return 0;
            }
            1
        }
        let mut state: (u32, Option<u32>) = (host_pid, None);
        unsafe { EnumChildWindows(hwnd, Some(each), &mut state as *mut _ as LPARAM) };
        state.1
    }
}

impl Sys for WinSys {
    fn now_ms(&self) -> Ms {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as Ms)
            .unwrap_or(0)
    }

    fn mono_ms(&self) -> Ms {
        // `Instant` is QueryPerformanceCounter on Windows. Whether it counts time asleep is checked once on a
        // real machine (README checklist); the meter does not depend on it, because its stall limit and its
        // wall-versus-monotonic check discard a slot either way.
        static START: OnceLock<std::time::Instant> = OnceLock::new();
        START.get_or_init(std::time::Instant::now).elapsed().as_millis() as Ms
    }

    fn idle_ms(&self) -> Option<u64> {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if unsafe { GetLastInputInfo(&mut info) } == 0 {
            return None;
        }
        // Both counters are 32-bit and wrap every 49.7 days; the wrapping difference is still right.
        let tick = unsafe { GetTickCount() };
        Some(crate::activity::idle_from_ticks(tick, info.dwTime))
    }

    fn resolve(&self, hwnd: usize) -> Fg {
        let hwnd = hwnd as HWND;
        let class = Self::class_of(hwnd);
        let pid = Self::pid_of(hwnd);
        let mut exe = Self::exe_of(pid);
        if exe.as_deref() == Some("applicationframehost.exe") {
            let mut child = Self::uwp_child_pid(hwnd, pid);
            if child.is_none() {
                std::thread::sleep(std::time::Duration::from_millis(300));
                child = Self::uwp_child_pid(hwnd, pid);
            }
            if let Some(real) = child.and_then(Self::exe_of) {
                exe = Some(real);
            }
        }
        Fg { class, exe }
    }

    fn current_foreground(&self) -> Option<Fg> {
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_null() { None } else { Some(self.resolve(hwnd as usize)) }
    }

    fn proc_stats(&self) -> (i64, i64) {
        unsafe {
            let h = GetCurrentProcess();
            let (mut c, mut e, mut k, mut u) = (
                std::mem::zeroed::<FILETIME>(),
                std::mem::zeroed::<FILETIME>(),
                std::mem::zeroed::<FILETIME>(),
                std::mem::zeroed::<FILETIME>(),
            );
            let mut cpu = 0i64;
            if GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u) != 0 {
                let ticks = |f: &FILETIME| ((u64::from(f.dwHighDateTime) << 32) | u64::from(f.dwLowDateTime)) as i64;
                cpu = (ticks(&k) + ticks(&u)) / 10_000;
            }
            let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
            counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
            let rss = if K32GetProcessMemoryInfo(h, &mut counters, counters.cb) != 0 {
                counters.WorkingSetSize as i64
            } else {
                0
            };
            (cpu, rss)
        }
    }
}

// ---- tray icon ----
//
// The tray icon lives on the hook thread's hidden window, so it shares that thread's message loop. It is
// always shown while the agent runs: the recorder is never hidden.

const WM_TRAY: u32 = WM_APP + 1;
const WM_TRAY_REFRESH: u32 = WM_APP + 2;

static TRAY_HWND: AtomicIsize = AtomicIsize::new(0);
static TASKBAR_CREATED: AtomicU32 = AtomicU32::new(0);
static UI_STATE: AtomicU32 = AtomicU32::new(0);
static DATA_DIR: OnceLock<Vec<u16>> = OnceLock::new();

pub fn set_data_dir(dir: &std::path::Path) {
    let _ = DATA_DIR.set(wide(&dir.to_string_lossy()));
}

fn state_name(code: u32) -> &'static str {
    match code {
        1 => "paused",
        2 => "degraded (writes are failing)",
        _ => "recording",
    }
}

/// Tell the tray what the runner is doing: `recording`, `paused` or `degraded`.
pub fn set_state(state: &str) {
    let code = match state {
        "paused" => 1,
        "degraded" => 2,
        _ => 0,
    };
    if UI_STATE.swap(code, Ordering::SeqCst) != code {
        let hwnd = TRAY_HWND.load(Ordering::SeqCst);
        if hwnd != 0 {
            unsafe { PostMessageW(hwnd as HWND, WM_TRAY_REFRESH, 0, 0) };
        }
    }
}

fn tray_data(hwnd: HWND) -> NOTIFYICONDATAW {
    let mut nid: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
    nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
    nid.hWnd = hwnd;
    nid.uID = 1;
    nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
    nid.uCallbackMessage = WM_TRAY;
    nid.hIcon = unsafe { LoadIconW(null_mut(), IDI_APPLICATION) };
    let tip = wide(&format!("rhen-watch: {}", state_name(UI_STATE.load(Ordering::SeqCst))));
    for (slot, c) in nid.szTip.iter_mut().zip(tip.iter().take(127)) {
        *slot = *c;
    }
    nid
}

unsafe fn tray_add(hwnd: HWND) {
    let nid = tray_data(hwnd);
    unsafe { Shell_NotifyIconW(NIM_ADD, &nid) };
}

unsafe fn tray_update(hwnd: HWND) {
    let nid = tray_data(hwnd);
    unsafe { Shell_NotifyIconW(NIM_MODIFY, &nid) };
}

unsafe fn tray_remove(hwnd: HWND) {
    let nid = tray_data(hwnd);
    unsafe { Shell_NotifyIconW(NIM_DELETE, &nid) };
}

unsafe fn show_menu(hwnd: HWND) {
    unsafe {
        let menu = CreatePopupMenu();
        let state = UI_STATE.load(Ordering::SeqCst);
        AppendMenuW(
            menu,
            MF_STRING | MF_GRAYED,
            ID_STATUS,
            wide(&format!("rhen-watch: {}", state_name(state))).as_ptr(),
        );
        AppendMenuW(menu, MF_SEPARATOR, 0, null());
        let toggle = if state == 1 { "Resume recording" } else { "Pause recording" };
        AppendMenuW(menu, MF_STRING, ID_TOGGLE, wide(toggle).as_ptr());
        AppendMenuW(menu, MF_STRING, ID_SETTINGS, wide("Open settings").as_ptr());
        AppendMenuW(menu, MF_STRING, ID_FOLDER, wide("Open data folder").as_ptr());
        AppendMenuW(menu, MF_SEPARATOR, 0, null());
        AppendMenuW(menu, MF_STRING, ID_QUIT, wide("Quit").as_ptr());
        let mut pt = POINT { x: 0, y: 0 };
        GetCursorPos(&mut pt);
        // The menu only dismisses properly if its owner is foreground. The user just clicked our own icon.
        SetForegroundWindow(hwnd);
        let cmd = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, pt.x, pt.y, 0, hwnd, null()) as usize;
        PostMessageW(hwnd, WM_NULL, 0, 0);
        DestroyMenu(menu);
        match action_for(cmd) {
            TrayAction::TogglePause => {
                // A click must not be lost to a full queue, so this one waits for room.
                if let Some(tx) = SENDER.get() {
                    let _ = tx.send(Raw::Control(if state == 1 { Control::Resume } else { Control::Pause }));
                }
            }
            TrayAction::OpenDataFolder => {
                // Settings (config.toml, categories.toml) live in the data folder. explorer.exe needs no COM
                // setup on this thread, unlike ShellExecute.
                if let Some(dir) = DATA_DIR.get() {
                    let path = String::from_utf16_lossy(&dir[..dir.len().saturating_sub(1)]);
                    let _ = std::process::Command::new("explorer.exe")
                        .arg(path)
                        .stdin(std::process::Stdio::null())
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .spawn();
                }
            }
            TrayAction::Quit => STOP.store(true, Ordering::SeqCst),
            TrayAction::None => {}
        }
    }
}

// ---- hook thread ----

unsafe extern "system" fn foreground_cb(
    _hook: HWINEVENTHOOK,
    _event: u32,
    hwnd: HWND,
    id_object: i32,
    _id_child: i32,
    _thread: u32,
    _time: u32,
) {
    if id_object == OBJID_WINDOW && !hwnd.is_null() {
        send(Raw::Foreground(hwnd as usize));
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // Explorer restarted: the tray is empty again, so put the icon back.
    if msg != 0 && msg == TASKBAR_CREATED.load(Ordering::Relaxed) {
        unsafe { tray_add(hwnd) };
        return 0;
    }
    match msg {
        WM_TRAY => {
            let event = (lparam as u32) & 0xffff;
            if event == WM_RBUTTONUP || event == WM_LBUTTONUP || event == WM_CONTEXTMENU {
                unsafe { show_menu(hwnd) };
            }
            0
        }
        WM_TRAY_REFRESH => {
            unsafe { tray_update(hwnd) };
            0
        }
        WM_WTSSESSION_CHANGE => {
            let evt = match wparam as u32 {
                WTS_SESSION_LOCK => Some(SessionEvt::Lock),
                WTS_SESSION_UNLOCK => Some(SessionEvt::Unlock),
                WTS_SESSION_LOGON => Some(SessionEvt::Logon),
                WTS_SESSION_LOGOFF => Some(SessionEvt::Logoff),
                WTS_REMOTE_CONNECT => Some(SessionEvt::RemoteConnect),
                WTS_REMOTE_DISCONNECT => Some(SessionEvt::RemoteDisconnect),
                _ => None,
            };
            if let Some(e) = evt {
                send(Raw::Session(e));
            }
            0
        }
        WM_POWERBROADCAST => {
            match wparam as u32 {
                PBT_APMSUSPEND => send(Raw::Power(PowerEvt::Suspend)),
                PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND => send(Raw::Power(PowerEvt::Resume)),
                PBT_POWERSETTINGCHANGE => {
                    let setting = unsafe { &*(lparam as *const POWERBROADCAST_SETTING) };
                    if setting.DataLength >= 4 {
                        let value = unsafe { std::ptr::read_unaligned(setting.Data.as_ptr() as *const u32) };
                        if guid_eq(&setting.PowerSetting, &GUID_CONSOLE_DISPLAY_STATE) {
                            send(Raw::Power(if value == 0 { PowerEvt::DisplayOff } else { PowerEvt::DisplayOn }));
                        } else if guid_eq(&setting.PowerSetting, &GUID_ACDC_POWER_SOURCE) {
                            send(Raw::Power(if value == 1 { PowerEvt::Battery } else { PowerEvt::Ac }));
                        }
                    }
                }
                _ => {}
            }
            1
        }
        WM_QUERYENDSESSION => 1,
        WM_ENDSESSION => {
            if wparam != 0 {
                STOP.store(true, Ordering::SeqCst);
                wait_for_clean_stop();
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

pub struct Hooks {
    thread_id: u32,
    join: Option<JoinHandle<()>>,
}

impl Hooks {
    /// Start the hook thread. Returns once the hook and window exist (or failed).
    /// Also returns the collectors whose registration failed, so the caller can record them as degraded.
    pub fn start(tx: SyncSender<Raw>, foreground: bool, session: bool, power: bool) -> Result<(Self, Vec<String>), String> {
        let _ = SENDER.set(tx);
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(u32, Vec<String>), String>>();
        let join = std::thread::Builder::new()
            .name("rhen-watch-hooks".into())
            .spawn(move || unsafe { hook_thread(foreground, session, power, ready_tx) })
            .map_err(|e| e.to_string())?;
        match ready_rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(Ok((thread_id, missing))) => Ok((
                Self {
                    thread_id,
                    join: Some(join),
                },
                missing,
            )),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("the hook thread did not start".into()),
        }
    }

    pub fn stop(&mut self) {
        unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0) };
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

unsafe fn hook_thread(foreground: bool, session: bool, power: bool, ready: std::sync::mpsc::Sender<Result<(u32, Vec<String>), String>>) {
    unsafe {
        let hinst = GetModuleHandleW(null());
        let class_name = wide("rhen-watch-hidden");
        let class = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: hinst,
            lpszClassName: class_name.as_ptr(),
            ..std::mem::zeroed()
        };
        if RegisterClassW(&class) == 0 {
            let _ = ready.send(Err("RegisterClassW failed".into()));
            return;
        }
        // A hidden top-level window (not message-only): suspend and resume are not delivered to message-only windows.
        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            wide("rhen-watch").as_ptr(),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            null_mut(),
            null_mut(),
            hinst,
            null(),
        );
        if hwnd.is_null() {
            let _ = ready.send(Err("CreateWindowExW failed".into()));
            return;
        }
        TRAY_HWND.store(hwnd as isize, Ordering::SeqCst);
        TASKBAR_CREATED.store(RegisterWindowMessageW(wide("TaskbarCreated").as_ptr()), Ordering::SeqCst);
        tray_add(hwnd);
        let mut hook = null_mut();
        if foreground {
            hook = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                null_mut(),
                Some(foreground_cb),
                0,
                0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            );
            if hook.is_null() {
                let _ = ready.send(Err("SetWinEventHook failed".into()));
                return;
            }
        }
        let mut missing: Vec<String> = Vec::new();
        let mut session_registered = false;
        if session {
            session_registered = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) != 0;
            if !session_registered {
                missing.push("session".into());
            }
        }
        let mut regs: Vec<(bool, isize)> = Vec::new();
        if power {
            for guid in [&GUID_CONSOLE_DISPLAY_STATE, &GUID_ACDC_POWER_SOURCE] {
                let r = RegisterPowerSettingNotification(hwnd as HANDLE, guid, DEVICE_NOTIFY_WINDOW_HANDLE);
                if r != 0 {
                    regs.push((false, r));
                } else {
                    missing.push("power".into());
                }
            }
            let r = RegisterSuspendResumeNotification(hwnd as HANDLE, DEVICE_NOTIFY_WINDOW_HANDLE);
            if r != 0 {
                regs.push((true, r));
            } else {
                missing.push("suspend-resume".into());
            }
        }
        let _ = ready.send(Ok((GetCurrentThreadId(), missing)));

        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        for (suspend, r) in regs {
            if suspend {
                UnregisterSuspendResumeNotification(r);
            } else {
                UnregisterPowerSettingNotification(r);
            }
        }
        if session_registered {
            WTSUnRegisterSessionNotification(hwnd);
        }
        if !hook.is_null() {
            UnhookWinEvent(hook);
        }
        tray_remove(hwnd);
        TRAY_HWND.store(0, Ordering::SeqCst);
        DestroyWindow(hwnd);
    }
}

// ---- process-level helpers ----

unsafe extern "system" fn ctrl_handler(kind: u32) -> BOOL {
    match kind {
        CTRL_C_EVENT | CTRL_BREAK_EVENT => {
            STOP.store(true, Ordering::SeqCst);
            1
        }
        CTRL_CLOSE_EVENT | CTRL_LOGOFF_EVENT | CTRL_SHUTDOWN_EVENT => {
            STOP.store(true, Ordering::SeqCst);
            wait_for_clean_stop();
            1
        }
        _ => 0,
    }
}

pub fn install_ctrl_handler() {
    unsafe { SetConsoleCtrlHandler(Some(ctrl_handler), 1) };
}

pub fn in_session_zero() -> bool {
    let mut session = 0u32;
    unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session) != 0 && session == 0 }
}

pub struct StopEvent(HANDLE);

impl StopEvent {
    /// Create the event `rhen-watch stop` signals. Default security: only the creating user can open it.
    pub fn create() -> Result<Self, String> {
        let h = unsafe { CreateEventW(null(), 1, 0, wide(STOP_EVENT_NAME).as_ptr()) };
        if h.is_null() {
            Err("could not create the stop event".into())
        } else {
            Ok(Self(h))
        }
    }

    pub fn signalled(&self) -> bool {
        unsafe { WaitForSingleObject(self.0, 0) == WAIT_OBJECT_0 }
    }
}

impl Drop for StopEvent {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

/// Ask a running agent in this logon session to stop. Returns false if none is running.
pub fn signal_stop() -> bool {
    unsafe {
        let h = OpenEventW(EVENT_MODIFY_STATE, 0, wide(STOP_EVENT_NAME).as_ptr());
        if h.is_null() {
            return false;
        }
        let ok = SetEvent(h) != 0;
        CloseHandle(h);
        ok
    }
}

/// Minutes east of UTC right now.
pub fn local_offset_minutes() -> i32 {
    unsafe {
        let mut tz: TIME_ZONE_INFORMATION = std::mem::zeroed();
        let id = GetTimeZoneInformation(&mut tz);
        let bias = tz.Bias + if id == 2 { tz.DaylightBias } else { tz.StandardBias };
        -bias
    }
}

/// Minutes east of UTC at a UTC instant, by the user's time zone rules (so a day in the other DST regime
/// gets its own offset). Falls back to the offset now if the conversion fails.
fn offset_at(utc: Ms) -> i32 {
    // FILETIME counts 100 ns ticks since 1601-01-01.
    let ticks = ((utc + 11_644_473_600_000).max(0) as u64) * 10_000;
    let ft = FILETIME {
        dwLowDateTime: ticks as u32,
        dwHighDateTime: (ticks >> 32) as u32,
    };
    unsafe {
        let mut utc_st: SYSTEMTIME = std::mem::zeroed();
        let mut local_st: SYSTEMTIME = std::mem::zeroed();
        if FileTimeToSystemTime(&ft, &mut utc_st) == 0 || SystemTimeToTzSpecificLocalTime(null(), &utc_st, &mut local_st) == 0 {
            return local_offset_minutes();
        }
        let minutes = |s: &SYSTEMTIME| {
            crate::cli::days_from_civil(i64::from(s.wYear), i64::from(s.wMonth), i64::from(s.wDay)) * 1440
                + i64::from(s.wHour) * 60
                + i64::from(s.wMinute)
        };
        (minutes(&local_st) - minutes(&utc_st)) as i32
    }
}

/// The user's time zone as a function of the instant.
pub fn local_tz() -> crate::tz::TzOffset {
    crate::tz::TzOffset::from_fn(offset_at)
}

/// The current user's SID string, from `whoami /user`.
fn current_sid() -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("whoami")
        .args(["/user", "/fo", "csv", "/nh"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("whoami: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.split(',')
        .nth(1)
        .map(|v| v.trim().trim_matches('"').to_string())
        .filter(|v| v.starts_with("S-1-"))
        .ok_or_else(|| "could not read the current user's SID".to_string())
}

/// Remove inherited permissions from the data directory so only the current user can read it. The grant
/// is by SID, so a domain or Microsoft-account name cannot resolve to the wrong principal.
pub fn restrict_dir(dir: &std::path::Path) -> Result<(), String> {
    let sid = current_sid()?;
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("icacls")
        .creation_flags(CREATE_NO_WINDOW)
        .arg(dir)
        .args(["/inheritance:r", "/grant:r"])
        .arg(format!("*{sid}:(OI)(CI)F"))
        .output()
        .map_err(|e| format!("icacls: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("icacls failed: {}", String::from_utf8_lossy(&out.stdout)))
    }
}

// ---- restart on crash: the per-user Scheduled Task ----

/// Run `schtasks.exe` with no window. Returns its exit code and its combined output.
fn schtasks(args: &[String]) -> Result<(i32, String), String> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new(system32_exe("schtasks.exe"))
        .creation_flags(CREATE_NO_WINDOW)
        .args(args)
        .output()
        .map_err(|e| format!("schtasks: {e}"))?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok((out.status.code().unwrap_or(-1), text))
}

/// Register (or replace) one task for the current user. Needs no admin rights.
fn register_one(name: &str, kind: crate::restart::TaskKind, command: &std::path::Path) -> Result<(), String> {
    let sid = current_sid()?;
    let xml = crate::restart::task_xml(&sid, &command.to_string_lossy(), kind);
    let file = std::env::temp_dir().join(format!("rhen-watch-task-{}-{name}.xml", std::process::id()));
    std::fs::write(&file, crate::restart::task_file_bytes(&xml)).map_err(|e| format!("cannot write the task file: {e}"))?;
    let result = schtasks(&crate::restart::create_args(name, &file.to_string_lossy()));
    let _ = std::fs::remove_file(&file);
    match result? {
        (0, _) => Ok(()),
        (code, text) => Err(crate::restart::create_failure(code, &text)),
    }
}

/// Register (or replace) both tasks: the logon start and the keep-alive. If the second fails the first is removed,
/// so there is never half of the pair.
pub fn register_task(command: &std::path::Path) -> Result<(), String> {
    use crate::restart::{KEEPALIVE_TASK_NAME, TASK_NAME, TaskKind};
    register_one(TASK_NAME, TaskKind::Logon, command)?;
    if let Err(e) = register_one(KEEPALIVE_TASK_NAME, TaskKind::Keepalive, command) {
        let _ = delete_task();
        return Err(e);
    }
    Ok(())
}

/// Start the registered task now (the agent it launches is the one the task will restart).
pub fn run_task() -> Result<(), String> {
    match schtasks(&crate::restart::run_args())? {
        (0, _) => Ok(()),
        (code, text) => Err(format!("schtasks /Run failed (exit {code}): {}", text.trim())),
    }
}

/// True when both tasks are registered.
pub fn task_present() -> bool {
    use crate::restart::{KEEPALIVE_TASK_NAME, TASK_NAME};
    [TASK_NAME, KEEPALIVE_TASK_NAME]
        .iter()
        .all(|n| matches!(schtasks(&crate::restart::query_args(n)), Ok((0, _))))
}

/// Remove both tasks. Neither being registered is not an error.
pub fn delete_task() -> Result<(), String> {
    use crate::restart::{KEEPALIVE_TASK_NAME, TASK_NAME};
    let mut first_error = None;
    for name in [TASK_NAME, KEEPALIVE_TASK_NAME] {
        let (code, _) = schtasks(&crate::restart::delete_args(name))?;
        let after = if code == 0 {
            None
        } else {
            schtasks(&crate::restart::query_args(name)).ok().map(|(c, _)| c)
        };
        if let Err(e) = crate::restart::classify_delete(code, after) {
            first_error.get_or_insert(e);
        }
    }
    first_error.map_or(Ok(()), Err)
}

// ---- start at logon ----

const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE: &str = "rhen-watch";

/// Make `command` run when this user logs on (HKCU Run: no admin rights, visible in Task Manager's Startup tab).
pub fn set_autostart(command: &str) -> Result<(), String> {
    unsafe {
        let mut key: HKEY = null_mut();
        let rc = RegCreateKeyExW(
            HKEY_CURRENT_USER,
            wide(RUN_KEY).as_ptr(),
            0,
            null(),
            0,
            KEY_SET_VALUE,
            null(),
            &mut key,
            null_mut(),
        );
        if rc != 0 {
            return Err(format!("could not open the Run key (error {rc})"));
        }
        let value = wide(command);
        let rc = RegSetValueExW(
            key,
            wide(RUN_VALUE).as_ptr(),
            0,
            REG_SZ,
            value.as_ptr() as *const u8,
            (value.len() * 2) as u32,
        );
        RegCloseKey(key);
        if rc != 0 {
            Err(format!("could not write the Run value (error {rc})"))
        } else {
            Ok(())
        }
    }
}

/// Remove start-at-logon. Not being set is not an error.
pub fn clear_autostart() -> Result<(), String> {
    unsafe {
        let mut key: HKEY = null_mut();
        if RegOpenKeyExW(HKEY_CURRENT_USER, wide(RUN_KEY).as_ptr(), 0, KEY_SET_VALUE, &mut key) != 0 {
            return Ok(());
        }
        let rc = RegDeleteValueW(key, wide(RUN_VALUE).as_ptr());
        RegCloseKey(key);
        // ERROR_FILE_NOT_FOUND (2): it was never set.
        if rc == 0 || rc == 2 {
            Ok(())
        } else {
            Err(format!("could not remove the Run value (error {rc})"))
        }
    }
}

/// Stop this process's console handles from being inherited by a child it starts.
///
/// Rust starts every child with handle inheritance on, so a long-lived agent started by `install` would
/// otherwise keep a copy of whatever stdout and stderr `install` was given. When a script captures
/// `install`'s output through a pipe, that copy holds the pipe open and the script waits for ever.
pub fn stop_std_handle_inheritance() {
    for id in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        // SAFETY: GetStdHandle has no preconditions; SetHandleInformation only changes a flag on a
        // handle this process owns, and a null or invalid handle makes it fail harmlessly.
        unsafe {
            let h = GetStdHandle(id);
            if !h.is_null() && h != INVALID_HANDLE_VALUE {
                SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

/// Full path under System32: a bare name would search the user-writable program folder first.
fn system32_exe(name: &str) -> std::path::PathBuf {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    std::path::Path::new(&root).join("System32").join(name)
}
