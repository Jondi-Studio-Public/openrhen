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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::SyncSender;
use std::thread::JoinHandle;

use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::System::Console::*;
use windows_sys::Win32::System::Diagnostics::ToolHelp::*;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Power::*;
use windows_sys::Win32::System::ProcessStatus::*;
use windows_sys::Win32::System::RemoteDesktop::*;
use windows_sys::Win32::System::SystemInformation::*;
use windows_sys::Win32::System::Threading::*;
use windows_sys::Win32::System::Time::*;
use windows_sys::Win32::UI::Accessibility::*;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
use windows_sys::Win32::UI::WindowsAndMessaging::*;
use windows_sys::core::{BOOL, GUID};

use crate::engine::{Fg, PowerEvt, SessionEvt};
use crate::model::Ms;
use crate::runner::{Raw, Sys};

pub static STOP: AtomicBool = AtomicBool::new(false);
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
        Some(u64::from(tick.wrapping_sub(info.dwTime)))
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
    match msg {
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
            STOP.store(true, Ordering::SeqCst);
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
    pub fn start(tx: SyncSender<Raw>, foreground: bool, session: bool, power: bool) -> Result<Self, String> {
        let _ = SENDER.set(tx);
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<u32, String>>();
        let join = std::thread::Builder::new()
            .name("rhen-watch-hooks".into())
            .spawn(move || unsafe { hook_thread(foreground, session, power, ready_tx) })
            .map_err(|e| e.to_string())?;
        match ready_rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(Ok(thread_id)) => Ok(Self {
                thread_id,
                join: Some(join),
            }),
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

unsafe fn hook_thread(foreground: bool, session: bool, power: bool, ready: std::sync::mpsc::Sender<Result<u32, String>>) {
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
        if session {
            WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
        }
        let mut regs: Vec<(bool, isize)> = Vec::new();
        if power {
            for guid in [&GUID_CONSOLE_DISPLAY_STATE, &GUID_ACDC_POWER_SOURCE] {
                let r = RegisterPowerSettingNotification(hwnd as HANDLE, guid, DEVICE_NOTIFY_WINDOW_HANDLE);
                if r != 0 {
                    regs.push((false, r));
                }
            }
            let r = RegisterSuspendResumeNotification(hwnd as HANDLE, DEVICE_NOTIFY_WINDOW_HANDLE);
            if r != 0 {
                regs.push((true, r));
            }
        }
        let _ = ready.send(Ok(GetCurrentThreadId()));

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
        if session {
            WTSUnRegisterSessionNotification(hwnd);
        }
        if !hook.is_null() {
            UnhookWinEvent(hook);
        }
        DestroyWindow(hwnd);
    }
}

// ---- process-level helpers ----

unsafe extern "system" fn ctrl_handler(kind: u32) -> BOOL {
    match kind {
        CTRL_C_EVENT | CTRL_BREAK_EVENT | CTRL_CLOSE_EVENT | CTRL_LOGOFF_EVENT | CTRL_SHUTDOWN_EVENT => {
            STOP.store(true, Ordering::SeqCst);
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

/// Remove inherited permissions from the data directory so only the current user can read it.
pub fn restrict_dir(dir: &std::path::Path) -> Result<(), String> {
    let user = std::env::var("USERNAME").map_err(|_| "USERNAME is not set".to_string())?;
    let out = std::process::Command::new("icacls")
        .arg(dir)
        .args(["/inheritance:r", "/grant:r"])
        .arg(format!("{user}:(OI)(CI)F"))
        .output()
        .map_err(|e| format!("icacls: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("icacls failed: {}", String::from_utf8_lossy(&out.stdout)))
    }
}
